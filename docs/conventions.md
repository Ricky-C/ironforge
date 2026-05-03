# Ironforge conventions

This document captures patterns established through Ironforge's design conversations that future PRs should follow without re-deriving. Conventions are distinct from two adjacent artifact types:

- **ADRs** (`docs/adrs/`) capture *decisions* — non-obvious architectural choices with rejected alternatives and "why this, not that" reasoning. An ADR exists because a reasonable contributor might pick differently without context.
- **Tech-debt entries** (`docs/tech-debt.md`) capture *known suboptimal state with deferred fixes* — work we've explicitly chosen not to do yet, with re-introduction triggers and an action plan.

Conventions capture *patterns we've already converged on*. There are no "rejected alternatives" to a convention — just "this is how we do this thing in Ironforge, and you should do it the same way unless you have a specific reason to differ." A pattern earns inclusion in this document when:

1. It has been applied at least twice in the codebase (single-use is just code, not a pattern).
2. Future PRs would otherwise re-derive it (i.e., it's not so obvious that everyone would land on it).
3. The cost of inconsistency is real — debugging time, incident risk, code-review friction, or onboarding burden.

Each entry uses a small template:

- **Pattern** — what to do, in one or two sentences.
- **Established in** — the PR(s) where the pattern was first locked in by design conversation, not just by accident.
- **Applied by** — the canonical reference(s) future contributors should read for working examples. This list grows over time, making convention durability self-documenting: a convention with five entries under "Applied by" is load-bearing; one with two might still be a coincidence.
- **Rationale** — the reason the pattern earns its consistency cost. Brief; the reader should be able to judge edge cases from the rationale rather than asking.

If a future PR finds itself fighting a convention, the right response is one of: (a) follow it anyway because the friction is small, (b) propose an amendment by editing the entry with a new "Established in" date and new rationale, or (c) write an ADR explaining why the convention doesn't apply to the new case. Don't silently diverge.

---

## Cold-start configuration loading

**Pattern.** Lambdas that consume static configuration (template manifests, credential PEMs, schema definitions, feature-flag bundles) load and parse the configuration at module scope, lazy-on-first-call, and fail fast on parse failure rather than degrading at runtime.

**Established in.**

- PR-C.3 (PR #56, 2026-05-01) — `services/workflow/validate-inputs/src/handler.ts` parses the bundled template manifest YAML at module load via `IronforgeManifestSchema.parse(yaml.load(manifestYamlText))`. A malformed manifest fails Lambda init, surfacing as `InitError` before any user request lands.
- PR-C.4a (2026-05-01) — `packages/shared-utils/src/github-app/get-installation-token.ts` lazily fetches the GitHub App PEM from Secrets Manager on first call, parses it (shape check), caches the parsed key in module scope. Token minting on subsequent invocations reuses the parsed key without re-fetching.
- PR-C.4b (2026-05-02) — `services/workflow/create-repo/src/handle-event.ts` `getConfig()` caches the four GitHub App env vars (secret ARN, app ID, installation ID, org name) at module scope on first call, fail-fast on any missing value. Same pattern; different kind of static config (env vars vs fetched).

**Applied by.**

- `services/workflow/validate-inputs/src/handler.ts`
- `packages/shared-utils/src/github-app/get-installation-token.ts`
- `services/workflow/create-repo/src/handle-event.ts`
- `services/workflow/generate-code/src/handle-event.ts`

**Rationale.** Three properties matter, in this order:

1. **Fail-fast at deploy, not at first request.** A misconfigured Lambda should refuse to start, not start and then fail every user request with a runtime exception. The CloudWatch signal "Lambda failed to initialize" routes to operators immediately; "Lambda 500'd on the first call after deploy" routes to a confused user first.
2. **Parse cost paid once per warm Lambda, not per invocation.** Schema parsing, YAML parsing, PEM parsing — all are non-trivial one-time costs (~ms-tens-of-ms). Module scope amortizes them across the warm-Lambda lifetime.
3. **Lazy-on-first-call beats eager-on-import.** Eager parsing on import means tests that merely import the module (without exercising it) trigger full I/O — failing if a dev machine doesn't have AWS credentials, network access to Secrets Manager, etc. Lazy initialization keeps test setup cheap and makes "parse failure" a runtime concern only when the parse actually matters.

The combination — module-scope cache, lazy init, fail-fast on error — is a single pattern applied to multiple kinds of static configuration. Any Lambda that loads bundled or fetched config at startup should follow this shape. PR-C.5 (template renderer config), PR-C.6 (terraform module configuration), and any future Lambda with similar static-config needs inherit this pattern.

**What this is NOT a pattern for:** dynamic data that changes at runtime (DynamoDB reads, GitHub API responses, user inputs). Those should be fetched per-invocation and never cached at module scope — caching them produces stale-data bugs that are exactly the failure mode we want to avoid for tokens (see ADR-008).

---

## Verifiable provisioning markers

**Pattern.** Workflow Lambdas that create or modify external resources (GitHub repos, branches, files, S3 buckets, etc.) leave a verifiable marker on the created resource that identifies the provisioning job that produced it. Idempotency checks on subsequent runs verify the marker matches *this* job before treating the existing resource as the result of an idempotent retry; absence or mismatch is a conflict, not a successful retry.

**Established in.**

- PR-C.4b (PR #58, 2026-05-02) — `create-repo` sets `custom_properties["ironforge-job-id"] = jobId` on every created GitHub repo. Idempotency check: GET the repo, check the property; match → idempotent retry; mismatch → `IronforgeGitHubRepoConflictError`; 404 → fresh create.
- PR-C.5 (2026-05-02) — `generate-code` puts `(Ironforge job <jobId>)` in the initial commit's message. Idempotency check: GET `refs/heads/main`, GET the commit, check the message contains the marker; match → return existing commit's metadata; mismatch → `IronforgeRefConflictError`; 404 → create initial commit.

**Applied by.**

- `services/workflow/create-repo/src/handle-event.ts`
- `services/workflow/generate-code/src/handle-event.ts`

**Rationale.** Without a marker, "the resource exists" is ambiguous — it might be the result of a prior successful run of THIS provisioning (idempotent retry, treat as success), the result of a prior failed run that left an orphan (conflict — operator cleanup needed), or an unrelated manual operator action (also a conflict). Treating any of these the same way is wrong:

- Mistaking an orphan for a retry-success silently overwrites or skips work, masking the prior failure.
- Mistaking a retry-success for a conflict blocks the workflow on a transient SFN retry.

The marker is structured: tied to the provisioning's `jobId` (a UUID generated at workflow kickoff). Markers don't collide across provisionings because UUIDs don't. Operators reading the marker see exactly which Job created the resource and can correlate with DynamoDB Job records, CloudWatch logs, and SFN execution history.

**Marker mechanism per resource type.**

Different resource types support different metadata channels. Choose the most structured one available — fall back to less structured only if no better option exists:

1. **Structured org/repo metadata (preferred)** — GitHub custom properties, AWS resource tags, repo topics. Survives content edits; not user-visible-by-default; designed for platform metadata.
2. **Resource-state fields** — git commit message, S3 object metadata. User-visible but conventional places for provenance markers.
3. **Content-embedded** — only as a last resort. Avoid because user edits to content can erase the marker.

**What this is NOT a pattern for:** ephemeral resources that don't outlive the provisioning workflow (e.g., SFN execution names, DynamoDB JobStep rows). Those use the natural-key pattern from PR-C.0's idempotency conventions, not markers.

---

## Template substitution boundary

**Pattern.** Template starter-code distinguishes between values known at generate-code time (substituted via `__IRONFORGE_<NAME>__` markers) and values known only after `terraform apply` (passed through GitHub Actions repo secrets, populated by trigger-deploy). The boundary is enforced by the renderer's leftover-marker check: any template that references an unsubstituted `__IRONFORGE_<NAME>__` after rendering throws `IronforgeRenderError` and surfaces the offending markers.

**Established in.**

- PR-C.5 (2026-05-02) — `templates/static-site/starter-code/.github/workflows/deploy.yml` migrated from `__IRONFORGE_DEPLOY_ROLE_ARN__` / `__IRONFORGE_BUCKET_NAME__` / `__IRONFORGE_DISTRIBUTION_ID__` to `${{ secrets.IRONFORGE_DEPLOY_ROLE_ARN }}` etc. The 3 affected values are run-terraform outputs, not known at generate-code time. SERVICE_NAME and DOMAIN remain as build-time placeholders.

**Applied by.**

- `templates/static-site/starter-code/.github/workflows/deploy.yml`

**Rationale.**

1. **State-machine ordering forces the boundary.** generate-code runs before run-terraform in the locked SFN order. Values that come from run-terraform's outputs (deploy role ARN, S3 bucket, CloudFront distribution) literally don't exist when generate-code runs. Any single-pass substitution mechanism would produce broken files.
2. **Code/infrastructure separation is the right architecture.** AWS resource ARNs, bucket names, and distribution IDs are infrastructure state. Embedding them in source files in the user's repo couples the user's code history to infrastructure rotations. Secrets rotation (e.g., revoking a deploy role and issuing a new one) becomes a one-line secret update instead of a commit to user-visible history.
3. **`${{ secrets.X }}` is the universally-recognized GitHub Actions pattern.** Operators, contributors, or tools reading deploy.yml understand it without learning Ironforge's substitution convention. Hardcoded ARNs in deploy.yml would be confusing ("why is my account ID in this file?").
4. **The renderer's leftover-marker check makes drift loud.** If a future template author re-introduces a runtime placeholder via the `__IRONFORGE_<NAME>__` convention, the post-render scan throws and surfaces the offending marker name. Drift surfaces at first invocation, not in production silently-broken deploys.

**Substitution boundary, classified.**

| Category | Substitution mechanism | Examples |
|---|---|---|
| Build-time known | `__IRONFORGE_<NAME>__` in source, substituted by generate-code's render map | SERVICE_NAME (from `event.serviceName`), DOMAIN (platform constant) |
| Runtime known (post-terraform) | `${{ secrets.IRONFORGE_<NAME> }}` in source, populated as repo secrets by trigger-deploy after run-terraform produces the values | DEPLOY_ROLE_ARN, BUCKET_NAME, DISTRIBUTION_ID |
| User-edited later | Plain content, no substitution | Page title, body content (user edits in their repo) |

**What this is NOT a pattern for:** values that aren't infrastructure state but ARE platform-derived (e.g., a service ID, an Ironforge platform version). Those are build-time-known at generate-code; use `__IRONFORGE_<NAME>__`. The boundary is "could this value change without my code being re-rendered?" — if yes, secrets; if no, build-time substitution.

---

## SFN-orchestrated polling pattern

**Pattern.** Tasks that wait on a long-running upstream condition use the SFN-orchestrated polling shape — Init Pass state + polling Task + Choice + Wait — rather than in-Lambda sleep loops. The polling Lambda is single-shot per invocation; SFN's Wait state schedules the next tick via `SecondsPath` consuming the Lambda's `PollResult.in_progress.nextWaitSeconds`. Per-tick state carries forward in the `pollState` bag inside the same PollResult; the polling Lambda narrows it via a per-Lambda Zod schema on the next entry. The polling Lambda enforces an elapsed-time budget by comparing against `pollState.startedAt` and throwing `IronforgePollTimeoutError` when exhausted — SFN's existing `Catch` on `States.ALL` handles the throw; there is no `failed` branch in the Choice state.

**Established in.**

- PR-C.7 (2026-05-03) — `services/workflow/wait-for-cloudfront/src/handle-event.ts` polls `cloudfront:GetDistribution` until `Status === "Deployed"` or the 20-minute elapsed budget exhausts. The state machine adds InitCloudFrontPolling (Pass), WaitForCloudFront (Task), WaitForCloudFrontChoice (Choice), WaitForCloudFrontWaitTick (Wait). Schedule lives in TypeScript inside the Lambda: `[30s, 30s, 60s, 60s, 60s, 90s]` then 90s indefinitely, bounded by the elapsed-time check.

**Applied by.**

- `services/workflow/wait-for-cloudfront/src/handle-event.ts`
- `infra/modules/step-functions/definition.json.tpl` — the four states implementing the loop.

**Rationale.**

1. **SFN is the workflow primitive (CLAUDE.md anti-pattern: "Step Functions is the workflow primitive").** In-Lambda polling makes Lambda the wait primitive. Wait states are free; Lambda execution time costs dollars. The architectural cost of putting waits in Lambda is structural, not just monetary.
2. **Lambda's 15-minute ceiling vs. tail upstream latency.** CloudFront propagation is usually 5-10 minutes but occasionally exceeds 15 minutes. In-Lambda sleep loops would create spurious failures on the long tail; SFN-orchestrated polling decouples wait time from Lambda execution time entirely.
3. **Testability.** Single-shot polling Lambdas test cleanly with injected `now()` and `getDistribution` seams. In-Lambda sleep loops require `setTimeout` mocking and time-traveling test scaffolding that the codebase otherwise has no need for.
4. **Init Pass state covers SFN's missing-path semantics.** `Parameters` blocks runtime-fail when a referenced JSON path doesn't exist, with no native default-value support. The Init Pass state seeds the discriminator the polling Lambda's first-tick branch accepts; alternatives (Lambda accepts nullable `previousPoll`, or `Parameters` skip on first tick via different state) all couple the Lambda or the SFN definition to "first tick is special" awareness.
5. **PollResult.failed reserved, not used.** The `PollResult.failed` discriminant remains in the shared schema for forward compatibility with polling Lambdas whose upstream has a terminal-but-not-thrown failure state (ACM cert `VALIDATION_FAILED`, etc.). WaitForCloudFront throws on budget exhaustion instead of returning `failed` so SFN's existing `Catch` populates `$.error` automatically — keeps the Choice state minimal (`succeeded` → exit, default → Wait). First `failed` consumer TBD.

**What this is NOT a pattern for:** synchronous upstream calls that complete in <30s (no polling needed), or workflow-level retries on transient errors (those are SFN `Retry` blocks at the task state, calibrated per-task in the retry table — see § "Per-task retry counts" in `docs/state-machine.md`). The pattern applies specifically when the upstream itself is asynchronous and exposes a "still in progress" status separate from "succeeded" / "failed."

---

## Offline terraform init via filesystem_mirror (not TF_PLUGIN_CACHE_DIR)

**Pattern.** The run-terraform Lambda runs `terraform init` in a no-egress execution environment — it cannot reach `registry.terraform.io`. To make init succeed offline, the handler writes a CLI configuration file at `/tmp/.terraformrc` declaring a `provider_installation { filesystem_mirror }` pointing at `/opt/.terraform.d/plugins/`, and exports `TF_CLI_CONFIG_FILE=/tmp/.terraformrc` to the spawned terraform process. The Dockerfile bakes the AWS provider binary at the conventional plugin path. Any provider not present in the mirror fails init explicitly via the mirror config's `direct { exclude = ["registry.terraform.io/*/*"] }` pairing — there is no fallback to network.

**Established in.**

- PR-C.6 (2026-05-02) — `services/workflow/run-terraform/src/handle-event.ts` writes `TF_CLI_CONFIG_CONTENT` to `/tmp/.terraformrc` on every invocation; spawn env includes `TF_CLI_CONFIG_FILE=/tmp/.terraformrc`. The Dockerfile (`infra/modules/terraform-lambda-image/Dockerfile`) lays out the provider at `/opt/.terraform.d/plugins/registry.terraform.io/hashicorp/aws/<version>/linux_arm64/`.

**Applied by.**

- `services/workflow/run-terraform/src/handle-event.ts` — the handler that spawns terraform.

**Rationale.**

1. **`TF_PLUGIN_CACHE_DIR` is INSUFFICIENT for offline init.** Even on a cache hit, terraform still contacts `registry.terraform.io` to verify the provider's version metadata. In a no-egress Lambda environment, that verification call hangs ~30s and then fails with a misleading "Failed to query available provider packages" error — easily misdiagnosed as a cache-path or permission issue. `filesystem_mirror` is the trust mechanism that makes terraform treat the local directory as authoritative; it does not perform the registry round-trip.
2. **The two configs serve different purposes.** `TF_PLUGIN_CACHE_DIR` is a performance optimization (cache hits avoid re-download for repeated inits across working directories). `filesystem_mirror` is a trust declaration (the local filesystem IS the registry; do not contact remote). The Lambda needs the latter, not the former. Setting both confuses the model and the failure mode is at runtime, not init time.
3. **Loud failure on missing provider.** The mirror config's `direct { exclude = ["registry.terraform.io/*/*"] }` companion forces every provider to come from the filesystem — any future template that pulls a provider not bundled in the image will fail at init with a clear "provider not in filesystem mirror" error, not a silent network hang. Surfaces template/image drift at the right place.
4. **Per-invocation rewrite is fine.** The handler rewrites `/tmp/.terraformrc` on every cold AND warm start. Idempotent; <1ms cost. Avoids a class of "config file from a previous invocation has stale paths" bugs that would surface only after a Dockerfile path change.

**Failure mode if mismechanized:** swapping `TF_CLI_CONFIG_FILE` for `TF_PLUGIN_CACHE_DIR` makes terraform init hang ~30s, exit non-zero with "Failed to query available provider packages." The Lambda's CloudWatch shows the timeout but no clear cause — operators have wasted hours diagnosing as a permissions or path issue. The convention is the load-bearing word "filesystem_mirror" in `TF_CLI_CONFIG_CONTENT`; if a future change drops it back to `TF_PLUGIN_CACHE_DIR`, this section is the recovery anchor.
