# ADR 008 — GitHub App installation tokens are minted per-invocation, not cached

**Status:** Accepted

**Date:** 2026-05-01

## Context

Phase 1 introduces two workflow Lambdas that need to authenticate against the GitHub API as the Ironforge GitHub App: `create-repo` (PR-C.4b — provisions the user's repository) and `trigger-deploy` (PR-C.8 — fires `workflow_dispatch` against the provisioned repo's deploy workflow). Both need an installation access token, which is the GitHub-issued, repo-scoped, 1-hour-TTL credential the GitHub App SDK uses for API calls.

The auth flow has three stages:

1. **PEM** — the GitHub App's private key, stored in Secrets Manager since PR #41 under a CMK that meets ADR-003 criteria. Static; doesn't expire.
2. **JWT** — minted from the PEM, 10-minute TTL, signed RS256. Used only to call GitHub's `POST /app/installations/{installation_id}/access_tokens` endpoint.
3. **Installation token** — returned by that endpoint, 1-hour TTL, used as the bearer for subsequent GitHub API calls (`POST /orgs/.../repos`, `POST /repos/.../actions/workflows/.../dispatches`, etc.).

The per-invocation cost of running the full flow end-to-end is ~500ms–1s (one Secrets Manager call if the PEM isn't cached, plus one JWT mint, plus one HTTPS call to GitHub's token endpoint).

Phase 1's traffic profile is single-digit provisionings per day at portfolio scale. Each provisioning workflow has a ~5-minute end-to-end runtime (terraform apply dominates). The workflow has two GitHub-talking states (`create-repo`, `trigger-deploy`), so per-workflow cumulative auth latency is ~2s — about 0.7% of total workflow time.

The decision under consideration is: **should we cache the installation token across invocations to avoid re-minting it?**

## Decision

**Per-invocation token mint with no installation-token cache.** Each Lambda invocation does the full JWT-mint + installation-token-exchange flow. The installation token is used for the invocation's GitHub calls and discarded; nothing about it is persisted across invocations, across Lambdas, or in any external store.

Static credential material — the PEM itself — IS cached at module scope using a lazy-on-first-call pattern. That's a separate decision documented in `docs/conventions.md` § "Cold-start configuration loading" and is explicitly not what this ADR is about. The PEM doesn't expire; tokens do. The two have different risk profiles and different caching answers.

## Why per-invocation, not cached

### Latency cost is negligible at Phase 1 scale

~2 seconds cumulative across a 5-minute workflow is 0.7% overhead. Single-digit provisionings per day means cumulative GitHub API calls per day are also single-digit. There is no scale dimension on which 2s/workflow is load-bearing.

### Operational simplicity is significant

The per-invocation implementation is ~5 lines of code: read the cached PEM, mint a JWT, exchange for a token, return the token. No state to manage, no TTL tracking, no refresh-on-near-expiry logic, no concurrency reasoning. The correctness model is "if the function returns, the token is fresh and valid."

Cached implementations require: TTL tracking, refresh-on-near-expiry logic (with a margin so a request mid-flight doesn't get a token that expires before the response), concurrency handling for warm-Lambda instances reused across overlapping invocations, error fallback for mid-execution token expiration, and a clear semantics for cold-start vs warm reuse. ~50 lines of caching code with subtle correctness properties whose failure modes manifest as intermittent, hard-to-reproduce auth failures.

The asymmetry is sharp: 5 lines with deterministic behavior versus 50 lines with several testable-but-real failure modes, in exchange for ~2 seconds of latency that no user can perceive.

### Auditability is genuinely better

Per-invocation tokens give a 1:1 mapping from Lambda invocation to token mint. The audit narrative is straightforward: invocation X used a fresh token for execution X. With a cached token, attribution becomes many-to-one — token Y minted by invocation X but used by invocations X through X+n over 45 minutes. Correlating "which invocation made which GitHub call" requires reasoning about cache state across multiple Lambda containers — a non-trivial forensic burden.

CloudTrail's coverage limits matter here: it captures the Lambda invocation and the Secrets Manager `GetSecretValue` call, but not the JWT mint (in-memory crypto operation) or the GitHub API calls (external HTTPS). The audit advantage of per-invocation tokens isn't "full traceability" — it's that the partial trace CloudTrail provides is unambiguous at the invocation layer.

### Fail-fast on revocation

GitHub is the authoritative source on whether an installation token is valid. Revocation can happen for several reasons: the GitHub App is uninstalled from the org, an admin revokes the installation, the App's permissions are reduced, or an org-level setting (IP allowlist, SSO requirement) changes between mint and use. With per-invocation tokens, revocation surfaces immediately on the next mint attempt — the workflow fails clearly with an `IronforgeGitHubAuthError`, not with a confusing "your repo got created but the deploy webhook silently 401'd" partial-success state.

A cached token under any caching scheme keeps serving "valid-looking" tokens until its TTL expires. The window between revocation and detection is `min(TTL, time_until_next_cache_miss)` — for a 1-hour cache, that's up to an hour of provisioning workflows that look successful at the create-repo stage but fail mysteriously at the trigger-deploy stage with stale-token symptoms.

## Token caching vs. broader idempotency

Ironforge has three patterns that look like caching from a distance but follow different rules. Distinguishing them prevents future PRs from applying one pattern's rationale to a different pattern. The cost of the conflation is concrete: a future PR might propose "let's cache GitHub tokens the same way we cache idempotency records — we already do caching." That sentence sounds reasonable, but the caching-decision drivers are different (idempotency cache exists *because* the upstream wants deduplication; token cache would exist *despite* the upstream caring about freshness).

| Pattern | Cached? | Storage | Goal |
|---|---|---|---|
| HTTP-level request idempotency | Yes, deliberately | DynamoDB `IdempotencyRecord` (PR-C.0); 24h TTL; keyed by `sha256(idempotency-key + bodyHash + ownerId)` | Deduplicate user-driven retries of the same `POST /api/services` request |
| Workflow-level resource idempotency | Not "cached" — deterministic | None; SFN execution-name = jobId acts as native dedup; deterministic AWS SDK idempotency tokens for create operations | SFN-level retry safety + AWS SDK-level safety against double-creating |
| GitHub installation tokens | Explicitly not cached | None; mint, use, discard | Avoid the failure modes (latency-vs-staleness tradeoff, revocation-detection delay, attribution-loss, mint-concurrency reasoning) that caching would introduce |

The first two patterns are documented in `feedback_idempotency_patterns.md` (the "two-pattern principle"). This ADR adds the third leg implicitly: tokens are a third category, distinct from both.

## Alternatives considered

### Option 2 — Secrets Manager cache (cached installation token, refresh on miss)

Cache the installation token in a Secrets Manager secret with TTL metadata; consumers check expiry first, mint + write-back on miss. Cross-Lambda deduplication of mints.

**Rejected.** Two-sources-of-truth problem: GitHub is authoritative on token validity, Secrets Manager holds a snapshot. Revocation creates stale-cache hits — the failure mode where the token *looks* valid (signature correct, not expired by local clock, fetched from a trusted store) but isn't (revoked upstream). This is exactly the class of bug hardest to debug because every layer except the upstream says "fine."

Plus: another Secrets Manager secret to manage (key policy, IAM grants, rotation policy), race conditions when two cold Lambdas mint simultaneously and last-write-wins, blast radius widening (a compromised cached token has multi-Lambda reach, where a compromised per-invocation token expires within the invocation).

### Option 3 — In-memory cache per warm Lambda

Token cached in a module-scope variable. Cold starts re-mint, warm invocations reuse.

**Rejected.** The "free, no infrastructure" framing understates the ops cost. In-memory caching needs TTL tracking, refresh-on-near-expiry logic (with a safety margin so a request mid-flight doesn't get a token expiring before the response), concurrency reasoning for warm-instance reuse across overlapping invocations, error fallback for mid-execution token expiration, and clear cold-vs-warm semantics. ~50 lines of code with subtle correctness properties; failure modes are testable but real.

The benefit is marginal at Phase 1 scale: portfolio traffic means cold starts dominate, so the warm-reuse savings are small in practice. And cross-Lambda sharing is non-existent — `create-repo`'s warm cache doesn't help `trigger-deploy`'s cold start.

The worst case is concrete and structural, not just "an unlikely edge case." The state machine routes `create-repo` and `trigger-deploy` to different Lambda functions; even with warm containers they don't share memory, and AWS's warm-pool selection is non-deterministic across invocations of the same function. So within a single workflow execution, every Lambda's cache offered zero cross-invocation value but carried its full implementation cost on every call. The cache amortizes only when the *same Lambda function* is invoked multiple times in close succession — which doesn't happen in our state machine's current shape.

## When to reconsider

Reconsider Option 3 (in-memory cache) when any of the following triggers fire.

**Operational triggers** (internal metrics changed):

- **Provisioning rate sustained >10/hour.** At that rate, cumulative token-mint latency starts to matter and warm-reuse savings become meaningful. Below this threshold, the caching ops cost dominates the latency savings.
- **Token-mint latency becomes user-visible.** If wizard UX adds per-step progress feedback that surfaces the ~1s mint cost as a perceptible pause, cache the warm path.
- **Secrets Manager throughput limits.** GitHub App PEM reads are throttled per-secret. At sufficiently high mint rates the rate-limit response becomes a real failure mode; caching the parsed PEM at module scope already addresses this for now, but if PEM rotation becomes frequent enough that warm Lambdas re-fetch, this trigger fires.

**External signal trigger** (authoritative source spoke):

- **Documented GitHub Apps guidance changes.** If GitHub publishes guidance shifting toward "always cache installation tokens" (e.g., performance recommendations, rate-limit policy changes) or "never cache for security reasons" (e.g., revocation-detection requirements, compliance), that authoritative signal warrants reconsideration regardless of internal metrics. The discipline is "review GitHub Apps docs annually as part of dependency review"; this trigger fires when that review surfaces a shift.

When reconsidering: lift the implementation pattern from a known-good library (octokit-app's auth strategies have a tested in-memory cache option) rather than rolling our own. Don't reconsider Option 2 — the two-sources-of-truth and revocation-detection problems are durable across Phase 1 scale and durable against external guidance changes (GitHub doesn't recommend external-store caching for security reasons that won't change).

This deferral is tracked in `docs/tech-debt.md` § "Future optimization: in-memory GitHub App token cache".

## Related

- **ADR-003** — CMK criteria. The GitHub App secret meets criteria 1+2; PEM is encrypted under a dedicated CMK.
- **ADR-006** — Lambda permission boundary. Amended in PR-C.4a to add `kms:Decrypt` for the boundary widening that lets workflow Lambdas decrypt the github-app-secret PEM.
- **PR-C.0** — `IdempotencyRecord` (HTTP-level cache) and deterministic execution-name (workflow-level dedup). The two patterns this ADR's "Token caching vs. broader idempotency" section contrasts against.
- **PR #41** — `infra/modules/github-app-secret/`. Where the PEM landed and where the consuming-principal CMK grant skeleton waits for activation in PR-C.4b.
- **`docs/conventions.md` § "Cold-start configuration loading"** — captures the lazy module-scope PEM cache as a separate pattern from token caching.
- **`docs/tech-debt.md` § "Future optimization: in-memory GitHub App token cache"** — the deferred-optimization tracker with the four triggers above.
- **`feedback_idempotency_patterns.md`** (auto-memory) — the two-pattern principle this ADR extends with a third explicit category.
