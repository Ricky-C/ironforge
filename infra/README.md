# Ironforge Infrastructure

Terraform code for Ironforge's own AWS infrastructure. User-provisioned service Terraform lives in `/templates/<template>/terraform/` — that separation is intentional.

## Layout

```
infra/
├── BOOTSTRAP.md       # One-time AWS resource bootstrap (KMS, S3, DDB)
├── modules/           # Reusable Terraform modules
└── envs/
    ├── dev/           # Development environment composition
    ├── prod/          # Production environment composition
    └── shared/        # Account-level resources (budgets, OIDC, etc.) — see ADR-001
```

## First-time setup

If this is the first time anyone is running Terraform against this account, complete the bootstrap first: see `BOOTSTRAP.md`. It creates the resources Terraform itself depends on (state bucket, lock table, KMS key) — these can't be Terraform-managed without a circular dependency.

A second one-time bootstrap (GitHub Actions OIDC) lands alongside the CI workflows in a later commit.

## Daily usage

All Terraform commands run from inside an env directory.

```bash
cd infra/envs/dev

# First time only: copy the example and fill in your AWS account ID
cp backend.hcl.example backend.hcl
# edit backend.hcl

# Use a named AWS profile (no credentials hardcoded in Terraform)
export AWS_PROFILE=<your-ironforge-profile>

# Init with partial backend config
terraform init -backend-config=backend.hcl

# Plan / apply
cp terraform.tfvars.example terraform.tfvars
terraform plan
terraform apply
```

`backend.hcl` and `terraform.tfvars` are gitignored — they hold environment-specific values that don't belong in source control. `backend.hcl.example` and `terraform.tfvars.example` are the committed templates.

## Conventions

Authoritative reference: `/CLAUDE.md` ("Terraform Conventions" and "AWS Resource Conventions"). Summary:

- All Ironforge-managed resources prefixed `ironforge-`.
- All resources in `us-east-1`.
- Required tags on every resource: `ironforge-managed=true`, `ironforge-component=<name>`, `ironforge-environment=<env>`.
- State in S3 with DynamoDB locking, key prefix `ironforge/<env>/<component>/`.
- `required_version` and `required_providers` pinned in every root module.
- Local resource names use `snake_case` (e.g., `resource "aws_s3_bucket" "site_content"`).
