terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"

      # CloudFront-scoped WAF and ACM certs both require us-east-1.
      # Module callers must pass an aws.us_east_1 provider explicitly so
      # the regional dependency is enforced at the call site.
      configuration_aliases = [aws.us_east_1]
    }
  }
}
