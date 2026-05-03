terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source                = "hashicorp/aws"
      version               = ">= 5.0, < 7.0"
      configuration_aliases = [aws.us_east_1]
    }
  }

  # No backend block. Per ADR-009 § "Why dedicated state bucket" plus the
  # PR-C.6 locked execution model, this template is invoked as a CHILD
  # MODULE by the run-terraform Lambda's per-job wrapper. Terraform
  # forbids backend blocks in non-root modules — backend declaration
  # belongs in the wrapper, which the run-terraform Lambda generates at
  # invocation time and configures via -backend-config flags pointing at
  # s3://ironforge-tfstate-<env>-<account>/services/<service-id>/
  # terraform.tfstate.
  #
  # Operators wanting to plan against this template directly (without
  # going through run-terraform) need to wrap it in their own root
  # module with their own backend declaration. See docs/runbook.md §
  # "Recovery: re-run a stuck terraform apply" for the wrapper shape.
}
