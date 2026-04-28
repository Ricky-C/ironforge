provider "aws" {
  region = var.aws_region

  # Component tag is set per-module/resource since each component differs.
  # Managed and environment are constant across this env composition.
  default_tags {
    tags = {
      "ironforge-managed"     = "true"
      "ironforge-environment" = var.environment
    }
  }
}
