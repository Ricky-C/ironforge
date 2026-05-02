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

**Rationale.** Three properties matter, in this order:

1. **Fail-fast at deploy, not at first request.** A misconfigured Lambda should refuse to start, not start and then fail every user request with a runtime exception. The CloudWatch signal "Lambda failed to initialize" routes to operators immediately; "Lambda 500'd on the first call after deploy" routes to a confused user first.
2. **Parse cost paid once per warm Lambda, not per invocation.** Schema parsing, YAML parsing, PEM parsing — all are non-trivial one-time costs (~ms-tens-of-ms). Module scope amortizes them across the warm-Lambda lifetime.
3. **Lazy-on-first-call beats eager-on-import.** Eager parsing on import means tests that merely import the module (without exercising it) trigger full I/O — failing if a dev machine doesn't have AWS credentials, network access to Secrets Manager, etc. Lazy initialization keeps test setup cheap and makes "parse failure" a runtime concern only when the parse actually matters.

The combination — module-scope cache, lazy init, fail-fast on error — is a single pattern applied to multiple kinds of static configuration. Any Lambda that loads bundled or fetched config at startup should follow this shape. PR-C.5 (template renderer config), PR-C.6 (terraform module configuration), and any future Lambda with similar static-config needs inherit this pattern.

**What this is NOT a pattern for:** dynamic data that changes at runtime (DynamoDB reads, GitHub API responses, user inputs). Those should be fetched per-invocation and never cached at module scope — caching them produces stale-data bugs that are exactly the failure mode we want to avoid for tokens (see ADR-008).
