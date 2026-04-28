provider "aws" {
  region = "us-east-1"

  # Shared composition holds account-level resources. Environment tag is
  # hardcoded because every resource here is by definition cross-env.
  default_tags {
    tags = {
      "ironforge-managed"     = "true"
      "ironforge-environment" = "shared"
    }
  }
}
