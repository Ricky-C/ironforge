data "aws_caller_identity" "current" {}
data "aws_partition" "current" {}
data "aws_region" "current" {}

locals {
  secret_name    = "ironforge/github-app/private-key"
  ssm_param_path = "/ironforge/github-app"

  component_tags = {
    "ironforge-component" = "github-app-auth"
  }
}

# ---------------------------------------------------------------------------
# KMS — encrypts the GitHub App private key in Secrets Manager.
#
# CMK is justified per ADR-003 criteria 1 + 3: actual high-value secret
# (criterion 3) and fine-grained decrypt control via key-policy
# EncryptionContext binding (criterion 1, applied in the future commit
# that introduces the consuming Lambda role — see policy comment below).
#
# Tier 1 per ADR-003 § "CMK boundary tiering": single-resource CMK. The
# GitHub App private key is the entire blast radius of this key — no other
# resource shares it, and the consuming-principal set is narrow (the
# workflow Lambda that mints installation tokens).
# ---------------------------------------------------------------------------

resource "aws_kms_key" "github_app" {
  description             = "Encrypts the Ironforge GitHub App private key in Secrets Manager"
  deletion_window_in_days = 30
  enable_key_rotation     = true
  policy                  = data.aws_iam_policy_document.kms_key.json

  tags = merge(local.component_tags, {
    Name = "ironforge-github-app-private-key"
  })
}

resource "aws_kms_alias" "github_app" {
  name          = "alias/ironforge-github-app-private-key"
  target_key_id = aws_kms_key.github_app.id
}

data "aws_iam_policy_document" "kms_key" {
  # Standard root grant. Required so the account root retains full control
  # if the other statements are ever misconfigured (recovery path), AND so
  # IAM-based grants from consuming roles can resolve. Without this, even a
  # role with `kms:Decrypt` in its identity policy would be denied because
  # KMS requires the key policy to delegate to IAM.
  statement {
    sid    = "EnableRootAccountAccess"
    effect = "Allow"

    principals {
      type        = "AWS"
      identifiers = ["arn:${data.aws_partition.current.partition}:iam::${data.aws_caller_identity.current.account_id}:root"]
    }

    actions   = ["kms:*"]
    resources = ["*"]
  }

  # Consuming-principal grant for workflow Lambdas that mint GitHub App
  # installation tokens (create-repo, trigger-deploy, etc.). Activated in
  # PR-C.4b once the first consumer's role lands; gated on a non-empty
  # `var.workflow_lambda_role_arns` so this module continues to apply
  # cleanly in environments without consumers (the original PR #41
  # standalone-shared invariant).
  #
  # `kms:EncryptionContext:SecretARN` binds the grant to this specific
  # secret — even with `kms:Decrypt` on the CMK ARN, a Lambda role can't
  # decrypt some other secret that happens to use the same key. The ARN
  # is stable (manually created at bootstrap, imported by Terraform) so
  # `StringEquals` is exact-match, not a wildcard.
  #
  # `kms:DescribeKey` is intentionally NOT granted — Secrets Manager-
  # mediated decrypt doesn't require it, and the boundary's KMS allow
  # (ADR-006 amendment) only covers `kms:Decrypt`. If a future consumer
  # needs DescribeKey, the boundary needs widening too — see ADR-006
  # § Amendments for the precedent.
  dynamic "statement" {
    for_each = length(var.workflow_lambda_role_arns) > 0 ? [1] : []
    content {
      sid    = "AllowWorkflowLambdaDecrypt"
      effect = "Allow"

      principals {
        type        = "AWS"
        identifiers = var.workflow_lambda_role_arns
      }

      actions   = ["kms:Decrypt"]
      resources = ["*"]

      condition {
        test     = "StringEquals"
        variable = "kms:EncryptionContext:SecretARN"
        values   = [aws_secretsmanager_secret.github_app_private_key.arn]
      }
    }
  }
}

# ---------------------------------------------------------------------------
# Secrets Manager — METADATA ONLY.
#
# Per `feedback_secrets_via_import.md`: the secret VALUE never flows through
# Terraform. It is created via `aws secretsmanager create-secret` against a
# local .pem at bootstrap time, this resource is `terraform import`-ed
# against the now-existing secret, and rotation uses
# `aws secretsmanager update-secret`. We deliberately do NOT declare
# `aws_secretsmanager_secret_version` — that would route the value through
# tfvars → state → plan → apply, four leak channels.
#
# Bootstrap procedure: `docs/runbook.md` § "GitHub App private key — initial
# install".
#
# Rotation procedure: `docs/runbook.md` § "GitHub App private key rotation".
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "github_app_private_key" {
  name        = local.secret_name
  description = "Ironforge GitHub App private key (.pem) for repo creation in the ironforge-svc org. Value managed out-of-band via aws secretsmanager update-secret; this resource manages metadata only."

  kms_key_id = aws_kms_key.github_app.arn

  recovery_window_in_days = 30

  tags = local.component_tags
}

# ---------------------------------------------------------------------------
# SSM Parameter Store — non-sensitive GitHub App configuration.
#
# These three parameters store the org name, App ID, and Installation ID.
# All three are non-secret tenant-specific identifiers — they appear in
# GitHub installation URLs, webhook payloads, and any audit trail of the
# App's activity. They are not security-relevant on their own.
#
# The sensitive material (the private key) lives in Secrets Manager and
# follows the manual-create-then-import pattern documented in the secret
# resource above and in `feedback_secrets_via_import.md`. If a future
# GitHub App integration requires a webhook signing secret, OAuth client
# secret, or any other sensitive value, it MUST follow that same manual-
# create-then-import pattern — NOT be added here as a Terraform-managed
# `SecureString`. Mixing the two patterns drifts the security model
# across this module: an auditor reading the module would have to inspect
# every resource to know which values pass through state and which don't.
#
# Per `feedback_env_specific_identifiers.md`, these non-secret values flow
# in via gitignored terraform.tfvars rather than tracked Terraform vars.
# Consuming Lambdas read them at runtime via `ssm:GetParameter`, IAM-
# scopable to the `/ironforge/github-app/*` path prefix.
# ---------------------------------------------------------------------------

resource "aws_ssm_parameter" "org_name" {
  name        = "${local.ssm_param_path}/org-name"
  description = "GitHub organization that holds Ironforge-provisioned repos."
  type        = "String"
  value       = var.org_name

  tags = local.component_tags
}

resource "aws_ssm_parameter" "app_id" {
  name        = "${local.ssm_param_path}/app-id"
  description = "Ironforge GitHub App's App ID. Used to mint installation tokens."
  type        = "String"
  value       = var.app_id

  tags = local.component_tags
}

resource "aws_ssm_parameter" "installation_id" {
  name        = "${local.ssm_param_path}/installation-id"
  description = "Installation ID of the Ironforge GitHub App in the ironforge-svc org. Used in installation-token API calls."
  type        = "String"
  value       = var.installation_id

  tags = local.component_tags
}
