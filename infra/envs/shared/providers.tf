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

# Aliased us-east-1 provider for modules that explicitly require us-east-1
# (e.g., ACM certs for CloudFront, Lambda@Edge). Region is identical to the
# default — this alias is a CONTRACT making the regional dependency explicit
# at module call sites that depend on it.
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"

  default_tags {
    tags = {
      "ironforge-managed"     = "true"
      "ironforge-environment" = "shared"
    }
  }
}
