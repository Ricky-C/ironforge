Phase 1 shipped: a working serverless IDP that provisions a static site end-to-end in about 5 minutes. Phase 1.5 added deprovisioning. Across both, the lessons that cost the most weren't architectural; they were about which testing surfaces catch which kinds of bugs.

## Verification was the integration test

The thing that paid back the most was running the actual platform against real AWS at the end of each sub-phase. 15 fix-PRs across Phase 1 (#65-#75) and Phase 1.5 (#80, #82, #83, #84), and most of them weren't bugs in the unit-test sense. They were integration drift: IAM scope that didn't match what the code intended, an HTTP API throttling default that read like "unlimited" but actually meant "blocked", `force_destroy` state-vs-config semantics, CloudFront tail-latency that surprised the timeout budget. Unit tests covered handler logic; nothing exercised the full chain until I ran it by hand, and every run found something.

Wrap work surfaced more of the same. The README pass turned up an Astro→HTML mismatch in `PROJECT_OVERVIEW.md` that had survived six weeks of decisions. The cost-safeguards verification ran into a terraform 1.10 quirk where list-typed `TF_VAR_*` env vars trip a saved-plan type-equality check. Design conversations, implementation, end-to-end verification, and wrap each find bug classes the others miss.

## Decisions that earned amendments

The decisions that held up are the ones I wrote down with revision triggers built in. ADR-009 ("Lambda direct + template-derived IAM") got amended twice. First when the AWS provider plus terraform binary blew past the 250MB Lambda layer limit and I shipped a container image instead (PR-C.6 amendment). Second when CloudFront tail-latency caught the 600s timeout off-guard during Phase 1.5 verification (PR 6c amendment, 600s→900s). Neither amendment invalidated the ADR; they refined it. The original 3m47s nominal apply with 4× paper headroom was right; it just wasn't durable through tail variance.

Cleanup-on-failure destroy chain got promoted from tech-debt to active work mid-Phase-1 when the "manual cleanup tax exceeds fix-work cost" trigger fired during verification. The promotion convention worked exactly as designed: I read the trigger condition and decided objectively, not from whim.

The pattern: amendments aren't evidence a decision was wrong. They're evidence it was sound enough to refine.

## Things I'd do differently

Two principles I'd carry into a future Phase 1.

Integration tests on a real (test) account from day one, not phase-end. End-to-end verification at phase boundaries caught the gaps, but it caught them in multi-day iteration loops. A CI smoke-test that provisions a service on every PR would surface the same issues in 5-minute cycles. Worth a small ongoing AWS bill to compress the feedback loop.

Budget timeouts and resource limits against tail-latency observation, not nominal. The 600s `run-terraform` timeout was math-correct on the median CloudFront apply, but the long tail compresses headroom unpredictably. Calibrating against worst-case from the start would have skipped the empirical bump to 900s.

Honorable mention: terraform's config-only attributes are forward-only through destroy. Adding `force_destroy` mid-life means existing services need state surgery, not just a config update. Worth flagging in the mental model when designing modules.

---

Phase 1 functionally complete; the live `portfolio-demo` is the canonical artifact. Phase 2 is in scope-definition. Load-bearing items are in-flight orphan handling (what happens when an SFN execution mid-provision gets killed) and async destroy via SFN polling. Both point toward CodeBuild migration if and when the timeout ceiling becomes load-bearing again.
