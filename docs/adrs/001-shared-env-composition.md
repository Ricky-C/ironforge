# ADR 001 — Shared (account-level) Terraform composition

**Status:** Accepted

**Date:** 2026-04-27

## Context

Ironforge has a clear per-environment infrastructure pattern: dev and prod each get their own Terraform composition (`infra/envs/dev/`, `infra/envs/prod/`) with separate state files, KMS keys, DynamoDB tables, etc.

Some resources, however, exist *once per AWS account* and are shared across environments:

- AWS Budgets and Cost Anomaly Detection — account-scoped, single budget per name.
- The deny IAM policy attached by the budget action — referenced by both dev and prod targets.
- The cost-alerts SNS topic — single subscriber, single inbox to confirm.
- The GitHub Actions OIDC provider (added later) — account-scoped, single trust relationship.
- Future: account-level audit logging, AWS Config recorders, CloudTrail.

These resources don't fit cleanly into either dev or prod. Putting them in `dev` is wrong because their lifecycle is decoupled from dev. Duplicating them across both compositions causes name collisions and double-spending.

## Decision

Introduce a third Terraform composition: `infra/envs/shared/`. It holds account-level resources that exist once per AWS account regardless of environment.

- Tag value: `ironforge-environment = "shared"` (matches the Terraform-state bootstrap convention).
- State key: `ironforge/shared/<component>/terraform.tfstate`.
- Provider region: `us-east-1` (same as dev/prod).
- Provider `default_tags`: hardcodes `ironforge-environment = "shared"` rather than variable-driven, since the value never varies for this composition.

The composition is applied independently of dev/prod. Resources here are not duplicated in `dev` or `prod` compositions.

## Consequences

**Positive:**

- Account-level resources have an unambiguous home.
- No name collisions or duplicate spend.
- Future account-scoped infra (OIDC provider, audit logging, AWS Config) plugs in cleanly.
- Tag-based cost attribution remains coherent: `shared` resources are visibly account-level.

**Negative:**

- Three Terraform compositions to maintain instead of two.
- Slightly more cognitive overhead: contributors must decide whether new infra is per-env or shared.
- Cross-composition references happen by string name (e.g., the budget action's `target_roles` list takes role *names* defined in dev/prod), not by Terraform reference. There is no `module.dev.role_name` available across compositions.

**Trade-offs considered and rejected:**

- *Single account-wide composition* (no dev/prod split). Sacrifices env isolation; conflicts with CLAUDE.md's per-env convention.
- *Account-level resources in `dev`*. Wrong lifecycle coupling — destroying dev would destroy budgets.
- *Account-level resources duplicated in both `dev` and `prod`*. Name collisions; duplicate budget tracking would alert twice and double-attribute spend.
- *Workspaces instead of separate directories*. Workspace-based isolation is harder to reason about and less explicit; per-directory compositions are the dominant Terraform pattern for this scale.

## Composition guide

When writing new Terraform, decide which composition based on this rule of thumb:

- **Per-env** (lives in `dev` *and* `prod`): things the user or environment-specific Lambdas interact with directly. Examples: DynamoDB tables, S3 buckets, Cognito user pools, API Gateway, the CloudFront distribution serving the portal, individual Lambda functions, Step Functions state machines.
- **Shared** (lives in `shared` only): things that exist once per AWS account. Examples: Budgets, Cost Anomaly Detection, OIDC providers, account-level service-linked roles, AWS Config recorders, account-wide CloudTrail, deny policies that reference per-env roles by name.

When in doubt: if the resource has a globally unique name within the AWS account and you'd never want two of it, it's shared.
