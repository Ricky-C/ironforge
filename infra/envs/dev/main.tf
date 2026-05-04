# Dev environment composition root.

data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# Shared (account-level) composition outputs. Same state bucket as this
# composition; different state key. Per ADR-001's composition split:
# resources here that need shared resources read them via remote_state.
data "terraform_remote_state" "shared" {
  backend = "s3"
  config = {
    bucket = "ironforge-terraform-state-${data.aws_caller_identity.current.account_id}"
    key    = "ironforge/shared/account/terraform.tfstate"
    region = "us-east-1"
  }
}

locals {
  account_id = data.aws_caller_identity.current.account_id
  region     = data.aws_region.current.name

  # State machine ARNs computed up-front so the API Lambda can scope its
  # states:StartExecution grants before the state machine resources exist
  # (terraform graph dependency: API Lambda role → state machine names,
  # state machines → task Lambda ARNs). Naming has to match the
  # step-functions module's local.<...>_state_machine_name exactly.
  state_machine_name                = "ironforge-${var.environment}-provisioning"
  state_machine_arn                 = "arn:aws:states:${local.region}:${local.account_id}:stateMachine:${local.state_machine_name}"
  deprovisioning_state_machine_name = "ironforge-${var.environment}-deprovisioning"
  deprovisioning_state_machine_arn  = "arn:aws:states:${local.region}:${local.account_id}:stateMachine:${local.deprovisioning_state_machine_name}"
}

module "dynamodb" {
  source = "../../modules/dynamodb"

  environment = var.environment
}

# ===========================================================================
# Workflow task Lambdas (PR-C.2 stubs — see services/workflow/_stub-lib)
# ===========================================================================
#
# 8 task Lambdas, one per state in the provisioning state machine. Each is
# a thin facade over @ironforge/workflow-stub-lib for PR-C.2; PR-C.3+
# replaces handlers one at a time. IAM grants are uniform across the 6
# simple stubs (DynamoDB read+write for JobStep upserts); finalize and
# cleanup-on-failure also need Service/Job transitions but use the same
# table ARN, so the grants set is identical.
#
# CI runs `pnpm -r --filter "@ironforge/workflow-*" build` before plan
# so each dist/ directory exists when archive_file zips it.

locals {
  # Shared environment variables for every task Lambda. DynamoDB table
  # name is the only required env; stub-lib reads tableName via
  # getTableName() at request time.
  task_lambda_env = {
    DYNAMODB_TABLE_NAME     = module.dynamodb.table_name
    IRONFORGE_ENV           = var.environment
    POWERTOOLS_SERVICE_NAME = "ironforge-workflow"
    LOG_LEVEL               = "INFO"
  }

  # Shared iam_grants: every task Lambda reads + writes the env's
  # DynamoDB table (JobStep upserts; finalize/cleanup also do
  # transitionStatus on Service/Job). GSI1 access is included for
  # symmetry — finalize doesn't currently use it but PR-C.9 may.
  task_lambda_iam_grants = {
    dynamodb_read = [
      module.dynamodb.table_arn,
      "${module.dynamodb.table_arn}/index/*",
    ]
    dynamodb_write = [
      module.dynamodb.table_arn,
    ]
  }
}

module "task_validate_inputs" {
  source = "../../modules/lambda"

  function_name           = "ironforge-${var.environment}-validate-inputs"
  environment             = var.environment
  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn
  source_dir              = "${path.root}/../../../services/workflow/validate-inputs/dist"
  environment_variables   = local.task_lambda_env
  iam_grants              = local.task_lambda_iam_grants
}

module "task_create_repo" {
  source = "../../modules/lambda"

  function_name           = "ironforge-${var.environment}-create-repo"
  environment             = var.environment
  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn
  source_dir              = "${path.root}/../../../services/workflow/create-repo/dist"

  # PR-C.4b: real handler. Adds GitHub App-related env vars + IAM grants
  # for Secrets Manager + KMS. SSM-backed identifiers (app id,
  # installation id, org name) are resolved at terraform plan time and
  # baked into the env vars; runtime SSM access is not needed and not
  # granted. Rotation requires a redeploy — acceptable for Phase 1.
  environment_variables = merge(local.task_lambda_env, {
    GITHUB_APP_SECRET_ARN      = data.terraform_remote_state.shared.outputs.github_app_secret_arn
    GITHUB_APP_ID              = data.aws_ssm_parameter.github_app_id.value
    GITHUB_APP_INSTALLATION_ID = data.aws_ssm_parameter.github_app_installation_id.value
    GITHUB_ORG_NAME            = data.aws_ssm_parameter.github_org_name.value
  })

  # The boundary widening (PR-C.4a, ADR-006 amendment) caps these
  # actions broadly with tag conditions; the per-Lambda statements
  # below narrow further with specific ARNs + EncryptionContext binding.
  # Intersection (which permission-boundary semantics evaluate) gives
  # this Lambda only github-app-secret decryption right.
  iam_grants = {
    dynamodb_read  = local.task_lambda_iam_grants.dynamodb_read
    dynamodb_write = local.task_lambda_iam_grants.dynamodb_write
    extra_statements = [
      {
        sid       = "GetGitHubAppSecret"
        actions   = ["secretsmanager:GetSecretValue"]
        resources = [data.terraform_remote_state.shared.outputs.github_app_secret_arn]
      },
      {
        sid       = "DecryptGitHubAppSecret"
        actions   = ["kms:Decrypt"]
        resources = [data.terraform_remote_state.shared.outputs.github_app_kms_key_arn]
        conditions = [
          {
            test     = "StringEquals"
            variable = "kms:EncryptionContext:SecretARN"
            values   = [data.terraform_remote_state.shared.outputs.github_app_secret_arn]
          },
        ]
      },
    ]
  }
}

# SSM data sources for GitHub App identifiers. Read at terraform plan
# time and baked into the create-repo Lambda's env vars. The apply role
# has ssm:Get* on /ironforge/* from PR #41 hardening.
# Parameter names constructed as ${path_prefix}/${suffix}. The path
# prefix output (github_app_ssm_parameter_path) is already in shared's
# applied state from PR #41; the suffixes match the github-app-secret
# module's aws_ssm_parameter resource names verbatim. Going through the
# applied prefix output (vs hardcoding `/ironforge/github-app/`) keeps
# the path convention's source of truth in the module that owns it.
locals {
  github_app_ssm_path = data.terraform_remote_state.shared.outputs.github_app_ssm_parameter_path
}

data "aws_ssm_parameter" "github_app_id" {
  name = "${local.github_app_ssm_path}/app-id"
}

data "aws_ssm_parameter" "github_app_installation_id" {
  name = "${local.github_app_ssm_path}/installation-id"
}

data "aws_ssm_parameter" "github_org_name" {
  name = "${local.github_app_ssm_path}/org-name"
}

module "task_generate_code" {
  source = "../../modules/lambda"

  function_name           = "ironforge-${var.environment}-generate-code"
  environment             = var.environment
  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn
  source_dir              = "${path.root}/../../../services/workflow/generate-code/dist"

  # PR-C.5: real handler. Same GitHub App access pattern as create-repo
  # (PR-C.4b): env vars from SSM/shared outputs at plan time, identity
  # policy with secretsmanager + kms:Decrypt narrowed via
  # EncryptionContext binding. Boundary widening from PR-C.4a caps the
  # actions; identity policy narrows to this Lambda's specific use.
  environment_variables = merge(local.task_lambda_env, {
    GITHUB_APP_SECRET_ARN      = data.terraform_remote_state.shared.outputs.github_app_secret_arn
    GITHUB_APP_ID              = data.aws_ssm_parameter.github_app_id.value
    GITHUB_APP_INSTALLATION_ID = data.aws_ssm_parameter.github_app_installation_id.value
    GITHUB_ORG_NAME            = data.aws_ssm_parameter.github_org_name.value
  })

  iam_grants = {
    dynamodb_read  = local.task_lambda_iam_grants.dynamodb_read
    dynamodb_write = local.task_lambda_iam_grants.dynamodb_write
    extra_statements = [
      {
        sid       = "GetGitHubAppSecret"
        actions   = ["secretsmanager:GetSecretValue"]
        resources = [data.terraform_remote_state.shared.outputs.github_app_secret_arn]
      },
      {
        sid       = "DecryptGitHubAppSecret"
        actions   = ["kms:Decrypt"]
        resources = [data.terraform_remote_state.shared.outputs.github_app_kms_key_arn]
        conditions = [
          {
            test     = "StringEquals"
            variable = "kms:EncryptionContext:SecretARN"
            values   = [data.terraform_remote_state.shared.outputs.github_app_secret_arn]
          },
        ]
      },
    ]
  }
}

# PR-C.6 — real run-terraform Lambda. Container image (per ADR-009 §
# Amendments: AWS provider 5.83.0 binary alone is 585MB, blowing the zip
# 250MB layer cap). The image is built by
# infra/modules/terraform-lambda-image/build-image.sh, pushed to ECR by
# CI BEFORE terraform plan, and the immutable image digest URI is
# captured in the .image-uri sentinel file. terraform plan reads that
# file via local_file data source — local plans without docker need to
# stage the file manually (captured as a tech-debt entry).
data "local_file" "run_terraform_image_uri" {
  filename = "${path.root}/../../modules/terraform-lambda-image/.image-uri"
}

# Per-Lambda inline IAM grants for the terraform workload itself.
# Mirrors @ironforge/template-renderer's generateRunTerraformPolicy()
# output for the static-site template's allowedResourceTypes whitelist
# (templates/static-site/ironforge.yaml), with resourcePrefix=ironforge-svc-*
# (wildcard because service names are per-invocation, not deploy-time).
# The prefix wildcard is the security boundary; per-service uniqueness
# falls out of CreateBucket / CreateRole returning 409 on collision.
#
# Source-of-truth alignment: the JS-side RESOURCE_TYPE_TO_IAM mapping
# is unit-tested in packages/template-renderer/src/iam-policy.test.ts;
# this HCL is the deployed copy. Drift between the two is captured in
# docs/tech-debt.md § "Drift detection: run-terraform IAM grants vs
# RESOURCE_TYPE_TO_IAM mapping" — automation TBD. Adding a resource
# type to the manifest requires updating BOTH this block AND the JS
# mapping in the same PR.
#
# Boundary widening (PR-C.6, ADR-006 amendment) caps these:
# AllowCloudFrontStarRequired permits cloudfront:* on Resource:*;
# AllowRoute53GetChangeStarRequired permits route53:GetChange on Resource:*;
# AllowIAMOnIronforgeServiceResources permits iam:Role* + iam:RolePolicy*
# on ironforge-svc-* role/policy ARNs only. This identity policy
# narrows further with specific actions per resource type.
locals {
  run_terraform_extra_statements = [
    # ── Terraform backend — per-service state in the dev tfstate bucket ───
    # The Lambda's terraform invocation uses the s3 backend; reads/writes
    # state via S3 SDK using the Lambda execution role. Per-service state
    # lives at services/<service-id>/terraform.tfstate. With
    # use_lockfile=true (S3-native locking), the same prefix holds the
    # .tflock file. Both share the same grant.
    #
    # Scoped to services/* — never the bucket root (which holds Ironforge's
    # OWN composition state files that the Lambda must not touch). KMS
    # decrypt/encrypt for this bucket's CMK is granted via the key policy
    # (AllowConsumingLambdaUseKey), not via the IAM identity policy.
    #
    # Discovered during Phase 1 verification round 5: terraform init failed
    # with HeadObject 403 because the role had grants for the buckets it
    # provisions (ironforge-svc-*-origin) but none for the bucket it itself
    # depends on. Architectural gap — not drift.
    {
      sid = "S3TFStateObjectAccess"
      actions = [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
      ]
      resources = ["${data.terraform_remote_state.shared.outputs.tfstate_dev_bucket_arn}/services/*"]
    },
    {
      sid       = "S3TFStateBucketList"
      actions   = ["s3:ListBucket"]
      resources = [data.terraform_remote_state.shared.outputs.tfstate_dev_bucket_arn]
      # Limit the listing to the services/ prefix so the Lambda can never
      # enumerate Ironforge's composition state keys (envs/dev/, envs/shared/).
      conditions = [
        {
          test     = "StringLike"
          variable = "s3:prefix"
          values   = ["services/*"]
        },
      ]
    },
    # ── Per-service origin buckets ───────────────────────────────────────────
    # Broad read on the origin bucket pattern. terraform's AWS provider
    # refreshes ~10 different bucket configurations on every aws_s3_bucket
    # resource (ACL, CORS, Website, Logging, Accelerate, RequestPayment,
    # Replication, ObjectLock, OwnershipControls, Notification, ...) and
    # each requires its own s3:GetBucket* permission. Granting them
    # individually has bitten verification iteratively (round 8 surfaced
    # s3:GetBucketAcl); the wildcard is bounded to the resource pattern
    # and matches the existing cloudfront:* / kms:* style.
    {
      sid       = "S3BucketRead"
      actions   = ["s3:Get*"]
      resources = ["arn:aws:s3:::ironforge-svc-*-origin"]
    },
    # ── S3 bucket lifecycle ────────────────────────────────────────────────
    {
      sid = "S3BucketCRUD"
      actions = [
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:GetBucketLocation",
        "s3:GetBucketTagging",
        "s3:PutBucketTagging",
        "s3:ListBucket",
      ]
      resources = ["arn:aws:s3:::ironforge-svc-*-origin"]
    },
    {
      sid = "S3BucketVersioning"
      actions = [
        "s3:GetBucketVersioning",
        "s3:PutBucketVersioning",
      ]
      resources = ["arn:aws:s3:::ironforge-svc-*-origin"]
    },
    {
      sid = "S3BucketEncryption"
      actions = [
        "s3:GetEncryptionConfiguration",
        "s3:PutEncryptionConfiguration",
      ]
      resources = ["arn:aws:s3:::ironforge-svc-*-origin"]
    },
    {
      sid = "S3BucketPublicAccessBlock"
      actions = [
        "s3:GetBucketPublicAccessBlock",
        "s3:PutBucketPublicAccessBlock",
      ]
      resources = ["arn:aws:s3:::ironforge-svc-*-origin"]
    },
    {
      sid = "S3BucketLifecycle"
      actions = [
        "s3:GetLifecycleConfiguration",
        "s3:PutLifecycleConfiguration",
      ]
      resources = ["arn:aws:s3:::ironforge-svc-*-origin"]
    },
    {
      sid = "S3BucketPolicy"
      actions = [
        "s3:GetBucketPolicy",
        "s3:PutBucketPolicy",
        "s3:DeleteBucketPolicy",
      ]
      resources = ["arn:aws:s3:::ironforge-svc-*-origin"]
    },
    # ── CloudFront (ID-based ARNs, no resource-level scoping) ──────────────
    {
      sid = "CloudFrontOACManagement"
      actions = [
        "cloudfront:CreateOriginAccessControl",
        "cloudfront:GetOriginAccessControl",
        "cloudfront:UpdateOriginAccessControl",
        "cloudfront:DeleteOriginAccessControl",
        "cloudfront:ListOriginAccessControls",
      ]
      resources = ["*"]
    },
    {
      sid = "CloudFrontDistributionManagement"
      actions = [
        "cloudfront:CreateDistribution",
        "cloudfront:GetDistribution",
        "cloudfront:GetDistributionConfig",
        "cloudfront:UpdateDistribution",
        "cloudfront:DeleteDistribution",
        "cloudfront:TagResource",
        "cloudfront:UntagResource",
        "cloudfront:ListTagsForResource",
      ]
      resources = ["*"]
    },
    # ── Route53 (record set actions scope to hosted zone ARN) ──────────────
    {
      sid = "Route53RecordManagement"
      actions = [
        "route53:ChangeResourceRecordSets",
        "route53:ListResourceRecordSets",
      ]
      resources = [data.terraform_remote_state.shared.outputs.dns_hosted_zone_arn]
    },
    # Companion to Route53RecordManagement — terraform's aws_route53_record
    # resource reads zone metadata (route53:GetHostedZone) during plan/apply
    # to verify the zone exists. Same wildcard-scoped-to-resource pattern
    # as S3BucketRead. Discovered round 10.
    {
      sid       = "Route53HostedZoneRead"
      actions   = ["route53:Get*"]
      resources = [data.terraform_remote_state.shared.outputs.dns_hosted_zone_arn]
    },
    {
      sid       = "Route53GetChangeStarRequired"
      actions   = ["route53:GetChange"]
      resources = ["*"]
    },
    # ── IAM (deploy role + inline role policy, ironforge-svc-* namespace) ─
    {
      sid = "IAMRoleManagement"
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
      ]
      resources = ["arn:aws:iam::${local.account_id}:role/ironforge-svc-*-deploy"]
    },
    {
      sid = "IAMRolePolicyManagement"
      actions = [
        "iam:PutRolePolicy",
        "iam:GetRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:ListRolePolicies",
      ]
      resources = ["arn:aws:iam::${local.account_id}:role/ironforge-svc-*-deploy"]
    },
  ]
}

module "task_run_terraform" {
  source = "../../modules/lambda"

  function_name           = "ironforge-${var.environment}-run-terraform"
  environment             = var.environment
  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn

  # Container image deploy. source_dir is omitted (Zip-only); image_uri
  # references the immutable digest captured at build time.
  package_type = "Image"
  image_uri    = trimspace(data.local_file.run_terraform_image_uri.content)

  # Timeout: 900s (Lambda hard ceiling). Bumped from 600s during Phase 1.5
  # PR 6 verification when a re-POST of portfolio-demo timed out at 600s
  # mid-CloudFront-create. Phase 1's run #12 took 3:43; this run was still
  # in apply at 10:00 — CloudFront tail latency was the variance source.
  # ADR-009's "single apply exceeds 8 min" trigger fired empirically.
  # Consumes the remaining Lambda headroom; next escalation is the
  # CodeBuild migration (ADR-009 § Future). New triggers calibrated to
  # the 900s ceiling are in the ADR amendment.
  timeout_seconds = 900

  # Memory: 2048MB. Terraform's binary + provider's in-process state
  # representation is ~300MB resident at apply time on large diffs.
  # 2048MB also bumps the Lambda CPU allocation, which the apply benefits
  # from. Tune later based on measured cold-start + execution latency.
  memory_mb = 2048

  environment_variables = merge(local.task_lambda_env, {
    # Path convention: handler at /var/task/, platform tooling at /opt/.
    # Templates land at /opt/templates/<id>/terraform/ (Dockerfile COPY).
    TEMPLATE_PATH                      = "/opt/templates"
    TFSTATE_BUCKET                     = data.terraform_remote_state.shared.outputs.tfstate_dev_bucket_name
    TFSTATE_KMS_KEY_ARN                = data.terraform_remote_state.shared.outputs.tfstate_dev_kms_key_arn
    AWS_ACCOUNT_ID                     = local.account_id
    IRONFORGE_DOMAIN                   = "ironforge.rickycaballero.com"
    IRONFORGE_HOSTED_ZONE_ID           = data.terraform_remote_state.shared.outputs.dns_hosted_zone_id
    IRONFORGE_WILDCARD_CERT_ARN        = data.terraform_remote_state.shared.outputs.dns_certificate_arn
    IRONFORGE_GITHUB_ORG               = data.aws_ssm_parameter.github_org_name.value
    IRONFORGE_GITHUB_OIDC_PROVIDER_ARN = "arn:aws:iam::${local.account_id}:oidc-provider/token.actions.githubusercontent.com"
    IRONFORGE_PERMISSION_BOUNDARY_ARN  = data.terraform_remote_state.shared.outputs.permission_boundary_arn
  })

  # Baseline DynamoDB grants for JobStep upserts + per-resource-type
  # grants for the terraform workload (12 statements, see
  # local.run_terraform_extra_statements above).
  iam_grants = {
    dynamodb_read    = local.task_lambda_iam_grants.dynamodb_read
    dynamodb_write   = local.task_lambda_iam_grants.dynamodb_write
    extra_statements = local.run_terraform_extra_statements
  }
}

module "task_wait_for_cloudfront" {
  source = "../../modules/lambda"

  function_name           = "ironforge-${var.environment}-wait-for-cloudfront"
  environment             = var.environment
  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn
  source_dir              = "${path.root}/../../../services/workflow/wait-for-cloudfront/dist"
  environment_variables   = local.task_lambda_env

  # PR-C.7: real handler. Single CloudFront read per poll tick.
  # cloudfront:GetDistribution requires Resource: "*" — distribution
  # ARNs are ID-based and we don't know the ID at terraform plan time
  # (created by run-terraform per provision). Same constraint as run-
  # terraform's own CloudFront grants (see local.run_terraform_extra_
  # statements above). Boundary widening from PR-C.6 caps cloudfront:*
  # at the boundary; this identity policy narrows to a single read
  # action on the same Resource: "*".
  iam_grants = {
    dynamodb_read  = local.task_lambda_iam_grants.dynamodb_read
    dynamodb_write = local.task_lambda_iam_grants.dynamodb_write
    extra_statements = [
      {
        sid       = "GetCloudFrontDistribution"
        actions   = ["cloudfront:GetDistribution"]
        resources = ["*"]
      },
    ]
  }
}

module "task_trigger_deploy" {
  source = "../../modules/lambda"

  function_name           = "ironforge-${var.environment}-trigger-deploy"
  environment             = var.environment
  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn
  source_dir              = "${path.root}/../../../services/workflow/trigger-deploy/dist"

  # PR-C.8: real handler. GitHub App access pattern identical to
  # create-repo + generate-code (PR-C.4b/C.5): env vars from
  # SSM/shared outputs at plan time, identity policy with
  # secretsmanager + kms:Decrypt narrowed via EncryptionContext
  # binding. App needs actions:write + secrets:write at the install
  # level (approved at PR-C.5 pre-merge); identity-policy here just
  # narrows AWS-side access to the github-app-secret.
  environment_variables = merge(local.task_lambda_env, {
    GITHUB_APP_SECRET_ARN      = data.terraform_remote_state.shared.outputs.github_app_secret_arn
    GITHUB_APP_ID              = data.aws_ssm_parameter.github_app_id.value
    GITHUB_APP_INSTALLATION_ID = data.aws_ssm_parameter.github_app_installation_id.value
  })

  iam_grants = {
    dynamodb_read  = local.task_lambda_iam_grants.dynamodb_read
    dynamodb_write = local.task_lambda_iam_grants.dynamodb_write
    extra_statements = [
      {
        sid       = "GetGitHubAppSecret"
        actions   = ["secretsmanager:GetSecretValue"]
        resources = [data.terraform_remote_state.shared.outputs.github_app_secret_arn]
      },
      {
        sid       = "DecryptGitHubAppSecret"
        actions   = ["kms:Decrypt"]
        resources = [data.terraform_remote_state.shared.outputs.github_app_kms_key_arn]
        conditions = [
          {
            test     = "StringEquals"
            variable = "kms:EncryptionContext:SecretARN"
            values   = [data.terraform_remote_state.shared.outputs.github_app_secret_arn]
          },
        ]
      },
    ]
  }
}

module "task_wait_for_deploy" {
  source = "../../modules/lambda"

  function_name           = "ironforge-${var.environment}-wait-for-deploy"
  environment             = var.environment
  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn
  source_dir              = "${path.root}/../../../services/workflow/wait-for-deploy/dist"

  # PR-C.8: new polling task Lambda. Same GitHub App access shape as
  # trigger-deploy — listWorkflowRuns needs actions:read at the App
  # install level (already granted, implied by actions:write from
  # PR-C.5); identity-policy narrows AWS-side access to the github-
  # app-secret with EncryptionContext binding.
  environment_variables = merge(local.task_lambda_env, {
    GITHUB_APP_SECRET_ARN      = data.terraform_remote_state.shared.outputs.github_app_secret_arn
    GITHUB_APP_ID              = data.aws_ssm_parameter.github_app_id.value
    GITHUB_APP_INSTALLATION_ID = data.aws_ssm_parameter.github_app_installation_id.value
  })

  iam_grants = {
    dynamodb_read  = local.task_lambda_iam_grants.dynamodb_read
    dynamodb_write = local.task_lambda_iam_grants.dynamodb_write
    extra_statements = [
      {
        sid       = "GetGitHubAppSecret"
        actions   = ["secretsmanager:GetSecretValue"]
        resources = [data.terraform_remote_state.shared.outputs.github_app_secret_arn]
      },
      {
        sid       = "DecryptGitHubAppSecret"
        actions   = ["kms:Decrypt"]
        resources = [data.terraform_remote_state.shared.outputs.github_app_kms_key_arn]
        conditions = [
          {
            test     = "StringEquals"
            variable = "kms:EncryptionContext:SecretARN"
            values   = [data.terraform_remote_state.shared.outputs.github_app_secret_arn]
          },
        ]
      },
    ]
  }
}

module "task_finalize" {
  source = "../../modules/lambda"

  function_name           = "ironforge-${var.environment}-finalize"
  environment             = var.environment
  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn
  source_dir              = "${path.root}/../../../services/workflow/finalize/dist"
  environment_variables   = local.task_lambda_env
  iam_grants              = local.task_lambda_iam_grants
}

module "task_cleanup_on_failure" {
  source = "../../modules/lambda"

  function_name           = "ironforge-${var.environment}-cleanup-on-failure"
  environment             = var.environment
  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn
  source_dir              = "${path.root}/../../../services/workflow/cleanup-on-failure/dist"

  # Phase 1.5 destroy chain: cleanup-on-failure synchronously invokes
  # run-terraform with action="destroy", deletes the GitHub repo via the
  # App, and deletes the tfstate file. 10-min timeout matches
  # run-terraform's bound (the synchronous lambda invoke can't outlive
  # the invoked function). CloudFront-distribution destroys may exceed
  # 10 min and fall back to manual cleanup — known Phase 2+ refactor.
  timeout_seconds = 600

  # Env vars: existing task_lambda_env (DDB + powertools + log level)
  # PLUS the destroy-chain set (GitHub App credentials, run-terraform
  # function name for the lambda invoke, tfstate bucket name).
  environment_variables = merge(local.task_lambda_env, {
    RUN_TERRAFORM_LAMBDA_NAME  = module.task_run_terraform.function_name
    TFSTATE_BUCKET             = data.terraform_remote_state.shared.outputs.tfstate_dev_bucket_name
    GITHUB_APP_SECRET_ARN      = data.terraform_remote_state.shared.outputs.github_app_secret_arn
    GITHUB_APP_ID              = data.aws_ssm_parameter.github_app_id.value
    GITHUB_APP_INSTALLATION_ID = data.aws_ssm_parameter.github_app_installation_id.value
    GITHUB_ORG_NAME            = data.aws_ssm_parameter.github_org_name.value
  })

  iam_grants = {
    dynamodb_read  = local.task_lambda_iam_grants.dynamodb_read
    dynamodb_write = local.task_lambda_iam_grants.dynamodb_write
    extra_statements = [
      # Phase 1 — invoke run-terraform with action="destroy".
      {
        sid       = "InvokeRunTerraformForDestroy"
        actions   = ["lambda:InvokeFunction"]
        resources = [module.task_run_terraform.function_arn]
      },
      # Phase 2 — GitHub App auth (mirror create-repo's grants exactly).
      {
        sid       = "GetGitHubAppSecret"
        actions   = ["secretsmanager:GetSecretValue"]
        resources = [data.terraform_remote_state.shared.outputs.github_app_secret_arn]
      },
      {
        sid       = "DecryptGitHubAppSecret"
        actions   = ["kms:Decrypt"]
        resources = [data.terraform_remote_state.shared.outputs.github_app_kms_key_arn]
        conditions = [
          {
            test     = "StringEquals"
            variable = "kms:EncryptionContext:SecretARN"
            values   = [data.terraform_remote_state.shared.outputs.github_app_secret_arn]
          },
        ]
      },
      # Phase 3 — tfstate file deletion. Scoped to services/* prefix
      # (same as run-terraform's S3TFStateObjectAccess).
      {
        sid       = "DeleteTFStateForService"
        actions   = ["s3:DeleteObject"]
        resources = ["${data.terraform_remote_state.shared.outputs.tfstate_dev_bucket_arn}/services/*"]
      },
    ]
  }
}

# ===========================================================================
# Phase 1.5 deprovisioning Lambdas
# ===========================================================================
#
# Two new task Lambdas land alongside the provisioning fleet:
#
#   delete-external-resources — State 2 happy path of the deprovisioning
#     SFN. Deletes GitHub repo + tfstate via @ironforge/destroy-chain
#     primitives, then transitions Service deprovisioning -> archived
#     and Job running -> succeeded. Throws on any sub-op failure so
#     SFN's Catch routes to DeprovisionFailed.
#
#   deprovision-failed — terminal-failure handler for the deprovisioning
#     SFN. Writes Service deprovisioning -> failed (failedWorkflow=
#     "deprovisioning") and Job running -> failed. Does NOT re-run the
#     destroy chain (would mask original failure / hit inconsistent
#     partial-destroy state).
#
# State 1 of the deprovisioning SFN reuses module.task_run_terraform
# above with action="destroy" injected via SFN Parameters.

module "task_delete_external_resources" {
  source = "../../modules/lambda"

  function_name           = "ironforge-${var.environment}-delete-external-resources"
  environment             = var.environment
  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn
  source_dir              = "${path.root}/../../../services/workflow/delete-external-resources/dist"

  # Env vars: DDB + GitHub App identifiers (for repo deletion) + tfstate
  # bucket (for state-file deletion). Mirrors cleanup-on-failure's env
  # set minus RUN_TERRAFORM_LAMBDA_NAME — this Lambda does NOT invoke
  # run-terraform (State 1 of the SFN owns that).
  environment_variables = merge(local.task_lambda_env, {
    TFSTATE_BUCKET             = data.terraform_remote_state.shared.outputs.tfstate_dev_bucket_name
    GITHUB_APP_SECRET_ARN      = data.terraform_remote_state.shared.outputs.github_app_secret_arn
    GITHUB_APP_ID              = data.aws_ssm_parameter.github_app_id.value
    GITHUB_APP_INSTALLATION_ID = data.aws_ssm_parameter.github_app_installation_id.value
    GITHUB_ORG_NAME            = data.aws_ssm_parameter.github_org_name.value
  })

  iam_grants = {
    dynamodb_read  = local.task_lambda_iam_grants.dynamodb_read
    dynamodb_write = local.task_lambda_iam_grants.dynamodb_write
    extra_statements = [
      # GitHub App auth — same shape as create-repo / cleanup-on-failure.
      {
        sid       = "GetGitHubAppSecret"
        actions   = ["secretsmanager:GetSecretValue"]
        resources = [data.terraform_remote_state.shared.outputs.github_app_secret_arn]
      },
      {
        sid       = "DecryptGitHubAppSecret"
        actions   = ["kms:Decrypt"]
        resources = [data.terraform_remote_state.shared.outputs.github_app_kms_key_arn]
        conditions = [
          {
            test     = "StringEquals"
            variable = "kms:EncryptionContext:SecretARN"
            values   = [data.terraform_remote_state.shared.outputs.github_app_secret_arn]
          },
        ]
      },
      # tfstate file deletion. Scoped to services/* prefix (same as
      # run-terraform's S3TFStateObjectAccess and cleanup-on-failure's
      # DeleteTFStateForService).
      {
        sid       = "DeleteTFStateForService"
        actions   = ["s3:DeleteObject"]
        resources = ["${data.terraform_remote_state.shared.outputs.tfstate_dev_bucket_arn}/services/*"]
      },
    ]
  }
}

module "task_deprovision_failed" {
  source = "../../modules/lambda"

  function_name           = "ironforge-${var.environment}-deprovision-failed"
  environment             = var.environment
  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn
  source_dir              = "${path.root}/../../../services/workflow/deprovision-failed/dist"

  # DDB-only Lambda. No external resources touched — the destroy chain
  # is not re-run from this terminal handler (see the source comment in
  # services/workflow/deprovision-failed/src/handle-event.ts for why).
  environment_variables = local.task_lambda_env
  iam_grants            = local.task_lambda_iam_grants
}

# ===========================================================================
# State machines (provisioning + deprovisioning)
# ===========================================================================
# Module instance name is historical — it now houses BOTH state machines
# (provisioning + deprovisioning) under one shared SFN role since both
# share IAM patterns and security posture (Ironforge platform-side
# control plane). Renaming the module instance would force Terraform to
# destroy/recreate the provisioning state machine without a `moved`
# block; not worth the diff noise for a cosmetic rename.

module "provisioning_state_machine" {
  source = "../../modules/step-functions"

  environment = var.environment

  provisioning_lambda_arns = {
    validate_inputs     = module.task_validate_inputs.function_arn
    create_repo         = module.task_create_repo.function_arn
    generate_code       = module.task_generate_code.function_arn
    run_terraform       = module.task_run_terraform.function_arn
    wait_for_cloudfront = module.task_wait_for_cloudfront.function_arn
    trigger_deploy      = module.task_trigger_deploy.function_arn
    wait_for_deploy     = module.task_wait_for_deploy.function_arn
    finalize            = module.task_finalize.function_arn
    cleanup_on_failure  = module.task_cleanup_on_failure.function_arn
  }

  deprovisioning_lambda_arns = {
    # State 1 reuses run-terraform with action="destroy" injected at the
    # SFN Parameters layer — same Lambda ARN as the provisioning bundle.
    run_terraform             = module.task_run_terraform.function_arn
    delete_external_resources = module.task_delete_external_resources.function_arn
    deprovision_failed        = module.task_deprovision_failed.function_arn
  }
}

# ===========================================================================
# API Lambda
# ===========================================================================
# PR-C.2 expands the API Lambda's surface from read-only (PR-B.3) to
# include POST /api/services. New IAM:
#   - dynamodb_write on the env table for Service+Job creation +
#     IdempotencyRecord cache writes + kickoff transitions
#   - extra_statements for states:StartExecution scoped to the
#     provisioning state machine ARN
# Boundary (lambda-baseline) gained dynamodb:TransactWriteItems in this
# PR — required for the create-Service+create-Job atomic write.
#
# CI must run `pnpm -F @ironforge/api build` before `terraform plan` so
# services/api/dist/ exists when archive_file zips it.
module "api_lambda" {
  source = "../../modules/lambda"

  function_name = "ironforge-${var.environment}-api"
  environment   = var.environment

  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn

  source_dir = "${path.root}/../../../services/api/dist"

  environment_variables = {
    DYNAMODB_TABLE_NAME              = module.dynamodb.table_name
    PROVISIONING_STATE_MACHINE_ARN   = local.state_machine_arn
    DEPROVISIONING_STATE_MACHINE_ARN = local.deprovisioning_state_machine_arn
    IRONFORGE_ENV                    = var.environment
    POWERTOOLS_SERVICE_NAME          = "ironforge-api"
    LOG_LEVEL                        = "INFO"
  }

  iam_grants = {
    dynamodb_read = [
      module.dynamodb.table_arn,
      "${module.dynamodb.table_arn}/index/*",
    ]
    dynamodb_write = [
      module.dynamodb.table_arn,
    ]
    extra_statements = [
      {
        sid       = "StartProvisioningExecution"
        actions   = ["states:StartExecution"]
        resources = [local.state_machine_arn]
      },
      {
        # Phase 1.5 — DELETE /api/services/:id kicks off the deprovisioning
        # state machine. Same naming convention as the provisioning ARN
        # constructed in locals (the step-functions module's deprovisioning
        # state machine resource uses the same name format).
        sid       = "StartDeprovisioningExecution"
        actions   = ["states:StartExecution"]
        resources = [local.deprovisioning_state_machine_arn]
      },
    ]
  }
}

# Per-env HTTP API. Per the convention codified in ADR-005's
# shared-resource-default exception logic: the JWT authorizer's
# Audience is env-specific (the env's Cognito client_id), and HTTP
# API authorizers bind at the API level (no stage-variable
# substitution in JwtConfiguration.Audience), so per-env audiences
# require per-env APIs. Custom domain support is intentionally
# deferred to a follow-up PR.
module "api_gateway" {
  source = "../../modules/api-gateway"

  api_name    = "ironforge-${var.environment}-api"
  environment = var.environment

  jwt_issuer   = data.terraform_remote_state.shared.outputs.cognito_issuer_url
  jwt_audience = data.terraform_remote_state.shared.outputs.cognito_client_ids[var.environment]

  lambda_invoke_arn    = module.api_lambda.function_invoke_arn
  lambda_function_name = module.api_lambda.function_name
}
