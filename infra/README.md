# Ironforge Infrastructure

Terraform code for Ironforge's own AWS infrastructure. User-provisioned service Terraform lives in `/templates/<template>/terraform/` — that separation is intentional.

## Layout

```
infra/
├── modules/           # Reusable Terraform modules
└── envs/
    ├── dev/           # Development environment composition
    └── prod/          # Production environment composition
```

## Bootstrap

Two one-time manual setup steps must complete before any CI-driven Terraform can run. They live outside Terraform because Terraform itself depends on them.

1. **Terraform remote state** — S3 bucket and DynamoDB lock table.
2. **GitHub Actions OIDC** — IAM OIDC provider and CI assume-role.

Step-by-step CLI commands land in `BOOTSTRAP.md` in a later commit.

## Conventions

Authoritative reference: `/CLAUDE.md` ("Terraform Conventions" and "AWS Resource Conventions"). Summary:

- All Ironforge-managed resources prefixed `ironforge-`.
- All resources in `us-east-1`.
- Required tags on every resource: `ironforge-managed=true`, `ironforge-component=<name>`, `ironforge-environment=<env>`.
- State in S3 with DynamoDB locking, per environment.
- `required_version` and `required_providers` pinned in every root module.
- Local resource names use `snake_case` (e.g., `resource "aws_s3_bucket" "site_content"`).
