# ADR 009 — `run-terraform` runs on Lambda direct, with template-derived IAM

**Status:** Accepted

**Date:** 2026-05-02

## Context

Phase 1's provisioning workflow culminates in `run-terraform` — the workflow state that creates the per-service AWS infrastructure (S3 origin bucket, CloudFront distribution, Route53 alias, IAM deploy role) by running `terraform apply` against the static-site template module at `templates/static-site/terraform/`.

This ADR locks two coupled decisions that determine the Lambda's architecture:

1. **Execution model** — does the Lambda run terraform itself, or does it offload to a long-running compute substrate (CodeBuild, Fargate)?
2. **IAM scoping mechanism** — how does the runner's IAM policy get authored, and how does it stay correct as templates evolve?

Both decisions earn ADR-level treatment because rejected alternatives are reasonable defaults that future contributors might pick without context. The original PR-C series plan flagged the execution model as one of two pre-implementation ADRs (the other was ADR-008's token caching).

### Empirical input

The architecture choice depends on a measurable number — actual terraform apply time for the static-site template — that wasn't measured at planning time. We measured it on 2026-05-02 against a throwaway composition with realistic inputs:

| Operation | Wall time | Dominant resource |
|---|---|---|
| Apply 1 (cold creation, 11 resources) | 3m47s | CloudFront distribution: 3m11s |
| Apply 2 (no-op, steady state) | 6.2s | All-state-cached path |
| Destroy (11 resources) | 3m33s | CloudFront distribution deletion: 2m56s |

The cold apply at 3m47s is ~25% of Lambda's 15-minute hard timeout — about 4× headroom.

**This measurement reflects a single apply against the static-site template on 2026-05-02. The number is a snapshot, not a constant.** Variance sources that could shift future measurements:

- CloudFront API latency varies day-to-day; historical evidence shows occasional 2-3× spikes during AWS regional events.
- AWS provider plugin upgrades may add or change step counts (e.g., a major version bump introducing a new pre-flight read or post-create wait).
- Account-specific factors (service quota limits, regional capacity, throttling policy changes) can shift timing without notice.

The 4× headroom from the nominal measurement absorbs reasonable variance. The "single apply exceeds 8 minutes" reconsideration trigger (§ "When to reconsider") fires when variance compresses headroom to ~2× — halfway to the ceiling — prompting CodeBuild migration before the ceiling is actually breached. The triggers are calibrated against the current snapshot specifically; if a new template's nominal apply is meaningfully different, its triggers should be re-derived.

## Decision

**Lambda direct, with template-derived IAM.** `run-terraform` is a single Lambda function that runs `terraform init && terraform apply` against the bundled template module via `child_process.spawn`. The Lambda's IAM execution policy is generated at build time from the template manifest's `allowedResourceTypes` whitelist (PR-C.1), through a per-template resource-type → IAM-actions mapping. Adding a resource type to a template requires updating both the manifest and the mapping; misconfigurations surface as `AccessDenied` at apply time, which the `IronforgeProvisioningError` taxonomy already routes through CleanupOnFailure.

State storage uses a dedicated `ironforge-tfstate-<env>` S3 bucket per environment, separate from the existing artifacts bucket. CMK encryption per ADR-003 criteria; per-service state lives at `s3://ironforge-tfstate-<env>/services/<service-id>/terraform.tfstate`.

## Why Lambda direct

### The 4× headroom is decisive at the measured scale

The 15-minute Lambda timeout is the primary constraint that would force option (b) CodeBuild. At 3m47s nominal, even pathological scenarios (CloudFront distribution propagation tail during AWS bad days) would need to slow apply by ~4× before hitting the ceiling. Across PR-B and PR-C historical telemetry, no single-resource AWS operation in the static-site template's chain has ever exhibited that magnitude of tail.

The static-site template's longest pole is CloudFront distribution creation (3m11s in the measurement). Critically, CloudFront *propagation* — the 5-15 minute window where the distribution status transitions from `InProgress` to `Deployed` — is **not** part of `terraform apply` (terraform considers the resource created when the API returns `InProgress`). Propagation is `wait-for-cloudfront`'s job, in a separate Lambda with its own polling loop and timeout budget. The misconception that terraform apply waits for full CloudFront propagation would have led to choosing option (b) on a wrong premise.

### Operational simplicity is significant

The Lambda direct shape is one Lambda function, one IAM role, one set of env vars. The CodeBuild alternative would have introduced: a CodeBuild project's IaC, a separate IAM role for the CodeBuild execution, source delivery from Lambda to CodeBuild (touching the artifacts bucket whose cross-env policy is currently disabled per the 2026-04 refresh-cascade postmortem), `.waitForTaskToken` SFN coordination with new failure modes, and per-build CodeBuild billing. None of these costs earn themselves at Phase 1 scale.

### Cost avoidance is concrete

CodeBuild's default `BUILD_GENERAL1_SMALL` instance bills at $0.005/min. At 4 minutes per provisioning, that's $0.02/run — negligible at portfolio scale, but the cost compounds with the IaC-management overhead of the project resource itself. Lambda runs are included in the existing free-tier-friendly budget and don't require new infrastructure.

### Empirical revisit triggers, not speculative migration

The decision is correct *for the measured number*, not for hypothetical future numbers. ADR-009 (this document) sets concrete triggers under § "When to reconsider" that move us to CodeBuild if the number changes meaningfully. Building CodeBuild today against a number we don't have would be premature optimization on speculation.

## Why template-derived IAM

### The whitelist principle from CLAUDE.md is load-bearing here

CLAUDE.md mandates: "Templates can only deploy specific resource types (whitelist, not blacklist)." The `run-terraform` Lambda's IAM policy is the load-bearing enforcement of that whitelist at the AWS API layer. A correctly-narrow IAM policy means "even if a template's terraform module declares an unauthorized resource type, the AWS API will reject the call." The whitelist becomes durable defense, not a doc-level convention.

### Hand-curated IAM without programmatic generation is a maintenance trap

The naïve hand-curated approach: a maintainer writes the union of IAM actions across all template resource types into the Lambda's policy. New template resource types require: editing the manifest's `allowedResourceTypes`, editing the IAM policy, ensuring they stay in sync.

Past evidence shows this kind of sync is reliably forgotten. Every CI role expansion in PR-B and PR-C surfaced as `AccessDenied` on the first real apply because the doc-driven IAM update was missed (CloudTrail PR #25, GitHub App PR #41, step-functions log groups PR #55). The pattern is captured as a saved feedback memory (`feedback_oidc_resource_enumeration.md`); manual sync is unreliable across the codebase, not just for one role's policy.

### Programmatic generation makes the manifest the source of truth

Build-time mapping derives the Lambda's IAM policy from the template manifest's `allowedResourceTypes`. Adding a resource type means: edit the manifest. The mapping (resource-type → IAM-actions) is itself a maintenance artifact, but the *trigger* for updating it is "an `AccessDenied` surfaces" — exactly the same recovery pattern as OIDC role expansion. The mapping lives in `packages/template-renderer/` (or a new sibling package); the Lambda's terraform module reads it at deploy time and generates the inline policy.

### Drift is real, and its blast radius is wider than OIDC role expansion

The mapping is a maintenance artifact that can drift from AWS reality: when AWS adds new actions to an existing service (rare), or when a template adds a new resource type without a corresponding mapping update (controlled change). When drift manifests, it surfaces as `AccessDenied` at apply time — the same recovery pattern as OIDC role expansion.

The drift's blast radius is wider than OIDC role expansion: every in-flight provisioning fails until the mapping is updated, not just the maintainer's CI role. Mitigations:

- The mapping lives in version control and changes go through PR review, the same scrutiny as any IAM policy change.
- The static-site template's existing resource types provide a reference set that future templates extend rather than replace from scratch — most new templates will be *additive* to the mapping, not from-scratch.
- `IronforgeProvisioningError` from a run-terraform AccessDenied routes through CleanupOnFailure; the partial-state cleanup (PR-C.2's status-writes-only baseline, with destroy-chain deferred) handles the affected provisioning gracefully even before the mapping fix lands.
- The CI plan stage shows the IAM policy diff explicitly when a mapping update lands, giving reviewers a concrete artifact to validate against the manifest's `allowedResourceTypes` change in the same PR.

### ARN scoping where AWS supports it; action-only where it doesn't

The mapping pairs each IAM action with the tightest ARN scope AWS supports. For services like S3 (`arn:aws:s3:::ironforge-svc-<service-name>-*`) and IAM (`arn:aws:iam::*:role/ironforge-svc-<service-name>-*`), name-prefix ARN matching narrows correctly. For services with ID-based ARNs (CloudFront, Route53, ACM), the action grants `Resource: "*"` because there's no name-prefix scoping available — these are added to `docs/iam-exceptions.md` as known-broad with the rationale.

The pushback on broad ARN-prefix scoping (`*` on `ironforge-svc-*`) is sharper than it first appears: ARN matching by name prefix doesn't work uniformly across AWS services. CloudFront ARNs use distribution IDs (`E1A2B3C4D5E6F7`), Route53 uses hosted zone IDs, ACM uses certificate UUIDs. A blanket `*` on a synthetic `ironforge-svc-*` prefix would over-grant to every CloudFront distribution and Route53 record in the account. Programmatic per-service ARN scoping is the only correct shape.

## Alternatives considered

### Option (b) — Lambda → CodeBuild

Lambda starts a CodeBuild project; CodeBuild runs terraform; Lambda waits via SFN `.waitForTaskToken`. **Rejected** because the 15-minute Lambda ceiling is not the binding constraint at the measured 3m47s nominal time, and CodeBuild's surface (project IaC, IAM, source delivery, callback coordination, per-build billing) doesn't earn itself. CodeBuild remains the migration target if the revisit triggers fire (§ "When to reconsider").

### Option (c) — Lambda → Fargate

Lambda starts an ECS Fargate task; Fargate runs terraform. **Rejected** on architectural grounds, not just cost. CLAUDE.md § Anti-Patterns explicitly forbids ECS for this project ("Using ECS or EKS for 'production feel.' No. Pure serverless."). CodeBuild dodges the anti-pattern guard because AWS markets it as a managed build service, not user-facing ECS; Fargate doesn't.

### Hand-curated IAM without programmatic generation

A maintainer authors the IAM policy by hand, with code review as the synchronization mechanism. **Rejected** because every prior project-wide IAM update — CloudTrail (PR #25), GitHub App (PR #41), step-functions log groups (PR #55) — surfaced its first AccessDenied at apply time despite code review. Manual sync is unreliable; programmatic derivation makes the doc/code drift impossible.

### Broad ARN-prefix IAM (`*` on `ironforge-svc-*`)

Single statement granting all actions on synthetic-prefix ARNs. **Rejected** because (a) the prefix-matching only works for services with name-based ARNs (S3, IAM); CloudFront, Route53, and ACM ARNs are ID-based and would over-grant; (b) this violates the whitelist principle by accepting "any future template can do anything to ironforge-svc-* resources" — exactly the loose-policy posture CLAUDE.md proscribes.

### Per-service S3 backend prefix on the existing artifacts bucket

State stored at `s3://ironforge-artifacts-<account>/terraform-state/services/<service-id>/`. **Rejected** because (a) state files contain a wider sensitivity class than build artifacts (full resource configuration, sensitive-but-non-secret values like deploy role ARNs, tag values); (b) couples state-bucket policy to the artifacts cross-env redesign (currently disabled post-refresh-cascade-incident, tracked in tech-debt); (c) the cost difference is $0/month — a single extra S3 bucket is free at portfolio scale; (d) cleaner CMK decision per ADR-003 — the dedicated state bucket meets criteria 1+2 (state files are high-value, audit on decrypt is meaningful).

## When to reconsider

Three triggers move the architecture from option (a) to option (b) CodeBuild. Each is concrete and observable.

**Operational triggers** (internal metrics changed):

- **Single apply exceeds 8 minutes.** The 4× headroom from the measured 3m47s drops to ~2× — the ceiling becomes a real concern under tail latency. Migrating to CodeBuild before the ceiling actually bites is preferable to debugging a timeout-failed provisioning under load.
- **A new template's nominal apply exceeds 5 minutes.** The static-site template's 3m47s is the floor; future templates with more resources, longer chains, or stateful dependencies could measure higher. Per-template execution-model evaluation becomes warranted.
- **Cleanup-on-failure destroy chain extends beyond 8 minutes.** The destroy timing measured (3m33s nominal) tracks apply timing. If destroy paths grow (per the deferred destroy-chain in PR-C.2's `cleanup-on-failure` tech-debt entry), the same trigger applies.

**Architectural trigger** (constraint changed):

- **A template's terraform module requires resource types that exceed Lambda's bundled-binary footprint.** Lambda layers cap at 250MB unpacked. Terraform binary (~80MB) + AWS provider plugin (~150MB) fit; adding a second provider (say, GitHub provider for repo-level resources) might push past the limit. CodeBuild has no such constraint.

### Migration path: bounded but non-trivial

When triggered, the migration to CodeBuild is bounded but **non-trivial** — not "mechanical." Required changes:

- New CodeBuild project (Terraform IaC defining the project, image, environment, source spec).
- New IAM role for CodeBuild execution. The template-derived IAM pattern from this ADR transfers unchanged; the role identity changes from Lambda's to CodeBuild's.
- Source delivery from Lambda to S3 to CodeBuild. Touches the artifacts bucket cross-env policy interaction (currently disabled per the refresh-cascade postmortem); needs to either use the dedicated tfstate bucket as the build-source delivery channel, or wait on artifacts-bucket redesign.
- SFN state changes from `Standard` task to `.waitForTaskToken` pattern — different state shape, different timeout calibration, different retry semantics.
- Error handling for CodeBuild-specific failures (BUILD_FAILED vs Lambda's structured error types). New `IronforgeCodeBuildExecutionError` likely.
- Migration runbook for in-flight provisionings — pause new provisionings, drain the in-flight set, swap, resume.

Estimated migration effort: **1-2 weeks of focused work**. The state storage and template-derived IAM patterns from this ADR survive the migration unchanged; the change is to *where* those patterns are applied and *how* the workflow coordinates with them.

This deferral is tracked in `docs/tech-debt.md` § "Future migration: run-terraform to CodeBuild execution model" with the four triggers above.

## Amendments

### 2026-05-02 (PR-C.6) — Binary-footprint trigger fired earlier than expected; container image Lambda chosen as deferral, NOT CodeBuild migration

**What triggered.** The architectural trigger from § "When to reconsider" — "A template's terraform module requires resource types that exceed Lambda's bundled-binary footprint" — fired during PR-C.6 commit 4's first attempt to build the Lambda layer. Empirical measurement against pinned terraform 1.10.4 + AWS provider 5.83.0 (linux_arm64):

- Unpacked layer size: **667MB** (Lambda layer cap: 250MB)
- Compressed zip: **144MB** (direct upload cap: 50MB; S3-hosted upload cap: 250MB)
- AWS provider 5.83.0 binary alone: **585MB**

The original ADR estimated provider footprint at ~150MB based on outdated information. The provider has bloated significantly — every minor version since 5.0 has added resource types (and the Go binary compiles them all in; there's no resource-level trimming). Even pinning to older 5.x versions does not bring the footprint within the layer cap.

**What changed.** The chosen response is **container image Lambda**, not the CodeBuild migration the ADR documented as the trigger response. AWS Lambda supports container images up to 10GB; this delivery mechanism solves the size constraint while preserving every other architectural decision in this ADR (Lambda direct execution, single Lambda, no `.waitForTaskToken` SFN coordination, template-derived IAM, dedicated tfstate bucket).

The migration: switch run-terraform's deploy artifact from zip+layer to a Docker image hosted in ECR. The `infra/modules/lambda` module gains support for `package_type = "Image"`. A new `infra/modules/terraform-lambda-image/` module wraps the Docker build (downloads + verifies terraform binary + provider via the same SHA256SUMS pattern; assembles into a Lambda-compatible container image; pushes to ECR). The Lambda handler logic — bundled via esbuild as before — gets copied into the image alongside the binaries.

**Why container image, not CodeBuild.** Three reasons:

1. **Smallest architectural delta.** Container image is a binary delivery change. Every other ADR-009 decision (execution model, IAM derivation, state storage, error handling) survives unchanged. CodeBuild would require a different SFN state shape (`.waitForTaskToken`), a separate IAM role, source delivery from Lambda to S3 to CodeBuild, and 1-2 weeks of migration per the ADR's own estimate.

2. **ADR-009 listed CodeBuild as the response to the binary-footprint trigger but didn't enumerate alternatives.** Container image Lambda is an alternative the original ADR didn't consider — it solves the same constraint with a smaller architectural delta. The original ADR's framing wasn't wrong; it was incomplete. CodeBuild remains the documented response if container Lambda's own constraints are exceeded (see new triggers below).

3. **Container Lambda is well-trodden.** AWS provides official base images, ECR is well-understood, the Docker build pattern is documented. The ~half-day setup cost is bounded.

**Honest about container-image costs.** This is not a free swap from the layer approach:

- New ECR repository (additional infra surface; separate IAM for the build pipeline).
- Docker build complexity in CI (additional build step, larger CI artifacts, Docker daemon dependency).
- Image lifecycle policies needed to prevent unbounded image accumulation in ECR (cost + repo scan time grow without retention).
- Multi-platform considerations: image is built for `linux/arm64` to match Lambda baseline; cross-platform builds require buildx setup if a developer's local machine differs.
- Cold start cumulative cost: container Lambdas have ~2-5s slower cold starts than zip Lambdas. For a single 4-minute provisioning, that's invisible. **If multiple workflow Lambdas later adopt the container pattern**, the cumulative cold-start cost grows.

These costs are bounded compared to CodeBuild's 1-2 week migration. They are real costs, not zero.

**This is a deferral, not a permanent answer.** Container image Lambda is the right move for shipping Phase 1 efficiently; it is NOT a refutation of the ADR's CodeBuild stance. CodeBuild remains the documented escalation. New triggers for the next escalation, calibrated against container Lambda's specific constraints:

- **Image size approaches 5GB.** AWS allows up to 10GB but image pulls slow significantly past 5GB cold-start cost becomes painful. Migrate to CodeBuild (which has no image size constraint).
- **Cold start cost becomes user-visible.** If wizard UX surfaces the per-Lambda cold-start as a perceptible pause, the cumulative ~2-5s × N-Lambda overhead matters. CodeBuild's per-build container is also slow but doesn't cumulatively pay across workflow steps.
- **2+ workflow Lambdas require container-image delivery.** If PR-C.7+ also need container-image delivery (e.g., wait-for-cloudfront with a custom polling tool), the operational surface (multiple ECR repos, multiple Docker builds in CI, multiple lifecycle policies) becomes substantial. At that point evaluate whether CodeBuild's unified compute substrate is operationally simpler than N container Lambdas — not because CodeBuild "consolidates" by some inherent property, but because one CodeBuild project can run different terraform invocations vs maintaining N parallel container-build pipelines.
- **Image build time exceeds 5 minutes per CI run.** Current build is ~90s (download + verify terraform + provider + docker build + push). If provider growth, additional binary tools, or lockfile resolution push past 5 minutes, CodeBuild's separate compute substrate runs the heavy work outside the merge gate.

When any of these fires, the ADR's original CodeBuild migration plan applies — the patterns from PR-C.6 (template-derived IAM, dedicated tfstate bucket, error taxonomy) survive the migration unchanged.

**Tracked.** `docs/tech-debt.md` § "Future migration: run-terraform to CodeBuild execution model" updated with both the original timing triggers and these new container-Lambda-specific triggers.

### 2026-05-04 (Phase 1.5 PR 6 verification) — 8-min apply trigger fired empirically; timeout bumped 600s → 900s, NOT CodeBuild migration (yet)

**What triggered.** The first operational trigger from § "When to reconsider" — "Single apply exceeds 8 minutes" — fired during Phase 1.5 PR 6 verification when the re-POST of `portfolio-demo` saw `run-terraform` time out at the 600s ceiling mid-`aws_cloudfront_distribution` create. Phase 1's run #12 measured 3:43 (tracking the ADR's 3m47s nominal); this run was still in apply at 10:00. CloudFront tail latency was the variance source.

**Why timeout bump and NOT CodeBuild migration.** The trigger fires when "the 4× headroom from the measured 3m47s drops to ~2× — the ceiling becomes a real concern under tail latency." The empirical observation (one apply at >10:00 vs nominal 3:47) confirms tail latency exists; it does NOT confirm that tail latency consistently exceeds 12 minutes (which would breach a 900s ceiling too). Bumping to Lambda's hard 900s ceiling buys 50% additional headroom against the same nominal — enough to absorb the observed variance. CodeBuild migration's 1-2 weeks of focused work doesn't yet earn itself against one observed timeout.

**Trade-off acknowledged.** This consumes the remaining Lambda headroom. There is no further raw-timeout escalation available — the next time the trigger fires, the answer is migration, not another bump.

**New triggers calibrated to the 900s ceiling:**

- **Single apply exceeds 12 minutes (75% of new ceiling).** Same headroom-erosion logic at the new ceiling. CodeBuild migration warranted.
- **Variance compresses headroom such that >5% of applies time out.** Statistical, not single-event. Operationally surfaces as cleanup-on-failure firing on a schedule rather than from real failures.
- **Any future template's nominal apply exceeds 600s.** The static-site template's 3:47 leaves the ceiling well clear; a future template with stateful resources or longer chains might not.
- **A second binary-footprint or compute-class constraint fires.** From the 2026-05-02 amendment's container Lambda triggers — image >5GB, cold-start user-visible, 2+ workflow Lambdas need container delivery, image build >5min.

**Related verification-discovered concern (Phase 2 architectural).** The 600s timeout was the proximate cause but not the only finding. The destroy chain only handles resources visible in `terraform.tfstate`; resources created in-flight during a failed apply can land as orphans (no state record → invisible to destroy). PR 6's failed run left a CloudFront distribution + OAC orphan that required manual cleanup. Tracked separately in `docs/tech-debt.md` § "Phase 2: destroy chain doesn't handle in-flight resources." Architectural options (tag-based orphan detection, pre-apply state snapshots, refresh-then-destroy) listed there.

**Where.** `infra/envs/dev/main.tf` § `module.task_run_terraform.timeout_seconds`; tech-debt entry on the in-flight-resource gap.

## Related

- **ADR-002** — managed IAM policies. The template-derived IAM is a custom policy generated programmatically; this ADR establishes that programmatic generation as the canonical pattern when manifest-derived constraints exist.
- **ADR-003** — CMK criteria. The dedicated `ironforge-tfstate-<env>` bucket meets criteria 1+2 (state is high-value, decrypt audit is meaningful).
- **ADR-006** — Lambda permission boundary. The run-terraform Lambda's identity policy lives within the boundary's caps; the boundary may need widening for terraform-driven actions (CloudFront, Route53 are already there from PR-C.1's anticipated needs; net-new actions land via the same amendment pattern PR-C.4a established).
- **ADR-007** — CI boundary asymmetry. The CI role's `Allow *` does not absolve the Lambda role from tight scoping; this ADR's programmatic derivation is the Lambda-side discipline.
- **ADR-008** — token caching. Comparable in shape: a workflow Lambda's behavior locked by an empirical-or-conceptual decision with rejected alternatives.
- **PR-C.1** — `templates/static-site/ironforge.yaml` `allowedResourceTypes` whitelist. The source of truth this ADR's IAM derivation reads from.
- **PR-C.5** — template-renderer package. The IAM-mapping module probably lives as a sibling package or extension.
- **`docs/conventions.md`** — § "Verifiable provisioning markers" (PR-C.4b/C.5) is the analog discipline at the resource-instance level; this ADR's template-derived IAM is the discipline at the resource-type level.
- **`docs/iam-exceptions.md`** — captures the unavoidable `Resource: "*"` actions for services without ARN-scopable APIs (CloudFront, Route53, ACM).
- **`docs/postmortems/2026-04-bucket-policy-refresh-cascade.md`** — the 2026-04 incident that left the artifacts bucket cross-env policy disabled. The dedicated `ironforge-tfstate-<env>` bucket decision is partly informed by avoiding coupling to that bucket's policy redesign.
- **`docs/tech-debt.md`** § "Future migration: run-terraform to CodeBuild execution model" — the deferred-optimization tracker with the four reconsideration triggers.
- **`feedback_oidc_resource_enumeration.md`** — the recurring AccessDenied-at-first-apply pattern this ADR's programmatic IAM derivation eliminates for run-terraform.
