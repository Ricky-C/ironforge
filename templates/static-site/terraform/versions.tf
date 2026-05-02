terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = ">= 5.0, < 7.0"
      configuration_aliases = [aws.us_east_1]
    }
  }

  # Partial backend configuration — all values supplied via -backend-config
  # at terraform init time by the run-terraform Lambda. Per ADR-009 §
  # "Why dedicated state bucket": per-service state lives at
  # s3://ironforge-tfstate-<env>-<account>/services/<service-id>/
  # terraform.tfstate, encrypted by the env's tfstate CMK.
  #
  # The run-terraform Lambda passes (per invocation):
  #   -backend-config="bucket=ironforge-tfstate-<env>-<account>"
  #   -backend-config="key=services/<service-id>/terraform.tfstate"
  #   -backend-config="region=us-east-1"
  #   -backend-config="encrypt=true"
  #   -backend-config="kms_key_id=<env-tfstate-cmk-arn>"
  #
  # Empty backend block lets the same template apply against any
  # backend config the caller supplies — required for per-service
  # state storage where the state path varies per invocation.
  backend "s3" {}
}
