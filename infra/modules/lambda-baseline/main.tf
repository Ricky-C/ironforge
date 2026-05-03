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

  # Per-service origin buckets. The run-terraform Lambda creates and
  # manages these buckets as part of static-site template apply.
  # Object operations (s3:GetObject/PutObject/DeleteObject) are
  # intentionally excluded — content uploads happen via GitHub Actions
  # using a per-service deploy role, NOT the workflow Lambda, so the
  # workflow has no need to read/write objects in tenant buckets.
  #
  # Resource pattern matches the static-site template's bucket naming
  # exactly. When additional templates land (Phase 2+) with different
  # bucket suffixes, this statement will need extension to cover them
  # — keeping the suffix explicit avoids granting the workflow Lambda
  # bucket-lifecycle access on every ironforge-svc-* bucket pattern,
  # which would broaden the surface beyond what's needed.
  #
  # Discovered during Phase 1 verification round 7 — terraform apply
  # failed with s3:CreateBucket AccessDenied with the exact error
  # message "no permissions boundary allows the s3:CreateBucket action".
  # Same architectural shape as the AllowTFStateBucketAccess case in
  # round 6: identity policy grants were correct (S3BucketCRUD +
  # S3BucketVersioning + ... in run_terraform_extra_statements), but
  # the boundary v5 covered only object-level operations on artifacts
  # and tfstate — not bucket-level lifecycle on tenant buckets.
  statement {
    sid    = "AllowProvisionedBucketLifecycle"
    effect = "Allow"
    actions = [
      "s3:CreateBucket",
      "s3:DeleteBucket",
      "s3:GetBucketLocation",
      "s3:GetBucketTagging",
      "s3:PutBucketTagging",
      "s3:ListBucket",
      "s3:GetBucketVersioning",
      "s3:PutBucketVersioning",
      "s3:GetEncryptionConfiguration",
      "s3:PutEncryptionConfiguration",
      "s3:GetBucketPublicAccessBlock",
      "s3:PutBucketPublicAccessBlock",
      "s3:GetLifecycleConfiguration",
      "s3:PutLifecycleConfiguration",
      "s3:GetBucketPolicy",
      "s3:PutBucketPolicy",
      "s3:DeleteBucketPolicy",
    ]
    resources = [
      "arn:aws:s3:::ironforge-svc-*-origin",
    ]
  }

  # Companion to AllowProvisionedBucketLifecycle. terraform's AWS provider
  # refreshes ~10 different bucket configurations on every aws_s3_bucket
  # resource (ACL, CORS, Website, Logging, Accelerate, RequestPayment,
  # Replication, ObjectLock, OwnershipControls, Notification, ...) and
  # each requires its own s3:GetBucket* permission. Discovered round 8
  # (s3:GetBucketAcl explicitly named in the failure); rather than adding
  # one Get action per round, the wildcard scopes to the bucket pattern
  # and bounds future provider-driven reads. Pattern matches the existing
  # cloudfront:* / kms:* boundary statements.
  statement {
    sid       = "AllowProvisionedBucketRead"
    effect    = "Allow"
    actions   = ["s3:Get*"]
    resources = ["arn:aws:s3:::ironforge-svc-*-origin"]
  }

  # Object-level operations on per-service origin buckets. Where
  # AllowProvisionedBucketLifecycle covers what the workflow Lambda needs
  # (bucket-level create/configure/delete), this covers what the per-service
  # DEPLOY ROLE needs — the role created by the static-site template and
  # assumed by GitHub Actions to sync content. The boundary is shared
  # across both tenants; per-role identity policies narrow further (the
  # workflow Lambda's identity policy doesn't grant object operations,
  # so this widening doesn't grant the workflow itself anything new).
  #
  # Action set scoped to deploy.yml's actual operations:
  #   - PutObject   (aws s3 sync uploads)
  #   - DeleteObject (--delete flag prunes removed files)
  #   - GetObject   (sync compares ETags before re-uploading)
  # Note the /* ARN suffix — bucket-level ARN doesn't grant object ops.
  #
  # Discovered Phase 1 verification round 11 — wait-for-deploy failed
  # because the user's deploy.yml hit AccessDenied on PutObject. This
  # is a different category of discovery than prior rounds: those were
  # platform-side gaps (Ironforge's own configuration); this is at the
  # platform-vs-user-tenant boundary (what the platform GRANTS to user
  # code). See docs/conventions.md § "Platform IAM vs. user-tenant IAM"
  # for the durable convention.
  statement {
    sid    = "AllowProvisionedBucketObjects"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:GetObject",
      "s3:DeleteObject",
    ]
    resources = ["arn:aws:s3:::ironforge-svc-*-origin/*"]
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

  # Companion to AllowRoute53OnIronforgeZone — terraform's
  # aws_route53_record refreshes zone metadata via route53:GetHostedZone.
  # Same shape as AllowProvisionedBucketRead: bounded read wildcard
  # scoped to the specific zone ARN. Discovered round 10.
  statement {
    sid       = "AllowRoute53GetOnIronforgeZone"
    effect    = "Allow"
    actions   = ["route53:Get*"]
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
