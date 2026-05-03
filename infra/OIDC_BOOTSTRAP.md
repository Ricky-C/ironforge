# GitHub Actions OIDC Bootstrap

One-time, manual AWS CLI setup that creates the OIDC trust between GitHub Actions and the Ironforge AWS account, plus the two CI roles (`ironforge-ci-plan` and `ironforge-ci-apply`) the workflows assume. Runs after `BOOTSTRAP.md` (which creates the Terraform state infrastructure).

## What gets created

- **IAM OIDC provider** for `token.actions.githubusercontent.com`.
- **`IronforgeCIPermissionBoundary`** managed policy — attached to both CI roles. Acts as a hard cap: even if the role's identity policy or trust is somehow widened, the boundary keeps the role from modifying itself, the OIDC provider, the boundary itself, or any of the cost-runaway services.
- **`ironforge-ci-plan` role** — assumed by workflows running in `pull_request` context. Read-only across Ironforge's resource ARN patterns, plus state-lock writes on `ironforge-terraform-locks` and state object reads on the state bucket.
- **`ironforge-ci-apply` role** — assumed by workflows running in `environment:production` context. Read + state-machinery + write across Ironforge's resource ARN patterns. Same boundary attached.
- **GitHub Environment `production`** with required reviewer + 5-minute wait timer.
- **GitHub repository secrets** wiring it all together.

## Why two roles

The split is the load-bearing security primitive. A workflow running in pull_request context (potentially from a forked PR, with arbitrary changes to workflow YAML) cannot assume the apply role — its OIDC token's `sub` claim never matches the apply role's trust condition. The apply role is reachable only when the workflow explicitly opts into the `production` environment, which itself is gated by the manual-approval + wait-timer in repo settings.

## Prerequisites

- AWS CLI v2 with an admin profile for the Ironforge account.
- `BOOTSTRAP.md` completed (Terraform state bucket, lock table, and state CMK exist).
- The repo `Ricky-C/ironforge` exists on GitHub.
- `jq` installed (for parsing CLI output during verification).

Set environment variables for the session:

```bash
export AWS_PROFILE=<your-admin-profile>
export AWS_REGION=us-east-1
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export GITHUB_REPO="Ricky-C/ironforge"
export STATE_KMS_KEY_ARN=$(aws kms describe-key \
  --key-id alias/ironforge-terraform-state \
  --query 'KeyMetadata.Arn' --output text)
```

`STATE_KMS_KEY_ARN` is the CMK created in `BOOTSTRAP.md`. Both CI roles' identity policies scope `kms:Decrypt`/`Encrypt`/`GenerateDataKey` to this exact ARN — see Steps 3 and 4. The earlier pattern of using `kms:ResourceAliases` as a condition was dropped because that condition key is multivalued and requires a `ForAnyValue`/`ForAllValues` set operator to evaluate reliably; using the resolved ARN directly is simpler and unambiguous.

Verify the right account:

```bash
aws sts get-caller-identity --query Account --output text
# Should match AWS_ACCOUNT_ID.
```

## Step 1 — Create the OIDC provider

GitHub Actions OIDC tokens are signed by `token.actions.githubusercontent.com`. AWS needs the provider registered.

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 \
  --tags Key=ironforge-managed,Value=true \
         Key=ironforge-component,Value=ci-oidc \
         Key=ironforge-environment,Value=shared
```

Note: AWS no longer strictly validates the thumbprint for the well-known GitHub OIDC issuer (since 2023), but the field is still required by the API. The value above is one of the historical GitHub OIDC root cert thumbprints.

## Step 2 — Create the permission boundary

The boundary caps both CI roles. It allows broadly (so each role's identity policy is the actual grant), and explicitly DENYs the operations that would let a CI role compromise the rest of the account.

```bash
cat > /tmp/ironforge-ci-boundary.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowEverythingByDefault",
      "Effect": "Allow",
      "Action": "*",
      "Resource": "*"
    },
    {
      "Sid": "DenyModifyingTheOIDCProvider",
      "Effect": "Deny",
      "Action": [
        "iam:DeleteOpenIDConnectProvider",
        "iam:UpdateOpenIDConnectProviderThumbprint",
        "iam:RemoveClientIDFromOpenIDConnectProvider",
        "iam:AddClientIDToOpenIDConnectProvider"
      ],
      "Resource": "*"
    },
    {
      "Sid": "DenyModifyingTheCIRolesThemselves",
      "Effect": "Deny",
      "Action": [
        "iam:DeleteRole",
        "iam:UpdateRole",
        "iam:UpdateAssumeRolePolicy",
        "iam:PutRolePermissionsBoundary",
        "iam:DeleteRolePermissionsBoundary",
        "iam:PutRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:TagRole",
        "iam:UntagRole"
      ],
      "Resource": [
        "arn:aws:iam::${AWS_ACCOUNT_ID}:role/ironforge-ci-plan",
        "arn:aws:iam::${AWS_ACCOUNT_ID}:role/ironforge-ci-apply"
      ]
    },
    {
      "Sid": "DenyModifyingTheBoundaryItself",
      "Effect": "Deny",
      "Action": [
        "iam:DeletePolicy",
        "iam:DeletePolicyVersion",
        "iam:CreatePolicyVersion",
        "iam:SetDefaultPolicyVersion"
      ],
      "Resource": "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/IronforgeCIPermissionBoundary"
    },
    {
      "Sid": "DenyExpensiveServicesPermanently",
      "Effect": "Deny",
      "Action": [
        "ec2:*",
        "rds:*",
        "redshift:*",
        "elasticache:*",
        "es:*",
        "opensearch:*",
        "sagemaker:*",
        "emr:*",
        "eks:*",
        "ecs:*",
        "kafka:*",
        "memorydb:*",
        "qldb:*",
        "documentdb:*"
      ],
      "Resource": "*"
    }
  ]
}
EOF

aws iam create-policy \
  --policy-name IronforgeCIPermissionBoundary \
  --description "Permission boundary attached to ironforge-ci-plan and ironforge-ci-apply. Caps what either role can ever do, even if its identity policy is widened or its trust is compromised." \
  --policy-document file:///tmp/ironforge-ci-boundary.json \
  --tags Key=ironforge-managed,Value=true \
         Key=ironforge-component,Value=ci-oidc \
         Key=ironforge-environment,Value=shared
```

## Step 3 — Create `ironforge-ci-plan`

Trust policy: scoped to `pull_request` context only. `StringEquals` (not `StringLike`) on the sub claim — exact match.

```bash
cat > /tmp/ironforge-ci-plan-trust.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::${AWS_ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:${GITHUB_REPO}:pull_request"
      }
    }
  }]
}
EOF

aws iam create-role \
  --role-name ironforge-ci-plan \
  --assume-role-policy-document file:///tmp/ironforge-ci-plan-trust.json \
  --permissions-boundary "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/IronforgeCIPermissionBoundary" \
  --tags Key=ironforge-managed,Value=true \
         Key=ironforge-component,Value=ci-oidc \
         Key=ironforge-environment,Value=shared
```

Plan role identity policy: read-only across Ironforge resources + state-lock + state CMK access.

> **`ReadAllForPlanDiff` action design.** Each `<service>:` group in the read sid
> below follows one of three patterns. When extending the policy, pick the
> pattern that matches — and audit each new service's `Get*` members for
> high-blast-radius actions before reaching for the wildcard.
>
> 1. **Full triplet (`Describe*` + `Get*` + `List*`)** — used when the service
>    spreads its read APIs across all three verbs AND `<service>:Get*` has no
>    high-blast-radius members. Examples: `acm`, `cognito-idp`, `kms`,
>    `cloudwatch`, `logs`, `cloudtrail`, `ssm`.
> 2. **`Describe*` + `List*` only (no `Get*`)** — used when `<service>:Get*`
>    includes a high-blast-radius action that Terraform refresh doesn't need.
>    Examples: `dynamodb` (omits `Get*` to exclude `GetItem` / item-content
>    read), `secretsmanager` (omits `Get*` to exclude `GetSecretValue` /
>    secret-content read). The Terraform AWS provider's refresh path for
>    these resources reaches everything it needs via `Describe*` + `List*`.
> 3. **Specific `Get*` actions enumerated individually** — used when refresh
>    needs a single safe `Get*` action and the broader `<service>:Get*` is
>    unsafe. Example: `secretsmanager:GetResourcePolicy` is enumerated
>    explicitly so the role doesn't gain `GetSecretValue`. Terraform's
>    `aws_secretsmanager_secret` Read function calls `GetResourcePolicy` to
>    populate the resource's `policy` attribute.
>
> Services that use `Get*` exclusively and have no `Describe*` (e.g.
> `cloudfront`, `sns`, `scheduler`, `iam`, `route53`, `xray`) appear with
> `Get*` + `List*` only — that is not pattern 2; it's pattern 1 with a
> two-verb API surface.

```bash
cat > /tmp/ironforge-ci-plan-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TerraformStateRead",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:ListBucket",
        "s3:GetBucketVersioning"
      ],
      "Resource": [
        "arn:aws:s3:::ironforge-terraform-state-*",
        "arn:aws:s3:::ironforge-terraform-state-*/*"
      ]
    },
    {
      "Sid": "TerraformStateLock",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:DeleteItem"
      ],
      "Resource": "arn:aws:dynamodb:${AWS_REGION}:${AWS_ACCOUNT_ID}:table/ironforge-terraform-locks"
    },
    {
      "Sid": "TerraformStateKMS",
      "Effect": "Allow",
      "Action": [
        "kms:Decrypt",
        "kms:GenerateDataKey",
        "kms:Encrypt",
        "kms:DescribeKey"
      ],
      "Resource": "${STATE_KMS_KEY_ARN}"
    },
    {
      "Sid": "ReadAllForPlanDiff",
      "Effect": "Allow",
      "Action": [
        "s3:Get*",
        "s3:List*",
        "dynamodb:Describe*",
        "dynamodb:List*",
        "lambda:Get*",
        "lambda:List*",
        "cloudfront:Get*",
        "cloudfront:List*",
        "acm:Describe*",
        "acm:List*",
        "acm:Get*",
        "cognito-idp:Describe*",
        "cognito-idp:List*",
        "cognito-idp:Get*",
        "kms:Describe*",
        "kms:List*",
        "kms:Get*",
        "sns:Get*",
        "sns:List*",
        "ce:Get*",
        "ce:Describe*",
        "ce:List*",
        "budgets:Describe*",
        "budgets:List*",
        "budgets:View*",
        "cloudwatch:Describe*",
        "cloudwatch:Get*",
        "cloudwatch:List*",
        "logs:Describe*",
        "logs:Get*",
        "logs:List*",
        "cloudtrail:Describe*",
        "cloudtrail:Get*",
        "cloudtrail:List*",
        "cloudtrail:LookupEvents",
        "states:Describe*",
        "states:List*",
        "secretsmanager:Describe*",
        "secretsmanager:GetResourcePolicy",
        "secretsmanager:List*",
        "ssm:Describe*",
        "ssm:Get*",
        "ssm:List*",
        "wafv2:Get*",
        "wafv2:List*",
        "wafv2:Describe*",
        "apigateway:GET",
        "events:Describe*",
        "events:List*",
        "scheduler:Get*",
        "scheduler:List*",
        "iam:Get*",
        "iam:List*",
        "route53:Get*",
        "route53:List*",
        "xray:Get*",
        "xray:List*",
        "ecr:Describe*",
        "ecr:Get*",
        "ecr:List*",
        "ecr:BatchGet*",
        "ecr:BatchCheck*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "EcrImagePushIronforge",
      "Effect": "Allow",
      "Action": [
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage"
      ],
      "Resource": "arn:aws:ecr:${AWS_REGION}:${AWS_ACCOUNT_ID}:repository/ironforge-*"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name ironforge-ci-plan \
  --policy-name ironforge-ci-plan-permissions \
  --policy-document file:///tmp/ironforge-ci-plan-policy.json
```

> **Why the plan role pushes images.** The plan workflow runs
> `infra/modules/terraform-lambda-image/build-image.sh` BEFORE
> `terraform plan` because the dev composition reads the pushed image
> digest URI via a `data "local_file"` data source — terraform plan
> fails if `.image-uri` doesn't exist, even if the plan would not
> deploy a new image. `EcrImagePushIronforge` grants the four layer/
> image-write actions scoped to `repository/ironforge-*`. Read-side
> ECR actions (DescribeRepositories, DescribeImages,
> GetAuthorizationToken, etc.) live in `ReadAllForPlanDiff` since
> they're idiomatic Read shapes. This is a deliberate expansion of
> the plan role's blast radius (it can now push to ECR repos in the
> ironforge-* namespace) — captured as a tech-debt entry to revisit
> via a content-addressed image-tag scheme that pre-computes the
> digest without push, decoupling plan from image push.

## Step 4 — Create `ironforge-ci-apply`

Trust policy: scoped to `environment:production` only. The OIDC token sub claim takes the `environment:` form when the workflow uses an environment, regardless of the underlying push/ref.

```bash
cat > /tmp/ironforge-ci-apply-trust.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::${AWS_ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:${GITHUB_REPO}:environment:production"
      }
    }
  }]
}
EOF

aws iam create-role \
  --role-name ironforge-ci-apply \
  --assume-role-policy-document file:///tmp/ironforge-ci-apply-trust.json \
  --permissions-boundary "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/IronforgeCIPermissionBoundary" \
  --tags Key=ironforge-managed,Value=true \
         Key=ironforge-component,Value=ci-oidc \
         Key=ironforge-environment,Value=shared
```

Apply role identity policy: write access scoped to Ironforge resource ARN patterns. Mostly `<service>:*` on `arn:aws:<service>:...:ironforge-*`.

```bash
cat > /tmp/ironforge-ci-apply-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "TerraformStateAccess",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketVersioning"
      ],
      "Resource": [
        "arn:aws:s3:::ironforge-terraform-state-*",
        "arn:aws:s3:::ironforge-terraform-state-*/*"
      ]
    },
    {
      "Sid": "TerraformStateLock",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:DeleteItem"
      ],
      "Resource": "arn:aws:dynamodb:${AWS_REGION}:${AWS_ACCOUNT_ID}:table/ironforge-terraform-locks"
    },
    {
      "Sid": "TerraformStateKMS",
      "Effect": "Allow",
      "Action": [
        "kms:Decrypt",
        "kms:GenerateDataKey",
        "kms:Encrypt",
        "kms:DescribeKey"
      ],
      "Resource": "${STATE_KMS_KEY_ARN}"
    },
    {
      "Sid": "ReadAllForPlanDiff",
      "Effect": "Allow",
      "Action": [
        "s3:Get*", "s3:List*",
        "dynamodb:Describe*", "dynamodb:List*",
        "lambda:Get*", "lambda:List*",
        "cloudfront:Get*", "cloudfront:List*",
        "acm:Describe*", "acm:List*", "acm:Get*",
        "cognito-idp:Describe*", "cognito-idp:List*", "cognito-idp:Get*",
        "kms:Describe*", "kms:List*", "kms:Get*",
        "sns:Get*", "sns:List*",
        "ce:Get*", "ce:Describe*", "ce:List*",
        "budgets:Describe*", "budgets:List*", "budgets:View*",
        "cloudwatch:Describe*", "cloudwatch:Get*", "cloudwatch:List*",
        "logs:Describe*", "logs:Get*", "logs:List*",
        "cloudtrail:Describe*", "cloudtrail:Get*", "cloudtrail:List*", "cloudtrail:LookupEvents",
        "states:Describe*", "states:List*",
        "secretsmanager:Describe*", "secretsmanager:List*",
        "ssm:Describe*", "ssm:Get*", "ssm:List*",
        "wafv2:Get*", "wafv2:List*", "wafv2:Describe*",
        "apigateway:GET",
        "events:Describe*", "events:List*",
        "scheduler:Get*", "scheduler:List*",
        "iam:Get*", "iam:List*",
        "route53:Get*", "route53:List*",
        "xray:Get*", "xray:List*",
        "ecr:Describe*", "ecr:Get*", "ecr:List*",
        "ecr:BatchGet*", "ecr:BatchCheck*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "WriteIronforgeS3",
      "Effect": "Allow",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::ironforge-*",
        "arn:aws:s3:::ironforge-*/*"
      ]
    },
    {
      "Sid": "WriteIronforgeDynamoDB",
      "Effect": "Allow",
      "Action": "dynamodb:*",
      "Resource": [
        "arn:aws:dynamodb:${AWS_REGION}:${AWS_ACCOUNT_ID}:table/ironforge-*",
        "arn:aws:dynamodb:${AWS_REGION}:${AWS_ACCOUNT_ID}:table/ironforge-*/*"
      ]
    },
    {
      "Sid": "WriteIronforgeLambda",
      "Effect": "Allow",
      "Action": "lambda:*",
      "Resource": [
        "arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:function:ironforge-*",
        "arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:layer:ironforge-*",
        "arn:aws:lambda:${AWS_REGION}:${AWS_ACCOUNT_ID}:layer:ironforge-*:*"
      ]
    },
    {
      "Sid": "WriteIronforgeIAM",
      "Effect": "Allow",
      "Action": "iam:*",
      "Resource": [
        "arn:aws:iam::${AWS_ACCOUNT_ID}:role/ironforge-*",
        "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/Ironforge*"
      ]
    },
    {
      "Sid": "PassRoleForIronforgeServices",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::${AWS_ACCOUNT_ID}:role/ironforge-*"
    },
    {
      "Sid": "WriteIronforgeLogs",
      "Effect": "Allow",
      "Action": "logs:*",
      "Resource": [
        "arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:/aws/lambda/ironforge-*",
        "arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:/aws/lambda/ironforge-*:*",
        "arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:/aws/apigateway/ironforge-*",
        "arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:/aws/apigateway/ironforge-*:*",
        "arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:/aws/states/ironforge-*",
        "arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:/aws/states/ironforge-*:*",
        "arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:/aws/vendedlogs/states/ironforge-*",
        "arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:/aws/vendedlogs/states/ironforge-*:*",
        "arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:/aws/cloudtrail/ironforge*",
        "arn:aws:logs:${AWS_REGION}:${AWS_ACCOUNT_ID}:log-group:/aws/cloudtrail/ironforge*:*"
      ]
    },
    {
      "Sid": "LogDeliveryAccountWide",
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogDelivery",
        "logs:GetLogDelivery",
        "logs:UpdateLogDelivery",
        "logs:DeleteLogDelivery",
        "logs:ListLogDeliveries",
        "logs:PutResourcePolicy",
        "logs:DescribeResourcePolicies",
        "logs:DescribeLogGroups"
      ],
      "Resource": "*"
    },
    {
      "Sid": "WriteIronforgeCloudTrail",
      "Effect": "Allow",
      "Action": "cloudtrail:*",
      "Resource": "arn:aws:cloudtrail:${AWS_REGION}:${AWS_ACCOUNT_ID}:trail/ironforge-*"
    },
    {
      "Sid": "WriteIronforgeSNS",
      "Effect": "Allow",
      "Action": "sns:*",
      "Resource": "arn:aws:sns:${AWS_REGION}:${AWS_ACCOUNT_ID}:ironforge-*"
    },
    {
      "Sid": "WriteIronforgeStateMachines",
      "Effect": "Allow",
      "Action": "states:*",
      "Resource": [
        "arn:aws:states:${AWS_REGION}:${AWS_ACCOUNT_ID}:stateMachine:ironforge-*",
        "arn:aws:states:${AWS_REGION}:${AWS_ACCOUNT_ID}:execution:ironforge-*:*"
      ]
    },
    {
      "Sid": "ValidateStateMachineDefinitionAccountWide",
      "Effect": "Allow",
      "Action": "states:ValidateStateMachineDefinition",
      "Resource": "*"
    },
    {
      "Sid": "WriteIronforgeSecrets",
      "Effect": "Allow",
      "Action": "secretsmanager:*",
      "Resource": "arn:aws:secretsmanager:${AWS_REGION}:${AWS_ACCOUNT_ID}:secret:ironforge/*"
    },
    {
      "Sid": "WriteIronforgeSSM",
      "Effect": "Allow",
      "Action": "ssm:*",
      "Resource": "arn:aws:ssm:${AWS_REGION}:${AWS_ACCOUNT_ID}:parameter/ironforge/*"
    },
    {
      "Sid": "KMSCreateKeyOnlyManaged",
      "Effect": "Allow",
      "Action": "kms:CreateKey",
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "aws:RequestTag/ironforge-managed": "true"
        }
      }
    },
    {
      "Sid": "KMSManageIronforgeManagedKeys",
      "Effect": "Allow",
      "Action": [
        "kms:PutKeyPolicy",
        "kms:UpdateKeyDescription",
        "kms:EnableKey",
        "kms:DisableKey",
        "kms:EnableKeyRotation",
        "kms:DisableKeyRotation",
        "kms:ScheduleKeyDeletion",
        "kms:CancelKeyDeletion",
        "kms:TagResource",
        "kms:CreateGrant",
        "kms:RetireGrant",
        "kms:Encrypt",
        "kms:Decrypt",
        "kms:ReEncrypt*",
        "kms:GenerateDataKey",
        "kms:GenerateDataKeyWithoutPlaintext"
      ],
      "Resource": "arn:aws:kms:${AWS_REGION}:${AWS_ACCOUNT_ID}:key/*",
      "Condition": {
        "StringEquals": {
          "aws:ResourceTag/ironforge-managed": "true"
        }
      }
    },
    {
      "Sid": "KMSUntagIronforgeManagedKeysExceptLoadBearing",
      "Effect": "Allow",
      "Action": "kms:UntagResource",
      "Resource": "arn:aws:kms:${AWS_REGION}:${AWS_ACCOUNT_ID}:key/*",
      "Condition": {
        "StringEquals": {
          "aws:ResourceTag/ironforge-managed": "true"
        },
        "ForAllValues:StringNotEquals": {
          "aws:TagKeys": ["ironforge-managed"]
        }
      }
    },
    {
      "Sid": "KMSManageIronforgeAliases",
      "Effect": "Allow",
      "Action": [
        "kms:CreateAlias",
        "kms:UpdateAlias",
        "kms:DeleteAlias"
      ],
      "Resource": [
        "arn:aws:kms:${AWS_REGION}:${AWS_ACCOUNT_ID}:alias/ironforge-*",
        "arn:aws:kms:${AWS_REGION}:${AWS_ACCOUNT_ID}:key/*"
      ]
    },
    {
      "Sid": "WriteAccountWideServicesIronforgeUses",
      "Effect": "Allow",
      "Action": [
        "cloudfront:*",
        "wafv2:*",
        "acm:*",
        "cognito-idp:*",
        "budgets:*",
        "ce:CreateAnomaly*",
        "ce:UpdateAnomaly*",
        "ce:DeleteAnomaly*",
        "ce:TagResource",
        "ce:UntagResource",
        "events:*",
        "apigateway:*",
        "scheduler:*",
        "xray:*"
      ],
      "Resource": "*"
    },
    {
      "Sid": "Route53IronforgeZoneWrite",
      "Effect": "Allow",
      "Action": [
        "route53:ChangeResourceRecordSets",
        "route53:ChangeTagsForResource",
        "route53:UpdateHostedZoneComment"
      ],
      "Resource": "arn:aws:route53:::hostedzone/*"
    },
    {
      "Sid": "Route53AccountWideReads",
      "Effect": "Allow",
      "Action": [
        "route53:GetChange"
      ],
      "Resource": "*"
    },
    {
      "Sid": "WriteIronforgeECR",
      "Effect": "Allow",
      "Action": "ecr:*",
      "Resource": "arn:aws:ecr:${AWS_REGION}:${AWS_ACCOUNT_ID}:repository/ironforge-*"
    }
  ]
}
EOF

aws iam put-role-policy \
  --role-name ironforge-ci-apply \
  --policy-name ironforge-ci-apply-permissions \
  --policy-document file:///tmp/ironforge-ci-apply-policy.json
```

Note on `cloudfront:*`, `wafv2:*`, `acm:*`, `cognito-idp:*`: these services either don't support resource-level scoping in IAM, or scoping by resource ARN is impractical at create-time. The boundary's DENY list keeps the cost-runaway services blocked regardless. Future tightening for these is tracked in `docs/tech-debt.md`.

Note on `ecr:*` (PR-C.6): `WriteIronforgeECR` scopes to `repository/ironforge-*` — the tightest pattern AWS supports for ECR resource-management actions. The image-push actions (`InitiateLayerUpload`, `UploadLayerPart`, `CompleteLayerUpload`, `PutImage`) are subsumed by `ecr:*` for the apply role; the plan role gets these as a separate `EcrImagePushIronforge` statement (since plan should NOT have `ecr:*` write surface). `ecr:GetAuthorizationToken` is account-scoped per AWS service authorization reference — falls into `ReadAllForPlanDiff`'s `ecr:Get*` glob with `Resource: "*"`. The plan role's expanded blast radius (it can now push to any ECR repo in `ironforge-*`) is captured as a tech-debt entry — content-addressed image tagging that pre-computes the digest without push would decouple plan from image push.

KMS got the tightening this round (the `KMS*` sids above). Structure: `kms:CreateKey` requires `aws:RequestTag/ironforge-managed=true` on the create call so every CMK the apply role can ever create carries the tag. Per-key write and grant actions (`kms:PutKeyPolicy`, `kms:ScheduleKeyDeletion`, `kms:CreateGrant`, `kms:RetireGrant`, etc.) are scoped to keys with `aws:ResourceTag/ironforge-managed=true`, which auto-includes any new ironforge-managed CMK without enumeration. `kms:CreateGrant`/`kms:RetireGrant` are required so Secrets Manager can create internal grants on a CMK at `CreateSecret` time (the SM-CMK integration uses grants rather than direct `kms:Decrypt` from the calling principal — preserving the consuming-principal design where only the workflow Lambda role decrypts). `kms:UntagResource` has an extra `ForAllValues:StringNotEquals aws:TagKeys=["ironforge-managed"]` clause so the load-bearing tag itself can't be removed (which would otherwise self-lock the role out of the key). Alias write actions are scoped by the `alias/ironforge-*` name prefix only — the underlying-key tag condition was removed after live IAM revealed that `aws:ResourceTag` is evaluated against the alias resource (untaggable, always fails) when the policy is attached to a multi-resource action; the IAM Policy Simulator misleadingly evaluated this as `allowed` per-resource. Residual: apply role can theoretically create an `alias/ironforge-rogue` pointing to a non-Ironforge key, but aliases are naming, not access.

**Two-step manual procedure for adding new services to these roles:** the policy here is the source of truth, but `aws iam put-role-policy` against the live roles is what actually changes them. When a PR adds a new service usage (a new `ssm:*` grant, a new CMK, a new resource-level scope), the procedure is: (1) update this file in the PR; (2) run `aws iam put-role-policy --role-name ironforge-ci-{plan,apply} --policy-name ironforge-ci-{plan,apply}-permissions --policy-document file:///tmp/...json` with the updated JSON manually before merge; (3) merge → CI's first apply uses the updated permissions. Skipping step 2 surfaces as `AccessDenied` on the first CI apply.

## Step 5 — Configure GitHub Environment `production`

In the GitHub UI:

1. Repo → **Settings** → **Environments** → **New environment** → name `production`.
2. **Required reviewers**: add yourself (or any approving reviewer).
3. **Wait timer**: `5` minutes. Gives a window to cancel an approval if "wait, no" hits between merge and apply start.
4. **Deployment branches**: **Selected branches and tags** → add rule `main` only. Prevents non-main branches from triggering apply.
5. Save.

The wait timer + required reviewer is what makes the apply role's `environment:production` sub-claim trust meaningful. Without these gates, anyone with merge access could trigger apply immediately.

### Step 5a — Verify fork-PR Actions settings (load-bearing for plan-role trust)

The plan role's trust policy allows assumption from any workflow run with sub `repo:Ricky-C/ironforge:pull_request` — including fork-PR runs against this repo. Three things make this safe; verify all three.

1. **Repo → Settings → Actions → General → Fork pull request workflows from outside collaborators.**
   Set to **Require approval for first-time contributors** (or stricter: **Require approval for all outside collaborators**). Default-on for new repos but worth confirming. Without this, a first-time contributor's fork PR runs the workflow without maintainer review.
2. **Secret isolation.** GitHub does not pass `secrets.*` to fork-PR `pull_request` workflows. `aws-actions/configure-aws-credentials` would receive an empty `role-to-assume` and fail before the OIDC exchange. This is GitHub's default behavior — there is no setting that opts in to passing secrets to fork PRs from `pull_request` events.
3. **Code-level guard in the workflow.** `.github/workflows/infra-plan.yml` carries a job-level `if: github.event.pull_request.head.repo.full_name == github.repository` so fork-PR runs skip the plan job entirely rather than failing partway. This is the durable invariant — even if GitHub's secret-isolation behavior changes, the workflow refuses to run for fork PRs.

If a fork PR legitimately needs a plan, pull the branch locally and run `terraform plan` — don't relax these gates.

## Step 6 — Configure GitHub repository secrets

Repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

| Name | Value |
|---|---|
| `AWS_OIDC_PLAN_ROLE_ARN` | `arn:aws:iam::<account-id>:role/ironforge-ci-plan` |
| `AWS_OIDC_APPLY_ROLE_ARN` | `arn:aws:iam::<account-id>:role/ironforge-ci-apply` |
| `AWS_ACCOUNT_ID` | `<your-aws-account-id>` |
| `TF_VAR_ALERT_EMAIL` | `<your alert recipient email>` |
| `TF_VAR_GITHUB_ORG_NAME` | `<your GitHub org for provisioned repos, e.g. ironforge-svc>` |
| `TF_VAR_GITHUB_APP_ID` | `<your GitHub App's numeric App ID>` |
| `TF_VAR_GITHUB_APP_INSTALLATION_ID` | `<the App's installation ID in the org>` |

`AWS_ACCOUNT_ID` is technically not a secret, but storing it as a secret keeps it consistent with the env-specific-identifiers convention. The plan/apply role ARNs include the account ID; storing those as secrets prevents the account ID from leaking into workflow logs even indirectly.

The three `TF_VAR_GITHUB_*` secrets are not secrets in the cryptographic sense — App IDs and Installation IDs are visible in GitHub URLs. Storing them as repo secrets follows the env-specific-identifiers convention (the App ID for *this* Ironforge install lives outside source) and lets the workflows pass them in via `TF_VAR_*` env vars without a per-run UI prompt.

## Verification

Run after Steps 1–4 complete. Each command has a clearly stated expected output; failure indicates a setup mistake.

### OIDC provider exists

```bash
aws iam list-open-id-connect-providers \
  --query "OpenIDConnectProviderList[?contains(Arn, 'token.actions.githubusercontent.com')].Arn" \
  --output text
```

Expected: `arn:aws:iam::<account-id>:oidc-provider/token.actions.githubusercontent.com` (the ARN of the provider). Empty output = provider missing.

### Boundary policy exists

```bash
aws iam get-policy \
  --policy-arn "arn:aws:iam::${AWS_ACCOUNT_ID}:policy/IronforgeCIPermissionBoundary" \
  --query 'Policy.PolicyName' --output text
```

Expected: `IronforgeCIPermissionBoundary`.

### Plan role: boundary attached, trust scoped to pull_request

```bash
# Boundary
aws iam get-role --role-name ironforge-ci-plan \
  --query 'Role.PermissionsBoundary.PermissionsBoundaryArn' --output text
# Expected: arn:aws:iam::<account-id>:policy/IronforgeCIPermissionBoundary

# Trust policy sub claim
aws iam get-role --role-name ironforge-ci-plan \
  --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals."token.actions.githubusercontent.com:sub"' \
  --output text
# Expected: repo:Ricky-C/ironforge:pull_request

# Trust policy aud claim
aws iam get-role --role-name ironforge-ci-plan \
  --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals."token.actions.githubusercontent.com:aud"' \
  --output text
# Expected: sts.amazonaws.com
```

### Apply role: boundary attached, trust scoped to environment:production

```bash
# Boundary
aws iam get-role --role-name ironforge-ci-apply \
  --query 'Role.PermissionsBoundary.PermissionsBoundaryArn' --output text
# Expected: arn:aws:iam::<account-id>:policy/IronforgeCIPermissionBoundary

# Trust policy sub claim
aws iam get-role --role-name ironforge-ci-apply \
  --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals."token.actions.githubusercontent.com:sub"' \
  --output text
# Expected: repo:Ricky-C/ironforge:environment:production

# Trust policy aud claim
aws iam get-role --role-name ironforge-ci-apply \
  --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals."token.actions.githubusercontent.com:aud"' \
  --output text
# Expected: sts.amazonaws.com
```

If all six expected outputs match, the bootstrap is correct without needing to wait for the first workflow run.

## Rotation / recovery procedure

**If a CI role is suspected of compromise** (unexpected CloudTrail activity, leaked OIDC token, compromised GitHub repo, etc.), the recovery sequence below halts further damage in seconds and gives you time to investigate without losing access.

**Step 1 — Break the trust immediately.** Edit the suspected role's trust policy to set the `sub` claim to a deliberately non-existent value, e.g., `repo:Ricky-C/ironforge:revoked-pending-rotation`. The role becomes unassumable from any GitHub Actions context within seconds. No need to delete anything yet — preserving the role lets CloudTrail correlate ongoing investigation against its ARN.

```bash
aws iam update-assume-role-policy \
  --role-name ironforge-ci-apply \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Federated":"arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"},"Action":"sts:AssumeRoleWithWebIdentity","Condition":{"StringEquals":{"token.actions.githubusercontent.com:aud":"sts.amazonaws.com","token.actions.githubusercontent.com:sub":"repo:Ricky-C/ironforge:revoked-pending-rotation"}}}]}'
```

**Step 2 — CloudTrail investigation.** Search CloudTrail for `AssumeRoleWithWebIdentity` events targeting the role's ARN over the suspected window. Each event includes the source IP, user agent, and the OIDC token's `sub` claim — enough to determine whether usage was legitimate (workflow runs from `Ricky-C/ironforge`) or anomalous. For anomalous events, pivot to the events made *by* that session: filter `userIdentity.sessionContext.sessionIssuer.arn` matching the role and inspect what was changed. CloudTrail Lake or Athena over the CloudTrail S3 bucket are the practical query surfaces.

**Step 3 — Rotate associated secrets.** Even if the OIDC role itself is the only suspected weak link, rotate the GitHub repo secrets that reference it: regenerate `AWS_OIDC_APPLY_ROLE_ARN` (and plan equivalent if needed) by re-running Step 3 or Step 4 of this bootstrap with a new role name (e.g., `ironforge-ci-apply-v2`), then update the GitHub secret. Delete the old role. Rotating `TF_VAR_ALERT_EMAIL` and `AWS_ACCOUNT_ID` is unnecessary in most cases — those don't grant access — but rotating the role is the meaningful change.

**Step 4 — Restore trust to the rotated role.** The new role's trust policy uses the same sub-claim values as the original (`repo:Ricky-C/ironforge:pull_request` or `repo:Ricky-C/ironforge:environment:production`). Re-run the verification commands above against the new role to confirm the trust policy is correct. The next PR or merge will exercise the new role through the usual workflow path.

**Step 5 — Document what happened.** Add a brief note to `docs/EMERGENCY.md` § "Recovery: reversing a triggered deny policy" (or a new section if the incident is a different shape) with the timeline, what was found in CloudTrail, and what was rotated. The next incident — months from now — benefits from the previous one's notes more than from re-deriving the procedure.
