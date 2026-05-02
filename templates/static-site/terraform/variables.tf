variable "service_name" {
  description = "User-supplied service name (3-63 lowercase alphanumeric + hyphens, DNS-label compliant). Drives the subdomain, the bucket name, the GitHub repo name, and the deploy role name. Immutable after creation. See packages/shared-types/src/service.ts ServiceNameSchema for the canonical validation."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$", var.service_name)) && length(var.service_name) >= 3 && length(var.service_name) <= 63
    error_message = "service_name must be 3-63 chars, lowercase alphanumeric + hyphens, not starting or ending with hyphen."
  }
}

variable "service_id" {
  description = "Ironforge service id (UUID v4). Used for tagging only — resource names use service_name. Lets operators reverse-lookup AWS resources to the originating Service entity."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", var.service_id))
    error_message = "service_id must be a UUID."
  }
}

variable "owner_id" {
  description = "Cognito sub of the service owner. Used for tagging only (ironforge-owner)."
  type        = string
}

variable "environment" {
  description = "Deployment environment (dev or prod). Used in tags. Resource names do NOT include the env prefix — provisioned-resource naming uses the ironforge-svc- prefix per CLAUDE.md."
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be dev or prod."
  }
}

variable "aws_account_id" {
  description = "12-digit AWS account ID. Used in IAM trust policy ARNs and the deploy role ARN substituted into the user's deploy.yml at code-generation time."
  type        = string

  validation {
    condition     = can(regex("^[0-9]{12}$", var.aws_account_id))
    error_message = "aws_account_id must be exactly 12 digits."
  }
}

variable "wildcard_cert_arn" {
  description = "ARN of the apex+wildcard ACM certificate covering *.ironforge.rickycaballero.com. Read from the shared composition's dns_certificate_arn output. The cert is shared across every provisioned service — see infra/modules/dns/main.tf for the design rationale and docs/tech-debt.md for the per-service-cert deferral."
  type        = string
}

variable "hosted_zone_id" {
  description = "Route53 hosted zone ID for ironforge.rickycaballero.com. Read from the shared composition's dns_hosted_zone_id output."
  type        = string
}

variable "domain_name" {
  description = "Base domain (e.g., ironforge.rickycaballero.com). The provisioned subdomain is <service_name>.<domain_name>. Variable rather than hardcoded so the same template can be exercised against a stand-in zone in test environments."
  type        = string
}

variable "github_org" {
  description = "GitHub organization that holds Ironforge-provisioned repos (e.g., ironforge-svc). The deploy role's trust policy scopes to repo:<github_org>/<service_name>:*."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z0-9][a-zA-Z0-9-]*$", var.github_org)) && length(var.github_org) <= 39
    error_message = "github_org must match GitHub's org-name rules (alphanumeric and hyphens, max 39 chars)."
  }
}

variable "github_oidc_provider_arn" {
  description = "ARN of the account-level GitHub Actions OIDC provider (token.actions.githubusercontent.com). Account-bootstrap resource — created out-of-band, consumed here. Lets the deploy role's trust policy reference the provider without a data source lookup at apply time."
  type        = string
}

variable "permission_boundary_arn" {
  description = "ARN of IronforgePermissionBoundary. Attached to the deploy role per CLAUDE.md. Read from shared composition's permission_boundary_arn output."
  type        = string
}
