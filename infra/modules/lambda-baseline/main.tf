# IronforgePermissionBoundary — single managed IAM policy attached as the
# permissions boundary on every Ironforge Lambda execution role.
#
# ALLOW list defines what an inline policy can ever grant. Per-Lambda inline
# policies should be tighter than these (e.g., env-prefix scoping on the
# artifacts bucket happens in inline policies, not here — see ADR-006).
#
# DENY statements are defense in depth — the ALLOW list already doesn't grant
# these, but explicit DENY makes the intent durable against future ALLOW
# widening.
#
# Full design rationale: docs/adrs/006-permission-boundary.md.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name

  component_tags = {
    "ironforge-component" = "lambda-baseline"
  }
}

resource "aws_iam_policy" "permission_boundary" {
  name        = "IronforgePermissionBoundary"
  description = "Permission boundary for all Ironforge Lambda execution roles. Caps inline policy grants to a known-safe set; explicit DENY statements provide defense in depth. See docs/adrs/006-permission-boundary.md."
  policy      = data.aws_iam_policy_document.permission_boundary.json

  tags = local.component_tags
}

data "aws_iam_policy_document" "permission_boundary" {
  # ===========================================================================
  # ALLOW
  # ===========================================================================

  statement {
    sid    = "AllowLogsForIronforgeLambdas"
    effect = "Allow"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = [
      "arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/ironforge-*:*",
    ]
  }

  # X-Ray write actions are account-scoped per AWS service authorization
  # reference. See docs/iam-exceptions.md.
  statement {
    sid    = "AllowXRayWrite"
    effect = "Allow"
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "AllowDynamoDBOnIronforgeTables"
    effect = "Allow"
    actions = [
      "dynamodb:GetItem",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
      "dynamodb:DeleteItem",
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
      # TransactWriteItems is its own IAM action distinct from PutItem;
      # POST /api/services uses it to atomically create Service + Job
      # rows. PR-C.2 added.
      "dynamodb:TransactWriteItems",
      "dynamodb:Query",
      "dynamodb:Scan",
      "dynamodb:DescribeTable",
    ]
    resources = [
      "arn:aws:dynamodb:${local.region}:${local.account_id}:table/ironforge-*",
      "arn:aws:dynamodb:${local.region}:${local.account_id}:table/ironforge-*/index/*",
    ]
  }

  # Boundary allows broadly on the artifacts bucket. Per-Lambda inline
  # policies scope to env prefixes (e.g., bucket_arn/dev/*). See ADR-006
  # § "Why not principal-tag substitution" for why prefix scoping lives
  # in identity policies, not the boundary.
  statement {
    sid    = "AllowArtifactsBucketAccess"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ]
    resources = [
      "arn:aws:s3:::ironforge-artifacts-*",
      "arn:aws:s3:::ironforge-artifacts-*/*",
    ]
  }

  # Per-service Terraform state buckets. The run-terraform Lambda's
  # terraform invocation uses the s3 backend; reads/writes per-service
  # state at services/<id>/terraform.tfstate (and the .tflock sibling
  # under use_lockfile=true). The Lambda's identity policy narrows to
  # the services/* prefix on the env-specific bucket; the boundary
  # allows broadly across env-named tfstate buckets so a single boundary
  # spans both dev and (future) prod compositions.
  #
  # Discovered during Phase 1 verification round 6 (PR-C.6 + run #5 IAM
  # gap fixed in PR #69). The PR #69 identity grant was correct but the
  # boundary intersection denied because the boundary only listed
  # ironforge-artifacts-*. Architectural gap — boundary captured the
  # bucket-level tenants that EXISTED at boundary-creation time, but
  # the per-service state-bucket tenant (added by run-terraform's apply
  # logic) wasn't reflected here.
  statement {
    sid    = "AllowTFStateBucketAccess"
    effect = "Allow"
    actions = [
      "s3:GetObject",
      "s3:PutObject",
      "s3:DeleteObject",
      "s3:ListBucket",
    ]
    resources = [
      "arn:aws:s3:::ironforge-tfstate-*",
      "arn:aws:s3:::ironforge-tfstate-*/*",
    ]
  }

  statement {
    sid    = "AllowRoute53OnIronforgeZone"
    effect = "Allow"
    actions = [
      "route53:ChangeResourceRecordSets",
      "route53:ListResourceRecordSets",
    ]
    resources = [var.route53_zone_arn]
  }

  # PR-C.6 boundary widening — run-terraform Lambda needs route53:GetChange
  # to poll record-change propagation status after ChangeResourceRecordSets.
  # AWS does not support resource-level scoping for this action — it returns
  # change-set records that aren't tied to a specific zone. Captured in
  # docs/iam-exceptions.md and ADR-006 § Amendments (PR-C.6).
  statement {
    sid       = "AllowRoute53GetChangeStarRequired"
    effect    = "Allow"
    actions   = ["route53:GetChange"]
    resources = ["*"]
  }

  # PR-C.6 boundary widening — run-terraform Lambda needs cloudfront:* on
  # Resource:* to manage per-service distributions and origin access controls.
  # CloudFront's Create*/Update*/Delete* APIs do not support ARN-scoped
  # grants at create time, and tag-based scoping is unreliable due to
  # uneven tag-on-create across the API surface. Per-Lambda identity
  # policy below enumerates the specific actions; the boundary here caps
  # to the cloudfront:* surface only. Captured in docs/iam-exceptions.md
  # § "CloudFront — extended rationale" and ADR-006 § Amendments (PR-C.6).
  statement {
    sid       = "AllowCloudFrontStarRequired"
    effect    = "Allow"
    actions   = ["cloudfront:*"]
    resources = ["*"]
  }

  # PR-C.6 boundary widening — IAM role + policy management on the
  # ironforge-svc-* namespace ONLY. Each provisioned service has a
  # GitHub-Actions-OIDC deploy role named ironforge-svc-<service-name>-deploy
  # plus (forward-compat for future templates) an inline-or-managed policy
  # in the same namespace. The run-terraform Lambda is the only Lambda
  # that exercises these grants; other Lambdas inheriting this boundary
  # cannot widen their own inline policies beyond ironforge-svc-* role/policy
  # ARNs. The DenyIAMRoleAndPolicyOutsideIronforgeServiceNamespace deny
  # below uses NotResource on the same ARN patterns to make the carve-out
  # bidirectional (allow + non-deny intersect to "permitted" only on
  # ironforge-svc-*). Captured in ADR-006 § Amendments (PR-C.6).
  statement {
    sid    = "AllowIAMOnIronforgeServiceResources"
    effect = "Allow"
    actions = [
      "iam:CreateRole",
      "iam:GetRole",
      "iam:DeleteRole",
      "iam:UpdateRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:ListRoleTags",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:PutRolePermissionsBoundary",
      "iam:DeleteRolePermissionsBoundary",
      "iam:PutRolePolicy",
      "iam:GetRolePolicy",
      "iam:DeleteRolePolicy",
    ]
    resources = [
      "arn:aws:iam::${local.account_id}:role/ironforge-svc-*",
      "arn:aws:iam::${local.account_id}:policy/ironforge-svc-*",
    ]
  }

  statement {
    sid     = "AllowSNSPublishOnIronforgeTopics"
    effect  = "Allow"
    actions = ["sns:Publish"]
    resources = [
      "arn:aws:sns:${local.region}:${local.account_id}:ironforge-*",
    ]
  }

  statement {
    sid    = "AllowStepFunctionsOnIronforgeStateMachines"
    effect = "Allow"
    actions = [
      "states:StartExecution",
      "states:DescribeExecution",
      "states:GetExecutionHistory",
    ]
    resources = [
      "arn:aws:states:${local.region}:${local.account_id}:stateMachine:ironforge-*",
      "arn:aws:states:${local.region}:${local.account_id}:execution:ironforge-*:*",
    ]
  }

  statement {
    sid     = "AllowSecretsManagerOnIronforgeSecrets"
    effect  = "Allow"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      "arn:aws:secretsmanager:${local.region}:${local.account_id}:secret:ironforge/*",
    ]
  }

  # kms:Decrypt added in PR-C.4a. ADR-006 originally excluded KMS from
  # the boundary on the basis that no Lambda directly called KMS post-
  # ADR-003; PR-C.4a's GitHub App helper is the first such Lambda
  # (Secrets Manager + CMK integration evaluates kms:Decrypt against
  # the caller's permissions). Resource-tag condition is reliable for
  # kms:Decrypt across all key operations — alias-name conditions
  # (which the original ADR flagged as inconsistent) are deliberately
  # not used. Per-Lambda identity policies in PR-C.4b / PR-C.8 narrow
  # further with specific CMK ARN + EncryptionContext:SecretARN
  # binding. See ADR-006 § Amendments.
  #
  # kms:GenerateDataKey added during Phase 1 verification round 6.
  # Terraform's S3 backend writes state to a CMK-encrypted bucket; the
  # AWS SDK uses GenerateDataKey to mint per-object data keys for
  # envelope encryption. Decrypt alone covers reads but not writes.
  # Same tag-condition scope as Decrypt — the broader action set on
  # ironforge-managed keys is fine because per-Lambda identity policies
  # narrow further (key policies further constrain via principal
  # whitelisting like the tfstate CMK's AllowConsumingLambdaUseKey).
  statement {
    sid    = "AllowKmsDecryptOnIronforgeManagedKeys"
    effect = "Allow"
    actions = [
      "kms:Decrypt",
      "kms:GenerateDataKey",
    ]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "kms:ResourceTag/ironforge-managed"
      values   = ["true"]
    }
  }

  # ce:GetCostAndUsage is account-scoped per AWS service authorization
  # reference. See docs/iam-exceptions.md.
  statement {
    sid       = "AllowCostExplorerRead"
    effect    = "Allow"
    actions   = ["ce:GetCostAndUsage"]
    resources = ["*"]
  }

  statement {
    sid     = "AllowLambdaInvokeOnIronforgeFunctions"
    effect  = "Allow"
    actions = ["lambda:InvokeFunction"]
    resources = [
      "arn:aws:lambda:${local.region}:${local.account_id}:function:ironforge-*",
    ]
  }

  # ===========================================================================
  # DENY (defense in depth)
  # ===========================================================================

  # PR-C.6 split the original DenyIAMManagement into two statements so the
  # ironforge-svc-* role/policy carve-out (run-terraform's per-service
  # deploy-role provisioning) doesn't accidentally widen to user/group/OIDC
  # provider creation. The first deny is hardline (Resource:*) — Lambdas
  # NEVER manage users, groups, or OIDC providers. The second uses
  # not_resources to carve out the ironforge-svc-* namespace from
  # role+policy mgmt actions only. ADR-006 § Amendments (PR-C.6) captures
  # the framing as refinement (narrowing the deny scope to non-service
  # resources), not loosening (the boundary's role+policy mgmt grant is
  # still namespaced via AllowIAMOnIronforgeServiceResources above).
  statement {
    sid    = "DenyIAMUserGroupAndOIDCManagement"
    effect = "Deny"
    actions = [
      "iam:CreateUser",
      "iam:DeleteUser",
      "iam:CreateLoginProfile",
      "iam:CreateAccessKey",
      "iam:AttachUserPolicy",
      "iam:PutUserPolicy",
      "iam:CreateGroup",
      "iam:DeleteGroup",
      "iam:CreateOpenIDConnectProvider",
      "iam:DeleteOpenIDConnectProvider",
    ]
    resources = ["*"]
  }

  statement {
    sid    = "DenyIAMRoleAndPolicyOutsideIronforgeServiceNamespace"
    effect = "Deny"
    actions = [
      "iam:CreateRole",
      "iam:DeleteRole",
      "iam:UpdateRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:PutRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:PutRolePermissionsBoundary",
      "iam:DeleteRolePermissionsBoundary",
      "iam:CreatePolicy",
      "iam:CreatePolicyVersion",
      "iam:DeletePolicy",
    ]
    not_resources = [
      "arn:aws:iam::${local.account_id}:role/ironforge-svc-*",
      "arn:aws:iam::${local.account_id}:policy/ironforge-svc-*",
    ]
  }

  statement {
    sid       = "DenySTSAssumeRole"
    effect    = "Deny"
    actions   = ["sts:AssumeRole"]
    resources = ["*"]
  }

  # Mirrors the cost-safeguards deny policy permanently. The deny policy is
  # only attached on budget breach; this boundary keeps these services blocked
  # at all times for Lambdas. Lambdas should never use these services.
  statement {
    sid    = "DenyExpensiveServicesPermanently"
    effect = "Deny"
    actions = [
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
      "documentdb:*",
    ]
    resources = ["*"]
  }
}
