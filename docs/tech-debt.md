# Tech Debt Ledger

Single source of truth for things we knowingly defer on Ironforge. When we ship something less-than-ideal (work around a bug, defer a refactor, accept a limitation), the entry lives here — not in commit messages, not in chat history, not in unwritten memory.

## How to use

When deferring something:

1. Add an entry to **Open** below under the relevant category (or create a new category).
2. Reference the entry from the inline code comment at the deferral site, e.g. `# See docs/tech-debt.md § "GSI hash_key / range_key deprecation".`
3. When the work is done, delete the entry and the inline reference.

## Entry format

Each entry has:

- **What** — one-line summary of the issue.
- **Why deferred** — why we shipped it as-is instead of fixing now.
- **When to revisit** — concrete trigger (date, milestone, condition).
- **Action** — what to do when revisiting.
- **Where** — code location(s) affected.

---

## Open

### S3 / IAM hardening

#### Prefix-scoped artifacts bucket policy (defense-in-depth)

- **What:** Add a bucket policy on the artifacts bucket that enforces prefix-scoped access at the bucket-policy level — beyond per-policy IAM scoping. Defense in depth.
- **Why deferred:** Not required for MVP. IAM-grant scoping is sufficient *if grants are correct*. The bucket policy adds a safety net for IAM mistakes (a Lambda role accidentally granted `${bucket_arn}/*` could otherwise read across env prefixes).
- **When to revisit:** When Ironforge has more than one Lambda role accessing the artifacts bucket, when the `IronforgePermissionBoundary` (Commit 10) is in place and we want belt-and-suspenders, or when a real cross-env access incident is detected.
- **Action:** Add an `aws_s3_bucket_policy` statement that requires the calling principal's session tag (or a per-env IAM path/role-name pattern) to match the env prefix being accessed. Test by attempting cross-prefix access from a dev role and confirming denial.
- **Where:** `infra/modules/artifacts/main.tf`.

### CloudFront / observability

#### CloudFront access logging not enabled

- **What:** CloudFront access logs are disabled on the portal distribution.
- **Why deferred:** Pre-launch (Phase 0). No real traffic to log. Logging adds an additional S3 logs bucket, lifecycle config, and (recommended) Athena/Glue setup for querying — not justified before there's traffic to debug.
- **When to revisit:** Once Phase 1 ships and real traffic flows. Required for debugging cache behavior, validating WAF effectiveness over time, and identifying abuse patterns that don't trip rate limits.
- **Action:** Enable `aws_cloudfront_distribution.portal.logging_config` pointing at a dedicated logs bucket (`ironforge-cloudfront-logs-<account-id>`). Configure 90-day S3 lifecycle expiration. Document in runbook how to query logs (Athena recommended).
- **Where:** `infra/modules/cloudfront-frontend/main.tf` (currently has an inline comment marking the deferral site).

### CI/CD

#### Separate OIDC role for app deploys (least privilege)

- **What:** App deploys (`.github/workflows/app-deploy.yml`) currently reuse the `ironforge-ci-apply` OIDC role, which has broad write perms across all Ironforge resources (`s3:*` on `ironforge-*`, `cloudfront:*` on `*`, etc.). App deploy actually needs only `s3:Put/Delete/ListBucket` on the portal bucket and `cloudfront:CreateInvalidation`/`GetInvalidation`/`ListDistributions`.
- **Why deferred:** Phase 0 deploys are infrequent. The shared `production` GitHub Environment gate provides a manual approval that catches surprise deploys. Adding a separate role + separate environment doubles OIDC bootstrap complexity for marginal benefit at current scale.
- **When to revisit:** When app deploys become frequent (Phase 1+ when the wizard UI is iterated on), when the app-deploy workflow gains responsibilities that should NOT have infra-write perms (e.g., post-deploy smoke checks), or when adding a less-friction approval flow for app changes.
- **Action:** Create `ironforge-ci-app-deploy` role scoped to `environment:app-deploy`, with permissions limited to: `s3:PutObject`/`DeleteObject`/`ListBucket` on `arn:aws:s3:::ironforge-portal-*`; `cloudfront:CreateInvalidation`/`GetInvalidation` on the portal distribution ARN; `cloudfront:ListDistributions` on `*` (account-wide read, needed for the alias→ID lookup). Update `.github/workflows/app-deploy.yml` to use the new role + a new GitHub Environment `app-deploy` (no required reviewer, optional shorter wait timer, branch=main). Document in `OIDC_BOOTSTRAP.md`.
- **Where:** `infra/OIDC_BOOTSTRAP.md`, `.github/workflows/app-deploy.yml`.

#### Split apply-dev into its own GitHub Environment with a lighter gate

- **What:** Both apply jobs (`apply-shared` and `apply-dev` in `.github/workflows/infra-apply.yml`) use the `production` environment, which means each merge requires two manual approvals — one for the shared composition, one for dev. The environments are bound to the same OIDC role trust because `production` is the only sub claim the apply role accepts.
- **Why deferred:** The "two approvals per merge" friction is small at current scale and the simpler one-environment model is easier to reason about. Splitting requires creating a new GitHub Environment, updating the apply role's trust policy to accept multiple sub claims, and documenting the split in `OIDC_BOOTSTRAP.md`.
- **When to revisit:** When merges become frequent (Phase 2+ when wizard iterations land regularly) and clicking approve twice becomes routine friction, or when the "blast radius differs per composition" framing becomes a portfolio talking point worth implementing concretely. Also revisit if a third composition (e.g., `staging`) is added and gating uniformity becomes burdensome.
- **Action:** Create a new GitHub Environment `dev-apply` with no required reviewer and a short wait timer (1–2 min for cancel window). Update `ironforge-ci-apply`'s trust policy to accept `sub` matching either `repo:Ricky-C/ironforge:environment:production` *or* `repo:Ricky-C/ironforge:environment:dev-apply` (use a `StringEquals` array, not a `StringLike` pattern — exact match preserves the security posture). Change `apply-dev` to declare `environment: dev-apply`. Update `infra/OIDC_BOOTSTRAP.md` Step 4 to document both sub claims and the rationale.
- **Where:** `.github/workflows/infra-apply.yml`, `infra/OIDC_BOOTSTRAP.md`.

### IAM / permission boundary

#### KMS permissions absent from the IronforgePermissionBoundary

- **What:** `IronforgePermissionBoundary` (`infra/modules/lambda-baseline/main.tf`) has no `kms:*` ALLOW statements. Lambdas that try to call KMS directly (e.g., `kms:Decrypt` on envelope-encrypted data) will be denied.
- **Why deferred:** Post-ADR-003, no Lambda directly calls KMS. AWS-managed encryption is handled transparently by data-plane services (DynamoDB, S3, SNS). Adding KMS perms speculatively risks the tag/alias condition pitfalls — boundary KMS conditions have inconsistent behavior across operations. Better to add them when there's a concrete requirement.
- **When to revisit:** When the first Lambda needs to call KMS directly. Most likely scenarios: Secrets Manager with a CMK (Phase 1 GitHub App private key), envelope-encrypted Lambda environment vars, or signed-payload verification.
- **Action:** Add `kms:Decrypt`, `kms:GenerateDataKey`, `kms:DescribeKey` to the boundary's ALLOW list. Scope to specific CMK ARNs via input variable from the modules that create them, OR use `kms:ResourceTag/ironforge-managed = true` if the universe of CMKs is broad — but verify the condition syntax against current AWS docs at write time. See `project_commit_10_kms_validation.md` memory for the gotchas.
- **Where:** `infra/modules/lambda-baseline/main.tf`.

### Terraform / AWS provider

#### GSI `hash_key` / `range_key` deprecation

- **What:** `hash_key` and `range_key` arguments on `global_secondary_index` blocks in `aws_dynamodb_table` are deprecated in AWS provider 6.x. **Verified by inspecting both schemas:** under our pinned `~> 5.70` (resolves to 5.100.0) the arguments are NOT deprecated; under 6.x they ARE deprecated, replaced by a `key_schema` nested block matching the AWS API shape. The IDE's terraform-ls fetches the latest registry schema (6.x), which is why warnings appear in the editor but not at apply time. Table-level `hash_key`/`range_key` remain non-deprecated in both versions; only the GSI/LSI nested-block versions are.
- **Why deferred:** Bumping to AWS provider 6.x is a major-version change with breaking changes elsewhere (not just DynamoDB GSI shape). Doing it as a "fix the IDE warning" task understates the scope. Our pinned 5.x doesn't emit the deprecation at apply time, so the underlying configuration is correct — only the editor noise is the artifact.
- **When to revisit:** Bundled with a deliberate AWS provider 5.x → 6.x bump, audited for breaking changes across all modules. Or when adding a new GSI (and we want to write it in the modern syntax from the start).
- **Action:** When bumping to 6.x, replace each `global_secondary_index` block's `hash_key`/`range_key` arguments with `key_schema` nested blocks. Verified target syntax:
  ```hcl
  global_secondary_index {
    name = "GSI1"
    key_schema {
      attribute_name = "GSI1PK"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "GSI1SK"
      key_type       = "RANGE"
    }
    projection_type = "ALL"
  }
  ```
  Confirm `terraform plan` shows no resource recreation — the schema change should be in-place.
- **Where:** `infra/modules/dynamodb/main.tf` (GSI1 definition).
