terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"

      # ACM certificates for CloudFront must be issued in us-east-1.
      # Module callers must pass an aws.us_east_1 provider explicitly so
      # this regional dependency is enforced at the call site, not inferred.
      configuration_aliases = [aws.us_east_1]
    }
  }
}
