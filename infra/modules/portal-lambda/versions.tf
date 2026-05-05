terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source = "hashicorp/aws"
      # >= 5.70 ensures aws_cloudfront_origin_access_control supports
      # origin_access_control_origin_type = "lambda" (verified against
      # the v5.70.0-tagged docs); upper bound < 7.0 leaves headroom for
      # provider 6.x adoption when bundled with a deliberate review.
      version = ">= 5.70, < 7.0"
    }
  }
}
