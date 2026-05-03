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

#### Re-enable artifacts cross-env bucket policy after refresh-cascade redesign

> **Read this entry alongside `docs/postmortems/2026-04-bucket-policy-refresh-cascade.md`.** The postmortem captures the full diagnostic record; this entry captures the actionable plan. The mechanism behind the cascade is unidentified; the redesign procedure below does not assume otherwise.

- **What:** `data.aws_iam_policy_document.artifacts` in `infra/modules/artifacts/main.tf` currently has only the `DenyInsecureTransport` statement. The cross-env defense-in-depth statements (`DenyCrossEnvObjectAccess` and `DenyCrossEnvListing`) were temporarily disabled after PR #35 and PR #38 reproduced a refresh-cascade incident: when those statements are present in AWS, the next apply's refresh produces `# bucket has been deleted` even though the bucket exists, triggers cascading destroys of the 5 sub-resources, and fails at bucket recreate with `BucketAlreadyExists`. Mechanism unidentified after extensive CloudTrail diagnostics.
- **Why deferred:** Phase 0 has no Lambda consumers writing to the bucket — defense-in-depth value of the cross-env scope is currently zero (nothing to defend against). The recovery loop's cost (state divergence, destroyed sub-resources including the public-access-block, hours of incident response) is non-zero and reproduces every time the policy lands. Disabling until we understand the mechanism is the right trade.
- **When to revisit:** Before the first Phase 1 Lambda gets `${bucket_arn}/*` in its inline policy by mistake (i.e., the threat the cross-env scope defends against actually exists). Practically: Phase 1 work that adds a Lambda consuming the artifacts bucket should NOT land without the redesigned cross-env policy proven stable.
- **Action — redesign, not tweak:**
  1. **Split deny statements by resource shape.** One statement targets object-level actions with an explicit action enumeration (`s3:GetObject*`, `s3:PutObject*`, `s3:DeleteObject*`, `s3:RestoreObject`, `s3:AbortMultipartUpload`, `s3:CreateMultipartUpload`, `s3:GetObjectVersion*`, `s3:PutObjectVersion*`, `s3:GetObjectAcl`, `s3:PutObjectAcl`, `s3:GetObjectTagging`, `s3:PutObjectTagging`, `s3:DeleteObjectTagging`, `s3:GetObjectAttributes` — verify exact list against the AWS service authorization reference at the time of redesign). Bucket-level operations are NOT in this statement.
  2. **Bucket-level scoping** (if needed at all): rely on identity-side enforcement — the permission boundary + per-Lambda inline policies — rather than bucket-policy NotResource constructs that may interact with refresh in non-obvious ways.
  3. **Or move the cross-env enforcement off the bucket policy entirely.** A permission boundary deny (per-Lambda or shared boundary) operates at the IAM evaluation layer, where terraform refresh isn't subject to the same code path. This may be the cleaner fix.
- **Action — empirical-refresh-stability gate before merge (mandatory):** Static analysis is what cleared PR #34's policy and got us into this incident. Don't repeat. The redesign PR's apply procedure must include:
  1. Apply the redesigned policy on a feature branch against the shared composition (post-recovery, i.e., starting from the current policy-disabled state).
  2. Wait for apply to complete cleanly.
  3. Run `terraform plan` against the existing state — same composition, no config changes, just plan.
  4. **Confirm the plan output is `No changes. Your infrastructure matches the configuration.`** Zero resources marked "deleted", "+ create", or "must be replaced" due to refresh drift.
  5. If any resource shows refresh drift in step 4, the redesign reproduced the bug — do not merge. Iterate.
  6. Only after step 4 returns clean does the redesign PR get approved for merge.
- **Action — investigation tasks (to identify the actual mechanism):** When the redesign session begins, capture the cause so this doesn't recur with a different shape:
  1. Run `terraform apply` with `TF_LOG=DEBUG` set, against a dev environment with the previous (broken) cross-env policy in place. Capture the full HTTP API call/response sequence during refresh. Identify which response triggers the "deleted" interpretation.
  2. Review terraform-aws-provider source for `aws_s3_bucket` Read function — specifically the drift-detection logic. Identify what kinds of API responses are interpreted as "resource gone."
  3. Check the AWS provider GitHub issue tracker for similar reports involving `${aws:PrincipalTag/...}` substitution in bucket policies and refresh false-positives. Document any matching issue + workaround.
- **Where:** `infra/modules/artifacts/main.tf` (the inline comment block in `data.aws_iam_policy_document.artifacts` marks the deferral site); `docs/adrs/006-permission-boundary.md` § "What we lose" (mitigation #3 reverted from "in-place" to "deferred"); `docs/postmortems/2026-04-bucket-policy-refresh-cascade.md` (full incident record).

### CloudFront / observability

#### CloudFront access logging not enabled

- **What:** CloudFront access logs are disabled on the portal distribution.
- **Why deferred:** Pre-launch (Phase 0). No real traffic to log. Logging adds an additional S3 logs bucket, lifecycle config, and (recommended) Athena/Glue setup for querying — not justified before there's traffic to debug.
- **When to revisit:** Once Phase 1 ships and real traffic flows. Required for debugging cache behavior, validating WAF effectiveness over time, and identifying abuse patterns that don't trip rate limits.
- **Action:** Enable `aws_cloudfront_distribution.portal.logging_config` pointing at a dedicated logs bucket (`ironforge-cloudfront-logs-<account-id>`). Configure 90-day S3 lifecycle expiration. Document in runbook how to query logs (Athena recommended).
- **Where:** `infra/modules/cloudfront-frontend/main.tf` (currently has an inline comment marking the deferral site).

#### Expand portal Content-Security-Policy beyond `frame-ancestors 'none'`

- **What:** `aws_cloudfront_response_headers_policy.portal` currently sets a single-directive CSP: `frame-ancestors 'none'`. That covers clickjacking but doesn't restrict `script-src` / `style-src` / `connect-src` / `img-src` / `font-src` — which is the bulk of what CSP is for. The single directive shipped now to replace legacy `X-Frame-Options: DENY` without committing to a full CSP that has to be tied to the actual Next.js bundle's external dependencies.
- **Why deferred:** A full CSP requires enumerating every origin the portal loads from — the exact set depends on Phase 1's auth wiring (Cognito hosted UI domain), API surface (API Gateway origin or custom domain), and any CDN-hosted assets (fonts, libraries). Defining the directive set before those land would either be wrong or require revising on every Phase 1 commit that adds a new dependency. Better to expand once when the dependency set is stable.
- **When to revisit:** When the portal first authenticates traffic against Cognito and calls the API Gateway. That's the moment the `script-src` / `connect-src` / `form-action` surface stabilizes for the wizard flow.
- **Action:** Replace `frame-ancestors 'none'` with a full directive set: at minimum `default-src 'self'; script-src 'self' [Cognito hosted UI domain]; connect-src 'self' [API Gateway origin]; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`. Verify against the actual Next.js build output — `'unsafe-inline'` may be needed for styled-components or runtime CSS-in-JS depending on what the bundle ships. Test in report-only mode (`Content-Security-Policy-Report-Only` header via a separate response headers policy) for at least one deploy cycle before enforcing, so violations are observed before they break the page.
- **Where:** `infra/modules/cloudfront-frontend/main.tf` (`aws_cloudfront_response_headers_policy.portal` resource, `content_security_policy` block).

#### Per-service ACM cert as opt-in template input

- **What:** Provisioned services share a single wildcard ACM cert (`*.ironforge.rickycaballero.com`, pre-issued in shared composition, us-east-1) attached to every CloudFront distribution. Per-service certs (one ACM cert per provisioned subdomain, DNS-validated at provision time) are not supported.
- **Why deferred:** PR-C.1 design conversation chose shared wildcard for Phase 1: 1–2 days of dev work saved (no `wait-for-cert` Lambda, no extra state-machine state, no per-provision DNS validation handling), 5–15 min provisioning latency saved per service, $0 cost difference (public certs are free either way), and operational risk acceptable at portfolio scale (cert keys live in ACM-managed infra, not Ironforge's control plane). Per-service certs are stronger isolation but Phase 1 is single-tenant and has no per-customer compliance requirement that motivates the cost.
- **When to revisit:** When the platform demonstrates a meaningful need for per-service cert isolation — multi-tenant operation, per-customer SLA/compliance commitment, or a security incident where the wildcard cert's blast-radius matters concretely. Until then, shared wildcard is the right Phase-1 trade.
- **Action:** Re-introduce `wait-for-cert` Lambda (was PR-C.7a in the pre-PR-C.1 plan) to poll ACM until the per-service cert reaches `ISSUED`. Extend `StaticSiteInputsSchema` with a `certStrategy` field (`"shared-wildcard" | "per-service"`, default `"shared-wildcard"`) so existing services continue under the wildcard and new services can opt in. Update `templates/static-site/terraform/` to switch between attaching the shared cert ARN (current) and creating an `aws_acm_certificate` + `aws_acm_certificate_validation` per service (new path). Add an `aws_route53_record` for the `_acm-challenge` validation record on the per-service path. State machine adds the `wait-for-cert` state between `run-terraform` and `wait-for-cloudfront` only for services with `certStrategy = "per-service"` (Step Functions Choice state). Update `project_pr_c_series_plan.md` to note the re-introduction.
- **Where:** `templates/static-site/terraform/main.tf` (currently uses shared cert ARN); `packages/shared-types/src/templates/static-site.ts` (`StaticSiteInputsSchema` is currently empty); `services/workflow/wait-for-cert/` (does not exist; would be created); state machine definition (lands in PR-C.2; the Choice state would be added then or in the per-service-cert PR itself).

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

#### Tighten `cognito-idp:*` and remaining account-wide writes on `ironforge-ci-apply`

> **`kms:*` was tightened in the GitHub App secret PR** — per-key actions now scope to ironforge-managed CMKs via `kms:ResourceTag/ironforge-managed = true`. The remaining account-wide grants below follow the same conceptual pattern but are deferred to their natural triggers (Cognito launch, etc.).

- **What:** The apply role's identity policy (`OIDC_BOOTSTRAP.md` Step 4, sid `WriteAccountWideServicesIronforgeUses`) still grants `cloudfront:*`, `wafv2:*`, `acm:*`, `cognito-idp:*`, `events:*`, `apigateway:*`, `scheduler:*`, `xray:*`, `budgets:*` on `Resource: "*"`. The CI boundary's `Action: "*"` ALLOW does not cap these — only the DENYs (OIDC mods, self-modification, expensive services) constrain. The boundary's `Allow *` shape is itself deliberate (ADR-007); this entry tightens the identity policy, not the boundary. Concrete escalation path that still applies: `cognito-idp:*` against any non-Ironforge Cognito pool that might exist in the account.
- **Why deferred:** At Phase 0/early-Phase-1 these services don't yet have customer-facing data flowing through them, the apply role is gated behind `environment:production` with required reviewer + 5-minute wait, and tightening requires care: several of these services have actions that don't support resource-level scoping (which is why they were broadened in the first place — see the `Note on cloudfront:*, wafv2:*, acm:*, cognito-idp:*` comment in `OIDC_BOOTSTRAP.md`). The `kms:*` slot was the highest-value of the set (state-bucket destruction path) and got tightened first; the rest follow.
- **When to revisit:** **Primary trigger — Cognito user pool first holds real user data (Phase 1 launch).** That PR should include the `cognito-idp:*` tightening. Secondary triggers: (a) the first non-Ironforge resource in the account that we don't want the apply role to be able to delete, (b) anyone external getting merge access to the repo.
- **Action:** Tighten in this order — (1) `cognito-idp:*` to the specific user-pool ARN once the pool holds real users. (2) For the remaining services where resource-level scoping isn't supported, add explicit entries to a new `docs/iam-exceptions.md` so each `Resource: "*"` is recorded as a known limitation rather than an oversight. Test the tightened apply role by running a normal `terraform apply` against the shared composition and verifying no permission denials.
- **Where:** `infra/OIDC_BOOTSTRAP.md` Step 4; `docs/iam-exceptions.md` (new file).

#### GitHub App private key — add consuming-principal grant when workflow Lambda role lands

- **Status:** ✅ Resolved in PR-C.4b (2026-05-02). `AllowWorkflowLambdaDecrypt` activated as a `dynamic` block in `infra/modules/github-app-secret/main.tf` gated on non-empty `workflow_lambda_role_arns`. Shared composition populates the list with deterministically-constructed role ARNs (currently `ironforge-dev-create-repo-execution`; PR-C.8 will append `ironforge-dev-trigger-deploy-execution`). Per-Lambda identity policy on create-repo's role grants `secretsmanager:GetSecretValue` + `kms:Decrypt` with `EncryptionContext:SecretARN` exact-match.
- **Historical context:** The skeleton was committed in PR #41 as a comment block; PR-C.4a widened the boundary with `kms:Decrypt` (ADR-006 amendment); PR-C.4b activated the key-policy grant + per-Lambda identity policy + the boundary verification.

#### Residual KMS permissions absent from the IronforgePermissionBoundary

- **Status:** Partially resolved. PR-C.4a added `kms:Decrypt` (tag-conditional on `ironforge-managed=true`) — see ADR-006 § Amendments. `kms:GenerateDataKey` and `kms:DescribeKey` remain excluded.
- **What:** `IronforgePermissionBoundary` (`infra/modules/lambda-baseline/main.tf`) does not include `kms:GenerateDataKey` or `kms:DescribeKey` in its ALLOW list. Lambdas that need to mint new data keys (envelope encryption from scratch) or describe a CMK's metadata directly will be denied. `kms:Decrypt` was added in PR-C.4a for the GitHub App helper's Secrets Manager + CMK integration.
- **Why deferred:** No current Phase 1 Lambda needs `GenerateDataKey` or `DescribeKey`. `Decrypt` was added when the first concrete consumer (PR-C.4a's GitHub App helper) needed it; the same gating principle applies to the residual KMS actions — wait for a concrete consumer rather than widening speculatively.
- **When to revisit:** When the first Lambda needs `kms:GenerateDataKey` (envelope-encrypted data on the write path — distinct from Secrets Manager + CMK, which uses Secrets Manager-side encryption) or `kms:DescribeKey` (rare; usually only needed for KMS administration tooling).
- **Action:** Add the needed action(s) to the boundary's ALLOW list using the same shape PR-C.4a established: `Resource: "*"` with `kms:ResourceTag/ironforge-managed = true` condition. ADR-006's "tag-condition pitfall mitigation" rationale carries over (resource-tag conditions are reliably evaluated for these actions; alias-name conditions have the inconsistencies the original ADR flagged). Per-Lambda identity policies narrow further with specific CMK ARN + EncryptionContext binding. Add a § Amendments entry to ADR-006 documenting the second amendment.
- **Where:** `infra/modules/lambda-baseline/main.tf`; `docs/adrs/006-permission-boundary.md` § Amendments.

#### Boundary verification: kms:Decrypt denial against non-Ironforge-tagged CMK

- **Status:** ✅ Resolved in PR-C.4b (2026-05-02). ADR-006 § Verification gained a new "Phase 1 — KMS condition behavior" subsection with four verification cases (boundary attached / boundary tag-condition denial / per-Lambda EncryptionContext denial / end-to-end happy path with custom-property idempotency). Pre-merge verification artifacts captured in the PR description.

#### Future optimization: in-memory GitHub App token cache

- **Status:** Deferred per ADR-008 (2026-05-01). Per-invocation token mint is the chosen design; this entry tracks the conditions under which the deferral revisit triggers.
- **What:** `@ironforge/shared-utils/github-app/getInstallationToken` mints a fresh installation token on every invocation. ADR-008 explicitly rejects all caching patterns for the installation token itself (the PEM IS cached at module scope; that's a separate concern documented in `docs/conventions.md` § "Cold-start configuration loading"). The Option-3 in-memory-cache pattern was rejected on operational-complexity grounds at Phase 1 scale.
- **Why deferred:** ~2s cumulative latency across the workflow against a 5-minute baseline is 0.7% overhead — invisible at single-digit-provisionings-per-day. Caching adds ~50 lines of TTL/refresh/concurrency logic with subtle correctness properties (mid-execution token expiration, warm-pool selection non-determinism, etc.) for a benefit that doesn't exist yet.
- **When to revisit:** Any of the following triggers fires (full rationale in ADR-008 § "When to reconsider"):
  1. **Operational — Provisioning rate sustained >10/hour.** Cumulative mint latency starts to matter; warm-reuse savings become meaningful.
  2. **Operational — Token-mint latency becomes user-visible.** Wizard UX surfaces the ~1s mint as a perceptible pause (per-step progress feedback).
  3. **Operational — Secrets Manager throughput limits.** PEM-fetch rate-limit becomes a real failure mode (current PEM cache addresses this for now; trigger fires if PEM rotation becomes frequent enough that warm Lambdas re-fetch).
  4. **External signal — Documented GitHub Apps guidance changes.** GitHub publishes guidance shifting toward "always cache" or "never cache for security reasons." Discipline: review GitHub Apps docs annually as part of dependency review.
- **Action:** Lift the in-memory cache pattern from `octokit-app`'s built-in auth strategies (which have a tested implementation) rather than rolling our own. Add a `tokenCache` parameter to `getInstallationToken` (default: per-invocation, opt-in to in-memory). Test cases: cold start, warm reuse, near-expiry refresh, mid-flight token expiration, concurrent invocations on the same warm container. Update ADR-008 with an amendment rather than a new ADR.
- **Where:** `packages/shared-utils/src/github-app/get-installation-token.ts`; `docs/adrs/008-github-app-token-caching.md` § Amendments.

#### Drift detection: run-terraform IAM grants vs RESOURCE_TYPE_TO_IAM mapping

- **What:** PR-C.6 introduces a per-Lambda IAM policy for `task_run_terraform` (12 statements covering the static-site template's allowedResourceTypes whitelist + the always-emitted `route53:GetChange` star statement). The deployed copy lives as HCL in `infra/envs/dev/main.tf` (`local.run_terraform_extra_statements`); the unit-tested source of truth is the `RESOURCE_TYPE_TO_IAM` mapping in `packages/template-renderer/src/iam-policy.ts` consumed by `generateRunTerraformPolicy()`. Adding a resource type to a manifest's `allowedResourceTypes` requires updating BOTH locations in the same PR — no automation today catches drift.
- **Why deferred:** PR-C.6 already had a large surface (handler + container image + boundary widening + ADR amendment); adding a build-time pipeline (Node script generates JSON → terraform reads via `data "local_file"` → string-replace placeholders → jsondecode → assign to extra_statements) was a meaningful additional surface for marginal benefit at one-template scale. The two sources are co-located in PR review (the JS mapping change forces a HCL change in the same diff), and the JS mapping has unit tests that fail loudly if the action list is wrong.
- **When to revisit:** Any of: (a) the second template lands and its allowedResourceTypes intersection-or-union with static-site's becomes load-bearing, (b) a drift incident occurs (someone edits one side without the other and the issue surfaces post-deploy), (c) automated drift detection becomes a cheap add (e.g., we already have a Node-driven build step generating other artifacts the same way).
- **Action:** Add a build script (`services/workflow/run-terraform/build-iam-policy.mjs` or extend `build.mjs`) that calls `generateRunTerraformPolicy()` with `resourcePrefix=ironforge-svc-*`, `account="{ACCOUNT_ID}"`, `hostedZoneArn="{HOSTED_ZONE_ARN}"` placeholders, and writes `iam-policy-template.json` to a stable path. Commit the JSON. Terraform reads via `data "local_file"`, does two `replace()` substitutions for `{ACCOUNT_ID}` / `{HOSTED_ZONE_ARN}`, `jsondecode()`s, and assigns to `extra_statements`. CI's build step regenerates the JSON; if the rebuilt content differs from committed, CI fails on dirty working tree. Replace `local.run_terraform_extra_statements` with the data-source-derived list. Drop this entry.
- **Where:** `infra/envs/dev/main.tf` (`local.run_terraform_extra_statements`); `packages/template-renderer/src/iam-policy.ts` (`RESOURCE_TYPE_TO_IAM`); `services/workflow/run-terraform/build.mjs`.

#### Boundary verification for the PR-C.6 ADR-006 amendment

- **What:** ADR-006's PR-C.6 amendment widens the boundary with three new ALLOW statements (cloudfront:*, route53:GetChange, ironforge-svc-* IAM mgmt) and splits `DenyIAMManagement` into two statements (one Resource:* for User/Group/OIDC, one with NotResource carve-out for ironforge-svc-* role+policy). No runtime verification has been performed yet.
- **Why deferred:** PR-C.6 ships the boundary widening alongside the run-terraform Lambda's first deploy; the verification is naturally performed during the post-merge first-invocation against dev. The negative-isolation cases (assume-role into the run-terraform Lambda role and try `iam:CreateRole` against a non-`ironforge-svc-*` role name) hit the same trust-policy issue as the PR-C.4b verification — only `lambda.amazonaws.com` can assume the execution role, and modifying the trust policy temporarily for verification weakens the security posture for the duration of the test.
- **When to revisit:** Immediately after PR-C.6 merges and the first run-terraform invocation against dev succeeds (or fails). The verification record lands as a Verification log entry under ADR-006 § Verification with a date and the case numbers exercised.
- **Action:** Run the same Phase 1 verification shape as PR-C.4b: (1) static boundary inspection — confirm the new ALLOW + DENY statements are in the deployed boundary policy's default version, exact match to source. (2) End-to-end happy path — invoke the run-terraform Lambda against a test service, confirm terraform apply succeeds end-to-end (resources created in the ironforge-svc-* namespace, no AccessDenied at apply time). Negative-isolation cases (cases 2 and 3 in the original verification shape) — explicitly accept the substitution per PR-C.4b's "Verification log — 2026-05-02" pattern, citing the trust-policy constraint. Append the entry to ADR-006 § Verification.
- **Where:** `docs/adrs/006-permission-boundary.md` § Verification (new "Phase 1 — PR-C.6 amendment behavior" subsection).

#### Post-deploy network-isolation verification for run-terraform's filesystem_mirror

- **What:** PR-C.6's run-terraform handler relies on a `provider_installation { filesystem_mirror }` config to keep `terraform init` from contacting `registry.terraform.io`. Handler tests verify the wiring (`TF_CLI_CONFIG_FILE` set, `/tmp/.terraformrc` content matches, spawn env threading) but do NOT verify network isolation in production — i.e., that the running Lambda actually does NOT make egress to `registry.terraform.io` during init. The Lambda runs in the AWS-managed Lambda VPC (no customer VPC attachment in Phase 1); egress to `registry.terraform.io` would still succeed if the mirror config were silently ignored.
- **Why deferred:** Network-isolation testing requires either (a) attaching the Lambda to a customer VPC with no NAT (egress drops to ground), then exercising the Lambda — substantial infrastructure setup for a one-time test, or (b) inspecting Lambda's CloudWatch + X-Ray for outbound DNS / TCP traffic patterns post-invocation. Approach (b) is cheaper but probabilistic. Both are deferred to first-merge verification rather than gating the PR.
- **When to revisit:** Immediately after PR-C.6's first post-merge invocation against dev. Goal: confirm via either Lambda Insights (if enabled), CloudWatch Logs (terraform's own init output), or VPC Flow Logs (if the Lambda is later attached to a VPC) that no outbound traffic to `registry.terraform.io:443` occurred during the invocation.
- **Action:** After first invocation: (1) Open the run-terraform Lambda's most recent execution in CloudWatch. (2) Confirm the terraform init log block does NOT contain `Initializing provider plugins...` followed by version-fetch HTTP messages — successful filesystem_mirror init looks like `Installing hashicorp/aws v5.83.0... Installed hashicorp/aws v5.83.0` with no network-fetch breadcrumbs. (3) Optionally enable Lambda Insights for one invocation; inspect the function's outbound network metrics. Document the verification as a § Verification entry on ADR-009. If the test reveals network egress IS happening, that's a bug — the mirror config is being silently ignored, fix immediately.
- **Where:** `services/workflow/run-terraform/src/handle-event.ts`; `docs/adrs/009-run-terraform-execution-model.md` § Verification (new).

#### Decouple plan from image push via content-addressed image tagging

- **What:** PR-C.6's `infra-plan.yml` runs `infra/modules/terraform-lambda-image/build-image.sh` BEFORE `terraform plan`, because the dev composition reads the pushed image's digest URI via `data "local_file"` from `.image-uri` — terraform plan fails if the file doesn't exist, even if no image change is being planned. As a result, the plan OIDC role (`ironforge-ci-plan`) has been granted `EcrImagePushIronforge` — the four ECR layer/image-write actions on `repository/ironforge-*`. This expands the plan role's blast radius beyond the read-only baseline that other plan-role grants enforce. Today: someone with merge access to `main` can push arbitrary images into the `ironforge-*` ECR repos via a malicious PR plan. The Lambda would only pick up the image if the apply also ran (which has its own gating), but the image lives in the registry until lifecycle policy expires it.
- **Why deferred:** Removing the plan-time push requires either (a) a content-addressed tagging scheme — pre-compute the image digest deterministically from inputs without pushing, embed in `.image-uri`, then push only at apply time — or (b) a different deploy model (e.g., codepipeline triggered from a tag) that decouples the plan workflow entirely. Both are substantial refactors. PR-C.6 ships with the plan-side push as the simplest path to a working PR-C.6.
- **When to revisit:** Any of: (a) a security review flags the plan role's ECR push surface as load-bearing, (b) a malicious-PR-plan incident occurs (a malformed image gets pushed to ECR via a PR plan run), (c) the second container Lambda lands and ECR push becomes more frequent.
- **Action:** Implement content-addressed tagging — compute the image's content hash from the Dockerfile + build context (terraform binary version + AWS provider version + handler.js sha256 + templates/ tree hash) deterministically, write `<repo>:content-<hash>` to `.image-uri`, only push at apply time when `docker manifest inspect` confirms the tag doesn't already exist. Drop `EcrImagePushIronforge` from the plan role's identity policy. Update `infra-plan.yml` to skip the build-image.sh push step (still build locally to validate Dockerfile, just don't `docker push`).
- **Where:** `infra/modules/terraform-lambda-image/build-image.sh`; `.github/workflows/infra-plan.yml`; `infra/OIDC_BOOTSTRAP.md` § Step 3 (plan role's `EcrImagePushIronforge`).

#### Migrate run-terraform to CodeBuild if the Lambda timeout becomes load-bearing

- **What:** ADR-009 chose Lambda direct execution (with container image + filesystem_mirror) over CodeBuild for run-terraform, on the empirical basis that a static-site apply averages 3m47s — well within Lambda's 600s budget (set with 25% margin). The decision is sensitive to template growth: if a future template's apply approaches or exceeds the 600s budget, the architecture trigger is to revisit the CodeBuild path (originally rejected on cost + latency grounds; the math changes if Lambda becomes the bottleneck).
- **Why deferred:** No current data point for templates other than static-site. CodeBuild migration requires substantial work (Step Functions integration via `arn:aws:states:::codebuild:startBuild.sync`, IAM rework, log aggregation across CodeBuild + Lambda) that's not justified at single-template scope. ADR-009 § "Rejected alternatives" captures the original reasoning.
- **When to revisit:** Any of: (a) a new template lands with measured median apply >450s (75% of the budget — leaves no headroom for variance), (b) a single observed apply hits 540s+ in CloudWatch, (c) the run-terraform Lambda's `Timeout` metric in CloudWatch fires more than once per quarter, (d) a template author proposes a resource type (e.g., RDS DB cluster, large CloudFormation stack via aws_cloudformation_stack) with known multi-minute create times.
- **Action:** Re-open the ADR-009 alternatives evaluation with current data. If CodeBuild wins: provision a per-env CodeBuild project (with the same container image), wire SFN to `:codebuild:startBuild.sync`, migrate the IAM grants to the CodeBuild service role + project-level IAM, retire the run-terraform Lambda. Update ADR-009 with the migration amendment.
- **Where:** `services/workflow/run-terraform/`; `docs/adrs/009-run-terraform-execution-model.md` § Amendments; `infra/envs/dev/main.tf` (`task_run_terraform` module → CodeBuild module).

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

### Workflow / state machine

#### Cleanup-on-failure destroy chain

- **What:** The provisioning workflow's `cleanup-on-failure` state currently performs **status writes only** (Service `provisioning → failed`, Job `running → failed`, JobStep `cleanup-on-failure` succeeded). It does NOT delete created AWS resources, GitHub repos, CloudFront distributions, or run `terraform destroy` against the per-service composition. Orphaned resources are discoverable via the `ironforge-managed = true` tag and cleaned up manually.
- **Why deferred:** Phase 1 single-template scope means orphans are operator-discoverable + manually-recoverable (the maintainer is Ricky, who is also the operator). A real destroy chain has non-trivial design questions: (1) `terraform destroy` semantics for partial state — what if S3 bucket created but CloudFront mid-flight; (2) GitHub repo deletion ordering vs. terraform's IAM role deletion; (3) idempotency on the destroy chain itself (cleanup gets re-fired by SFN retry). Each of these warrants its own design conversation. PR-C.2 deliberately ships the simpler path (a) of the design conversation; the destroy chain re-enters the queue when a forcing function lands.
- **When to revisit (any one of):**
  - **>10 orphaned resources accumulated** — the manual-cleanup tax becomes routine.
  - **Single failure leaves orphans taking >5 min to clean manually** — operational friction has crossed the threshold where automation pays back.
  - **Multi-tenant requirement lands** — orphan visibility per-tenant becomes a customer concern, not just an operator concern.
  - **Phase 2 begins** — natural forcing function. If none of the above triggers fired by then, do this anyway. Without this anchor the entry becomes a "we'll get to it" item that doesn't get to it.
- **Action:**
  1. Design conversation covering: per-resource-type destroy ordering, partial-state recovery, retry-after-partial-destroy idempotency, GitHub repo deletion vs. terraform IAM role deletion ordering, and whether `terraform destroy` is invoked from the cleanup Lambda directly or via the same execution-model decided at PR-C.6 (CodeBuild vs. Lambda direct).
  2. Replace the `cleanupStub` in `services/workflow/_stub-lib/src/cleanup-stub.ts` with a real cleanup Lambda implementation in `services/workflow/cleanup-on-failure/src/handler.ts` (deleting the stub-lib import path).
  3. Extend the cleanup Lambda's IAM grants: `lambda:InvokeFunction` on `run-terraform` (for the destroy invocation), GitHub App secret read for the repo deletion, etc.
  4. Update `docs/state-machine.md` § "Cleanup-on-failure scope" — replace the PR-C.2 minimal description with the destroy chain semantics.
  5. Update this entry to "Resolved" and remove. Move historical context to `docs/runbook.md` if useful.
- **Where:** `services/workflow/cleanup-on-failure/src/handler.ts` (currently re-exports cleanupStub); `services/workflow/_stub-lib/src/cleanup-stub.ts` (stub to delete); `docs/state-machine.md` § "Cleanup-on-failure scope (PR-C.2 — minimal)".

#### Repo-secrets staleness on infrastructure rotation

- **What:** The 3 GitHub Actions repo secrets that the user's `deploy.yml` consumes — `IRONFORGE_DEPLOY_ROLE_ARN`, `IRONFORGE_BUCKET_NAME`, `IRONFORGE_DISTRIBUTION_ID` — are populated **once** by the platform's `trigger-deploy` step on initial provisioning. If any of those underlying AWS resource identifiers rotates (deploy role re-created with a new ARN, bucket renamed, distribution destroyed and recreated), the repo secrets become stale and the user's next deploy run fails with `AccessDenied` (role assume), `NoSuchBucket`, or `NoSuchDistribution`.
- **Why deferred:** Rotation is uncommon at portfolio scale (PR-C.6's terraform module produces stable identifiers across applies; only `terraform destroy + apply` cycles produce new IDs). The reliability surface of an Ironforge-side rotation watcher (CloudTrail subscription? scheduled drift-detect Lambda? webhook from terraform's own state writes?) is non-trivial and warrants its own design conversation. Phase 1 single-template + single-operator + no-real-traffic context means the recovery cost (manual re-run of trigger-deploy or hand-edit via GitHub UI) is acceptable.
- **When to revisit (any one of):**
  - **First reported stale-secrets incident** — actual recovery friction proves the deferral was wrong, even at portfolio scale.
  - **Routine rotation requirement lands** — e.g., quarterly deploy-role rotation for compliance, or any policy that mandates IAM role re-creation on a schedule.
  - **Phase 2 multi-tenant** — operator can't be on the hook for per-customer manual recovery.
- **Action:**
  1. Recovery procedure (until automated): operator manually invokes `trigger-deploy` Lambda against the affected jobId (or constructs an equivalent set-secrets-only flow), OR edits the secrets via the GitHub UI at `https://github.com/<org>/<repo>/settings/secrets/actions`.
  2. Automation candidates to evaluate at re-visit: (a) scheduled drift-detect Lambda comparing `Service.lastKnownInfra` to current terraform output, re-running secret population on diff; (b) terraform-state-write webhook (S3 event on the per-service tfstate object) triggering a repopulate Lambda; (c) shifting the source of truth from repo secrets to a `terraform output`-fed read by the deploy.yml on each run (would require deploy.yml to assume an Ironforge-side read role first — adds complexity).
- **Where:** `templates/static-site/starter-code/.github/workflows/deploy.yml` § comment block at the top; `services/workflow/trigger-deploy/src/handle-event.ts` (the populator, currently single-shot).

#### Audit-log emission on terminal workflow transitions

- **What:** The PR-C.9 `finalize` Lambda transitions Service to `live` and Job to `succeeded` but does NOT emit a structured audit event. The original PR-C.2 `finalizeStub` comment promised "the real PR-C.9 finalize Lambda will do the same transitions but also emit a structured event for Phase-2 observability (audit log, customer notification)." That commitment is deferred. Same applies to `cleanup-on-failure`'s terminal failure transitions (no audit event emitted there either). The Audit entity is documented in `docs/data-model.md` (`PK = AUDIT#<yyyy-mm-dd>`, `SK = <iso-timestamp>#<event-id>`) but no writer or reader exists.
- **Why deferred:** Phase 1 has no audit-log readers. Building a writer with no consumer is YAGNI — JobStep rows + CloudWatch logs already capture every workflow transition with full structured context. The Audit entity's value is in cross-job, cross-service queries ("what happened on date X?", "what's the rate of provisioning failures?", "who provisioned this service?") that no Phase-1 code path needs.
- **When to revisit (any one of):**
  - **Audit query API endpoint added** — e.g., `GET /api/audit?from=...&to=...` for operator dashboards or a "what happened" UI. The API is the consumer; finalize + cleanup-on-failure become writers.
  - **Notification consumer lands** — e.g., user-facing email on provisioning success / failure, Slack webhook for Ricky-as-operator. Audit events are the natural fan-out source.
  - **Compliance requirement lands** — SOC2 audit trail, GDPR right-to-erasure tracking, or any policy mandating retained workflow-event history. The Audit entity's daily-PK partitioning was designed for this; using it now satisfies the requirement without redesign.
  - **Multi-tenant feature** — operator-facing "what happened for tenant X" views become per-customer; CloudWatch + JobStep can't cleanly answer that across many tenants.
  - **"What happened at time T" feature for the platform's own debugging** — informally if Ricky finds himself querying CloudWatch for cross-service correlation more than once a quarter, that's the trigger.
- **Action:**
  1. Add an audit-event writer helper to `@ironforge/shared-utils` — single function `writeAuditEvent({ tableName, eventType, payload, actor, occurredAt })` that constructs the PK/SK shape from `data-model.md` and `PutItem`s the row. Idempotency on the SK (`<iso-timestamp>#<event-id>`) — re-fires write the same row.
  2. Wire it into `finalize`'s success path (event type `provisioning.succeeded`, payload includes `serviceId`, `jobId`, `liveUrl`) and `cleanup-on-failure`'s success path (`provisioning.failed`, payload includes `failedStep`, `errorName`, `errorMessage`).
  3. Add the `dynamodb:PutItem` grant on the table to both Lambdas' IAM (already present — `task_lambda_iam_grants.dynamodb_write` covers it).
  4. Update this entry to "Resolved" and remove. Migrate the writer's API contract to `docs/data-model.md` if a richer reader-side schema is added.
- **Where:** `services/workflow/finalize/src/handle-event.ts` (post step 7 — JobStep succeeded write); `services/workflow/_stub-lib/src/cleanup-stub.ts` (or its destroy-chain successor); `packages/shared-utils/src/dynamodb/audit.ts` (new file when re-introduced); `docs/data-model.md` § Audit entity (already documents the key shape).

#### Existing service deploy.yml updates require manual operation

- **What:** When `templates/static-site/starter-code/.github/workflows/deploy.yml` changes (e.g., PR-C.8 added the `correlation_id` input + `run-name` filter), services provisioned BEFORE the change keep their old `deploy.yml` verbatim. There is no automated migration: no Ironforge-side process opens a PR against existing service repos, no template-version-bump trigger fires a re-render, no `force_redeploy_yaml = true` flag exists.
- **Why deferred:** Phase 1 has no provisioned services in production; the migration tax is currently zero. The forward-only-template policy is the simplest invariant to maintain (every change is "new services get the new shape; old services unchanged"), and a real migration tool is non-trivial: per-template diff strategy, conflict resolution if the user has hand-edited their deploy.yml, PR opening + review semantics, multi-repo orchestration. None of that is portfolio-scale work.
- **When to revisit (any one of):**
  - **First old-service breakage attributed to deploy.yml drift** — e.g., wait-for-deploy stops finding runs because an old service's deploy.yml lacks `run-name`, fails the workflow, operator wastes time diagnosing.
  - **Phase 2 + non-trivial number of provisioned services exist (≥ 5)** — manual migration tax becomes operationally real.
  - **Breaking change required to deploy.yml** — e.g., security-driven secret-name rename. At that point the migration is forced; building it then is reactive and worse than building it on a quiet day.
- **Action:**
  1. Recovery procedure (until automated): operator manually edits the affected service repo's `deploy.yml` via PR, or uses `gh api -X PUT /repos/<org>/<repo>/contents/.github/workflows/deploy.yml` to overwrite.
  2. Automation candidates to evaluate at re-visit: (a) template-version field on `Service` row + a scheduled "templateVersion < currentTemplateVersion → open migration PR" Lambda; (b) on-demand "migrate this service" API endpoint exposing a `force_redeploy_yaml` flag; (c) GitHub App-driven cross-repo PR fanout invoked from a one-off ops command.
- **Where:** `templates/static-site/starter-code/.github/workflows/deploy.yml`; `services/workflow/generate-code/src/handle-event.ts` (the renderer that writes deploy.yml on initial provision); the (currently nonexistent) migration mechanism.

#### Stale verification repo on ironforge-svc — manual cleanup

- **What:** PR-C.4b's Case 4 verification created a real GitHub repo `ironforge-svc/boundary-verify-1777745253` to exercise the create-repo Lambda's end-to-end flow. The verification cleanup step (`gh api -X DELETE`) failed because the gh CLI's auth token lacks the `delete_repo` scope. The repo persists.
- **Why deferred:** Refreshing the gh CLI auth scope (`gh auth refresh -h github.com -s delete_repo`) is interactive and was not wired into the verification flow. Operationally cheap to leave (single private repo, ~0 cost, no consumer); tidier to delete.
- **When to revisit:** At any natural break, OR before the next end-to-end verification (each verification leaves a fresh test repo, so multiple verifications without cleanup accumulate).
- **Action:** Either `gh auth refresh -h github.com -s delete_repo && gh api -X DELETE /repos/ironforge-svc/boundary-verify-1777745253`, or delete via the GitHub UI's Danger Zone at `https://github.com/ironforge-svc/boundary-verify-1777745253/settings`.
- **Where:** GitHub UI, or operator's terminal.

### Operational verification / monitoring

#### End-to-end verification of the cost-safeguards circuit breaker

- **What:** The $50 budget action + deny policy is the load-bearing Tier-2 cost protection. The static configuration is now fully verified-by-static-analysis-and-procedure but the procedure has not yet been *run* against a live throwaway test user. All three pre-existing bugs from the April 2026 verification attempt are fixed: the unattachable managed-policy bug (PR #30), the ADR-002 worked-example mismatch (PR #31), and the broken Console-button § 3 procedure (rewrite PR — replaces "Run action now" with a five-step simulator + manual-attach + cleanup procedure that tests our surface without depending on AWS-internal threshold firing). What's left is to actually execute the rewritten procedure once and capture artifacts.
- **Why deferred:** The runtime execution is a manual ops task with throwaway IAM resource creation, simulator runs, attach/detach, and cleanup verification. Better as its own focused session than as "one more thing" tacked onto the docs rewrite. The procedure's first run will also seed the verification log table in `docs/cost-safeguards.md` § "Verification log".
- **When to revisit:** Before Phase 1 populates `var.budget_action_target_roles` with real workflow Lambda roles. After the first runtime execution, establish a quarterly cadence.
- **Action:** Run the procedure in `docs/cost-safeguards.md` § 3 ("Verify the budget action plumbing"). Capture EvalDecision artifacts in the § "Verification log" table; cross-link the run from `docs/EMERGENCY.md` § 2. Set a quarterly reminder.
- **Where:** `docs/cost-safeguards.md` § 3 (procedure to execute) and § "Verification log" (artifact capture); `docs/EMERGENCY.md` § 2 (cross-link).

#### CloudWatch metric filters and alarms on CloudTrail security events

- **What:** CloudTrail itself is being enabled this week as a standalone pre-Phase-1 commit. Metric filters and alarms on top of CloudTrail (e.g., `ConsoleLogin` failures, root-account API calls, IAM changes by non-CI principals, KMS key policy edits, S3 bucket policy changes) are deferred to Phase 1.
- **Why deferred:** CloudTrail captures the events; alarming on them requires deciding which events warrant a page versus a quiet log entry. Defining the filter set well requires Phase 1's resource set to be in place — alarming on "IAM changes" before Phase 1 IAM lands would just generate noise from the Phase 1 commits themselves. Better to add filters as the resources they protect come online.
- **When to revisit:** First Phase 1 commit that creates a non-CI IAM role, secret, or KMS key. The new resource is the trigger to add its corresponding alarm.
- **Action:** Create `aws_cloudwatch_log_metric_filter` + `aws_cloudwatch_metric_alarm` pairs alerting to `ironforge-cost-alerts` (or a new `ironforge-security-alerts` topic if the cost-vs-security distinction matters). Minimum recommended set: (1) root-account API usage, (2) IAM policy changes outside `ironforge-ci-*` actor, (3) `kms:DisableKey` / `kms:ScheduleKeyDeletion` events, (4) S3 bucket-policy edits on `ironforge-terraform-state-*`, (5) Console login failures from non-allowlisted IPs (post-MVP if console use grows). Document the filter set in `docs/runbook.md` so an alert tells the on-call where the metric came from.
- **Where:** New `infra/modules/security-monitoring/` (or fold into `cost-safeguards` and rename); referenced from `infra/envs/shared/main.tf`.

#### GuardDuty enabling

- **What:** AWS GuardDuty is not enabled. GuardDuty surfaces threat-detection findings (compromised credentials, anomalous API patterns, crypto-mining instances, etc.) that CloudTrail metric filters miss because they require behavioral analysis across the event stream.
- **Why deferred:** ~$3-4/month at idle traffic for the basic detector, more with malware protection or runtime monitoring. Limited signal at portfolio scale — there's no real attacker traffic to detect. Phase 0 (placeholder portal) and Phase 1 (provisioning workflow with no public surface beyond the wizard) don't generate the kind of API patterns GuardDuty is designed to catch.
- **When to revisit:** Phase 2 (wizard live with authenticated users) or whenever real production traffic begins. Also revisit if the cost-safeguards budget is raised — GuardDuty's monthly cost becomes a smaller fraction of the budget then.
- **Action:** Enable in the shared composition: `aws_guardduty_detector` with `enable = true`, finding-publishing frequency `FIFTEEN_MINUTES`, and SNS subscription to `ironforge-cost-alerts` (or `ironforge-security-alerts`) via EventBridge. Document the GuardDuty dashboard URL in `docs/runbook.md`.
- **Where:** New addition to `infra/envs/shared/main.tf`; referenced docs.

#### Data events on the CloudTrail log bucket itself

- **What:** The CloudTrail trail (PR-B) captures management events but not data events. In particular, S3 GetObject calls against `ironforge-cloudtrail-logs-<account>` are not logged — meaning we have no record of *who reads the audit log*. CMK encryption gives us decrypt-event audit on the key (criterion 2 in ADR-003), which is a partial substitute, but data events on the bucket would be the direct signal.
- **Why deferred:** Data events cost money — $0.10 per 100k events at portfolio scale isn't material, but the operational value is low until there's a realistic threat model where someone might read the logs without authorization. At Phase 0/1 the only readers are CI principals and the user; both are accounted for through other means.
- **When to revisit:** Phase 2 (wizard live with authenticated traffic and a non-trivial set of human investigators). Also revisit if a compliance regime with explicit audit-log access logging requirements lands.
- **Action:** Add a `data_resource` block to `aws_cloudtrail.main` selecting `AWS::S3::Object` with the CloudTrail bucket ARN as the value. Pair with a metric filter alarming on `eventName = GetObject` whose `requestParameters.bucketName` equals the log bucket and whose principal is not the CloudTrail service or known CI roles.
- **Where:** `infra/modules/cloudtrail/main.tf` (`aws_cloudtrail.main`); future `infra/modules/security-monitoring/` for the alarm.

### Documentation

#### `docs/runbook.md` polish beyond Phase 0 skeleton

- **What:** A skeleton runbook is being added this week with four sections: state-bucket recovery, CMK pending-deletion recovery, lock-table corruption, and "I think state is wrong, what now." Sections capture symptom/diagnosis/recovery/prevention but in compact form, not polished prose.
- **Why deferred:** Polish-without-incident-data is speculative — runbook prose written in the abstract tends to miss the actually-confusing parts of an incident. The skeleton is enough to navigate by; polish lands when an incident reveals which sentences were unclear.
- **When to revisit:** After the first real recovery action (which Phase 4 drift detector or any unplanned `terraform state` surgery would generate), or quarterly review whichever comes first. Also revisit if a new failure mode appears (e.g., CI role compromise, which the OIDC bootstrap doc partially covers but the runbook should cross-link).
- **Action:** For each section, expand into prose covering: precise symptom strings to grep for, the AWS CLI commands with explanatory context (not just the command), the rollback path if recovery fails, and a "things you might be tempted to do but shouldn't" warning block. Add a top-level decision tree: "I'm seeing X, go to section Y."
- **Where:** `docs/runbook.md`.

### Build / deployment

#### Migrate Lambda code deployment from `archive_file` to S3-hosted sha-pinned artifacts

- **What:** PR-B.2's `infra/modules/lambda` zips the function source via the `archive_file` data source at `terraform plan` time. CI runs `pnpm -F @ironforge/<service> build` before `terraform plan`, then Terraform packages the resulting `dist/` directory and creates the function with an inline filename. Simple and self-contained but couples the build to the apply pipeline.
- **Why deferred:** archive_file works for MVP (single Lambda, small bundle, straightforward CI). Migrating to S3-hosted artifacts adds a build/upload pipeline, sha-pinning logic, and an artifacts-bucket dependency before any of those costs are paying for themselves. Matches PR-B.2's "ship the boring path" trade.
- **When to revisit:** Whichever of these comes first:
  1. **Function zip exceeds 30MB.** Lambda's `filename`-based deploys are capped at 50MB; 30MB is the early-warning trigger before the cap forces the migration in panic mode. (Current API bundle: ~600KB pre-zip; far away from this limit.)
  2. **Release-immutability becomes a requirement.** Once the apply pipeline needs sha-pinned releases (e.g., for one-click rollback to a previous Lambda version, or audit-trail evidence that "version X was deployed at time Y"), inline filename deploys stop being good enough. archive_file's hash changes on every source change but the artifact itself isn't independently addressable.
  3. **Artifacts cross-env bucket policy redesign lands** (see § "Re-enable artifacts cross-env bucket policy after refresh-cascade redesign"). The same redesign session is the right moment to flip Lambda artifact hosting onto the same bucket — coordinated change, single review surface.
- **Action:** CI builds → uploads to `s3://ironforge-artifacts/<env>/lambda/<function>/<sha>.zip` → Terraform consumes via `s3_bucket` + `s3_key` (computed from a sha file in the build, OR passed as a tfvar from the workflow). Add the upload step to `.github/workflows/infra-apply.yml` between the `pnpm build` step and `terraform plan`. Keep archive_file available as the local-dev path for engineers running terraform locally without CI; conditional on a tfvar (e.g., `lambda_artifact_source = "local" | "s3"`).
- **Estimated effort:** 4-8 hours including CI workflow update, Terraform refactor, and one full apply cycle to verify the new pipeline.
- **Where:** `infra/modules/lambda/main.tf` (the `archive_file` data source), `.github/workflows/infra-apply.yml` (the build + upload step), `infra/envs/<env>/main.tf` (the api_lambda module call's `source_dir` argument is replaced or supplemented by `s3_bucket`/`s3_key`).

### Schema evolution

#### Malformed Service item handling — fail-loud → 500 revisit on first schema migration

- **What:** PR-B.3's read handlers (`services/api/src/routes/services.ts`) parse every DynamoDB-returned item against `ServiceSchema` and throw on failure (caught and converted to `500 INTERNAL`). The list handler short-circuits the whole list on a single bad item; the detail handler's behavior is naturally per-item. Both log structured detail (item PK/SK, Zod flattened errors, requestId, userId) before throwing.
- **Why deferred:** Phase 1 has no schema migration history — every Service item was written under the current schema. Malformed = bug in the write path, surface immediately. Implementing partial-error envelopes or skip-with-warning before any drift exists is engineering-without-a-symptom; the simple shape catches what matters now.
- **When to revisit:** First PR that introduces a non-additive change to `ServiceSchema` — adding a required field, narrowing an enum, restructuring the discriminated union, removing a status variant. Additive changes (new optional fields, new status variants) don't need this since the handler can validate against either old or new shape via the same schema.
- **Action — pick the shape based on the migration:**
  1. **Partial-error envelope.** Response becomes `{ ok: true, data: { items: Service[], cursor, errors: [{ id, code, message }] } }`. Most honest; preserves valid items; surfaces parse failures to the client. Best when migrations are gradual (some items old shape, some new) and clients can show "1 service failed to load" UX.
  2. **Skip-with-warning.** Item is omitted from the response; warning logged with the parse error. Quietest; fine if the failure mode is genuinely rare and the operator triage path (CloudWatch metric filter on the warning) is known. Avoid unless paired with monitoring.
  3. **Inline migration.** On read, transform old-shape items to new-shape items with a fallback for missing fields. Works for additive-only migrations (which by definition don't trigger this revisit) — listed for completeness only.
- **Estimated effort:** 2-4 hours including test rewrites (the 8 failure-mode tests already in `handler.test.ts` need to be updated to the new shape).
- **Where:** `services/api/src/routes/services.ts` (the `parseServiceItem` helper and the list handler's `.map(...)` call site); `packages/shared-types/src/api.ts` (potentially extends `ApiResponse` envelope to carry per-item errors).

### Lint / type discipline

#### Enforce discriminated-union exhaustiveness via `@typescript-eslint/switch-exhaustiveness-check`

- **What:** `docs/data-model.md` § "Discriminated-union exhaustiveness" mandates that every `switch` on a discriminated-union discriminator (e.g., `Service.status`) ends with a `default: { const _exhaustive: never = service; throw ... }` so future variant additions fail at compile time. This is currently a documented convention only — there is no automated enforcement. A handler author who reaches for `if`/`else if` instead of `switch`, or who omits the `never`-typed default, will silently degrade the type-level guarantee.
- **Why deferred:** PR-B.1 introduces the convention but does not yet contain any switch on a discriminated union (no handlers in PR-B.1). Adding ESLint config in PR-B.1 with no rule violations to fix is configuration-without-purpose; adding it inside PR-B.3 alongside the first switch conflates "wire the lint" with "implement the handlers" in one review surface.
- **When to revisit:** Whichever of these comes first — (a) the first ESLint configuration commit on the repo (currently no `.eslintrc` / `eslint.config.{js,mjs}` exists at the root), or (b) the first PR that adds a `switch` on a discriminated-union type. PR-B.3 will hit (b) almost certainly. Do not let either trigger pass without configuring the rule.
- **Action:** Add `@typescript-eslint/switch-exhaustiveness-check` at `error` severity in the root ESLint config covering all TypeScript packages (`apps/web`, `services/*`, `packages/*`). The rule is part of `@typescript-eslint/eslint-plugin`; it requires type-aware linting (`parserOptions.project` pointing at each package's `tsconfig.json` or a root `tsconfig` referencing them). Verify the rule fires on a deliberately-incomplete switch over `Service.status` as a smoke test before merging the config. Estimated effort: ~15 minutes including the smoke test.
- **Where:** Root ESLint config (path TBD — likely `eslint.config.mjs` for flat-config). Reference from `docs/data-model.md` § "Discriminated-union exhaustiveness" once enabled (replace the "must use" prose with "lint-enforced via …").

### Diagnostics breadcrumbs

These aren't deferred work — they're institutional knowledge captured at the point the lesson was learned, so future-Ricky troubleshooting a similar failure benefits from the breadcrumb. Adapted from the standard entry shape: Symptom / Cause / How to diagnose.

#### S3 bucket-policy `MalformedPolicy: Conditions do not apply...` failures return early on first invalid statement

- **Symptom:** `terraform apply` against an `aws_s3_bucket_policy` resource fails with `MalformedPolicy: Conditions do not apply to combination of actions and resources in statement`.
- **Cause:** AWS S3's bucket-policy validator is stricter than IAM's general policy validator and rejects condition-action mismatches at apply time. Specifically, every condition key in a statement must be valid for every action in that statement (or be a global condition key like `aws:PrincipalTag` which applies universally). Common mismatch: `s3:prefix` is supported by `s3:ListBucket` and `s3:ListBucketVersions` but NOT by `s3:ListBucketMultipartUploads`.
- **How to diagnose:** **Verify all statements**, not just the one cited in the error — the validator returns early on the first invalid statement, so the error message identifies one but does NOT confirm the others are valid. For each statement, list every action and check the AWS service authorization reference (https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazons3.html) for which condition keys each action supports. Cross-reference against the conditions in that statement.
- **Case study:** PR #33's `DenyCrossEnvListing` statement included `s3:ListBucketMultipartUploads` with an `s3:prefix` condition. Apply failed; the fix dropped that single action from the statement (`infra/modules/artifacts/main.tf`). Statement 2 of the same policy used `s3:*` + `NotResource` + `aws:PrincipalTag` substitution and was also under suspicion until docs verification confirmed each component is independently supported and the validator's "singular statement" wording matched only Statement 3.
- **Where:** AWS service authorization reference is the diagnostic source-of-truth; the inline comment in `infra/modules/artifacts/main.tf` (`DenyCrossEnvListing` statement) carries the action-specific reasoning forward in code.

#### Terraform refresh `# … has been deleted` can be a false positive; cascading destroys are the real damage

- **Symptom:** A `terraform apply` plan shows surprising `+ create` (or `must be replaced`) entries for resources that haven't been touched in the diff under review. The pre-plan output may include a `# module.<...>.<resource> has been deleted` notice from refresh. Apply then destroys dependent sub-resources successfully and fails on the parent's recreate (e.g., `BucketAlreadyExists` for S3, or analogous "already exists" errors for IAM policies, KMS keys, etc.). State is left with the destroys committed but no creates.
- **Cause:** **Unidentified.** PR #38's reproduction (the second occurrence) was diagnosed extensively via CloudTrail and the apply role's refresh API calls all *succeeded* — no `AccessDenied`, no `NoSuchBucket`, no observable AWS-side failure. Yet terraform still concluded "deleted." The mechanism appears to be at a layer CloudTrail doesn't expose — possibly terraform-aws-provider's internal interpretation of GetBucketPolicy responses containing `${aws:PrincipalTag/...}` substitution, or a CloudTrail visibility gap on a specific refresh API call. The originally-published version of this entry hypothesized "transient API response interpreted as deleted"; that hypothesis was unsupported by the empirical CloudTrail data and is corrected here. See `docs/postmortems/2026-04-bucket-policy-refresh-cascade.md` for the full diagnostic record.
- **How to diagnose:** When a plan shows surprising `+ create` or `must be replaced` cascades against a resource that was untouched in the diff, **stop and verify the resource exists in AWS via the CLI before approving Apply**. For S3: `aws s3api head-bucket --bucket <name>`. For IAM policies: `aws iam get-policy --policy-arn <arn>`. For KMS keys: `aws kms describe-key --key-id <id>`. If AWS confirms the resource exists, the refresh's "deleted" claim is wrong and the plan is unsafe to apply — proceeding will destroy the dependents (recoverable) and then fail (leaving partial state, which is the real damage). For deeper diagnosis when CloudTrail is silent, run a one-off `terraform apply` with `TF_LOG=DEBUG` set in a dev-equivalent environment to capture the full HTTP-level API call/response sequence the provider sees.
- **Recovery if Apply already ran:** Use a Terraform 1.5+ `import` block in the root module to re-attach the existing AWS resource to state. The same apply that processes the import re-creates the destroyed dependents from config. Remove the import block in a follow-up PR (it's one-shot per Terraform convention; leaving it generates noise on every future plan). Import blocks are not supported inside child modules, so they live in the env composition root (`infra/envs/<env>/imports.tf` is the convention used here).
- **Case studies:** PR #35 (first occurrence) and PR #38 (second occurrence, with full CloudTrail diagnosis). Both involved the artifacts bucket. The empirical correlation in both cases: bucket policy with `aws:PrincipalTag/...` substitution in `not_resources` present in AWS at refresh time → next apply's drift detection reports the bucket as "deleted" → cascading destroys. Without those statements (TLS-only policy alone), applies work cleanly. PR #37 and PR #39 were the recoveries via import block. Bucket was empty in both cases (Phase 0 has no consumers), so no data risk; if it had held data, the destroyed bucket-policy + public-access-block window would have been a real exposure.
- **Prevention:** Treat refresh "deleted" claims as suspicious by default — verify with the AWS CLI before approving Apply on any plan that shows unexpected `+ create` or `must be replaced` for resources not modified in the diff. The CI plan/apply gate (`environment: production` with required reviewer + 5-minute wait) is the right place to catch these; the wait window is exactly long enough to run a `head-bucket`/`get-policy`/`describe-key` cross-check on any surprise in the plan. Long-term: a CI-side detection that alarms when `infra-apply` fails (even though the merge has already happened) so future incidents surface immediately rather than at the next contributor's surprise.
- **Where:** This breadcrumb. Full incident record: `docs/postmortems/2026-04-bucket-policy-refresh-cascade.md`. The recovery pattern is reusable for any Terraform-managed AWS resource hit by similar drift false-positives, not just S3 buckets.

### Supply chain

#### CodeQL workflow pending repo going public

- **What:** GitHub-hosted CodeQL (free for public repos) provides static analysis for security issues in TypeScript code. Not enabled — CodeQL on private repos is paid (Advanced Security), and the project hasn't gone public yet.
- **Why deferred:** Cost. The free tier requires public visibility; the paid tier isn't worth it for portfolio-scale code volume.
- **When to revisit:** When the repo flips to public (likely Phase 3 or Phase 4 when the demo mode lands and the project is portfolio-presentation-ready).
- **Action:** Add `.github/workflows/codeql.yml` using the standard CodeQL action, scanning JavaScript/TypeScript on push to `main` and weekly schedule. Configure SARIF upload to GitHub Security tab. Should take <10 minutes once the repo is public — the paste-from-template path is well-trodden.
- **Where:** `.github/workflows/codeql.yml` (new file).
