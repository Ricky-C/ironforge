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

#### Tighten `kms:*` and other account-wide writes on `ironforge-ci-apply`

> **Co-required with Phase 1's first KMS CMK creation.** When the Phase 1 Secrets Manager CMK (or any other ironforge-managed CMK beyond the existing state and CloudTrail keys) lands, the same PR must also tighten the apply role's `kms:*` grant to enumerate every then-existing ironforge-managed CMK. Shipping a new CMK without the tightening leaves the previously-documented escalation path open for the new key.

- **What:** The apply role's identity policy (`OIDC_BOOTSTRAP.md` Step 4, sid `WriteAccountWideServicesIronforgeUses`) grants `kms:*`, `cloudfront:*`, `wafv2:*`, `acm:*`, `cognito-idp:*`, `events:*`, `apigateway:*`, `scheduler:*`, `xray:*`, `budgets:*` on `Resource: "*"`. The CI boundary's `Action: "*"` ALLOW does not cap these — only the DENYs (OIDC mods, self-modification, expensive services) constrain. The boundary's `Allow *` shape is itself deliberate (ADR-007); this entry tightens the identity policy, not the boundary. Concrete escalation path: `kms:PutKeyPolicy` against `alias/ironforge-terraform-state` followed by `kms:ScheduleKeyDeletion` would render the state bucket unrecoverable. Same shape for `cognito-idp:*` against any non-Ironforge Cognito pool that might exist in the account.
- **Why deferred:** At Phase 0 these services don't yet have customer-facing data flowing through them, the apply role is gated behind `environment:production` with required reviewer + 5-minute wait, and tightening requires care: several of these services have actions that don't support resource-level scoping (which is why they were broadened in the first place — see the `Note on cloudfront:*, wafv2:*, acm:*, cognito-idp:*, kms:*` comment in `OIDC_BOOTSTRAP.md`). A Phase 0 partial-tightening pass would also need revisiting once Phase 1 adds new ironforge-managed CMKs (Secrets Manager for the GitHub App private key, etc.) — better to tighten once with full information than twice with partial.
- **When to revisit:** **Primary trigger — Phase 1's Secrets Manager CMK lands.** That PR must include the apply-role tightening in the same commit (or as a tightly-coupled follow-on landing before the CMK reaches production). Other triggers: (a) the first non-Ironforge resource in the account that we don't want the apply role to be able to delete, (b) anyone external getting merge access to the repo.
- **Action:** Tighten in this order — (1) `kms:*` to `arn:aws:kms:us-east-1:<account>:key/*` plus a `kms:ResourceTag/ironforge-managed = true` condition; ensure every Ironforge-created CMK at the time of tightening (state CMK, CloudTrail CMK, the new Phase 1 Secrets Manager CMK, plus any others) carries the `ironforge-managed=true` tag so the condition matches them. Enumerate the CMK list explicitly in the apply-role-tightening commit message so future PRs that add CMKs know what to extend. (2) `cognito-idp:*` to the specific user-pool ARN once the pool exists. (3) For the remaining services where resource-level scoping isn't supported, add explicit entries to `docs/iam-exceptions.md` so the `Resource: "*"` is recorded as a known limitation rather than an oversight. Test the tightened apply role by running a normal `terraform apply` against the shared composition and verifying no permission denials.
- **Where:** `infra/OIDC_BOOTSTRAP.md` Step 4; `docs/iam-exceptions.md` (additions).

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

### Diagnostics breadcrumbs

These aren't deferred work — they're institutional knowledge captured at the point the lesson was learned, so future-Ricky troubleshooting a similar failure benefits from the breadcrumb. Adapted from the standard entry shape: Symptom / Cause / How to diagnose.

#### S3 bucket-policy `MalformedPolicy: Conditions do not apply...` failures return early on first invalid statement

- **Symptom:** `terraform apply` against an `aws_s3_bucket_policy` resource fails with `MalformedPolicy: Conditions do not apply to combination of actions and resources in statement`.
- **Cause:** AWS S3's bucket-policy validator is stricter than IAM's general policy validator and rejects condition-action mismatches at apply time. Specifically, every condition key in a statement must be valid for every action in that statement (or be a global condition key like `aws:PrincipalTag` which applies universally). Common mismatch: `s3:prefix` is supported by `s3:ListBucket` and `s3:ListBucketVersions` but NOT by `s3:ListBucketMultipartUploads`.
- **How to diagnose:** **Verify all statements**, not just the one cited in the error — the validator returns early on the first invalid statement, so the error message identifies one but does NOT confirm the others are valid. For each statement, list every action and check the AWS service authorization reference (https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazons3.html) for which condition keys each action supports. Cross-reference against the conditions in that statement.
- **Case study:** PR #33's `DenyCrossEnvListing` statement included `s3:ListBucketMultipartUploads` with an `s3:prefix` condition. Apply failed; the fix dropped that single action from the statement (`infra/modules/artifacts/main.tf`). Statement 2 of the same policy used `s3:*` + `NotResource` + `aws:PrincipalTag` substitution and was also under suspicion until docs verification confirmed each component is independently supported and the validator's "singular statement" wording matched only Statement 3.
- **Where:** AWS service authorization reference is the diagnostic source-of-truth; the inline comment in `infra/modules/artifacts/main.tf` (`DenyCrossEnvListing` statement) carries the action-specific reasoning forward in code.

### Supply chain

#### CodeQL workflow pending repo going public

- **What:** GitHub-hosted CodeQL (free for public repos) provides static analysis for security issues in TypeScript code. Not enabled — CodeQL on private repos is paid (Advanced Security), and the project hasn't gone public yet.
- **Why deferred:** Cost. The free tier requires public visibility; the paid tier isn't worth it for portfolio-scale code volume.
- **When to revisit:** When the repo flips to public (likely Phase 3 or Phase 4 when the demo mode lands and the project is portfolio-presentation-ready).
- **Action:** Add `.github/workflows/codeql.yml` using the standard CodeQL action, scanning JavaScript/TypeScript on push to `main` and weekly schedule. Configure SARIF upload to GitHub Security tab. Should take <10 minutes once the repo is public — the paste-from-template path is well-trodden.
- **Where:** `.github/workflows/codeql.yml` (new file).
