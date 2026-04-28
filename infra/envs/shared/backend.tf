terraform {
  # Partial backend config: bucket name comes from backend.hcl (gitignored).
  # Initialize with: terraform init -backend-config=backend.hcl
  backend "s3" {
    key            = "ironforge/shared/account/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    kms_key_id     = "alias/ironforge-terraform-state"
    dynamodb_table = "ironforge-terraform-locks"
  }
}
