# ADR 007 — CI permission boundary uses `Allow *` + DENYs (asymmetric to Lambda boundary)

**Status:** Accepted

**Date:** 2026-04-30

## Context

Ironforge has two permission boundaries:

- **`IronforgePermissionBoundary`** (ADR-006). Attached to every Lambda execution role. **Positive-list** ALLOWs scoped to `ironforge-*` resources, plus explicit DENYs for IAM management, `sts:AssumeRole`, and expensive services.
- **`IronforgeCIPermissionBoundary`** (`infra/OIDC_BOOTSTRAP.md` Step 2). Attached to `ironforge-ci-plan` and `ironforge-ci-apply`. **`Allow *` + DENYs** shape: a single `AllowEverythingByDefault` statement, then DENYs for OIDC-provider tampering, CI-role self-modification, boundary self-modification, and expensive services.

This asymmetry has been the operating posture since the boundaries landed. It was reaffirmed during PR #25 (CloudTrail enabling, 2026-04-29): expanding the apply role to manage a new service surface was a tightly-scoped sid added to the identity policy alone — the boundary required no edit. If the CI boundary had been positive-list like the Lambda boundary, that PR would have needed two coordinated edits (identity policy + boundary), and the boundary edit would have re-occurred for every subsequent service expansion.

This ADR codifies the asymmetry as deliberate so future contributors don't "fix" it by flipping the CI boundary to positive-list to match.

## Decision

**Keep the asymmetry.** The CI permission boundary remains `Allow *` + DENYs. The Lambda permission boundary remains positive-list. The two shapes reflect two different threat models and two different evolution pressures, both of which favor the chosen shape on each side.

## Why the asymmetry is deliberate

### Threat model — CI roles

- **Short-lived.** Each CI role is assumed for the duration of a single GitHub Actions workflow run (minutes), then the session expires. There is no persistent assumed identity an attacker can pivot from.
- **Human-gated.** `ironforge-ci-apply` is only assumable via `environment:production`, which has a required reviewer + 5-minute wait timer in GitHub. Every apply traverses a manual approval. `ironforge-ci-plan` is read-only.
- **Trust narrowly bound.** Both roles' trust policies use `StringEquals` (not `StringLike`) on the GitHub OIDC `sub` claim, pinned to specific repo + ref/environment combinations.
- **Two roles total.** The set is closed — `ironforge-ci-plan` and `ironforge-ci-apply`. New CI roles require explicit OIDC bootstrap work, not arbitrary creation.

The DENYs in the CI boundary cover the residual risks that remain even given the gates above: tampering with the OIDC provider, modifying the CI roles themselves, modifying the boundary, and creating expensive resources.

### Threat model — Lambda roles

- **Long-running.** Lambda execution roles are assumed continuously by the Lambda runtime, on every invocation, for the lifetime of the function.
- **Unattended.** No human approval per invocation. A buggy Lambda or compromised dependency runs immediately at scale.
- **Many roles.** One per Lambda. The set grows with every new Lambda in Phase 1+.
- **Per-role inline policies.** Each Lambda's inline policy is small and reviewed in the Lambda's commit, but the surface across many Lambdas is wide.

A positive-list boundary is the right shape for this threat model. It bounds blast radius even if a single Lambda's inline policy is misconfigured, and the closed Phase 1 set of Lambda permissions makes maintaining the positive list tractable.

### Evolution pressure

A positive-list CI boundary would need an edit on every PR that adds a new AWS service to Ironforge's surface — even when the intended scope is read-only or narrow. That's a recurring two-step manual update (boundary + identity policy) whose first step adds no security value when the identity policy is already tightly scoped. The DENYs do the load-bearing work; the boundary's positive list would be permanent churn for negligible defense gain.

A positive-list Lambda boundary, by contrast, edits only when a Lambda itself directly needs the new service. Lambdas are narrow and slow-growing — the boundary edits when the Lambda does. This is the right ratio.

## Validation — PR #25 (CloudTrail enabling)

PR #25 added CloudTrail to the shared composition and required `cloudtrail:*` (tightly scoped to `trail/ironforge-*`) and `/aws/cloudtrail/ironforge*` log group ARNs on `ironforge-ci-apply`. The change was confined to the role's identity policy; the CI boundary's `Allow *` accepted it without edit. The total manual step was a single `aws iam put-role-policy` against the live role, per the recurring pattern documented in the auto-memory `project_ci_role_expansion_pattern.md`.

If the CI boundary had been positive-list, the same PR would have required: (1) edit boundary to add `cloudtrail:*` ALLOW, (2) `aws iam create-policy-version` against the live boundary, (3) edit identity policy, (4) `aws iam put-role-policy`. Two coordinated AWS API calls instead of one, with the additional risk that step 1 lands but step 3 doesn't (or vice versa) leaving an inconsistent state.

## What this is NOT

- **Not a license for loose identity policies.** The CI apply role's identity policy still uses tight resource scoping where AWS supports it (`s3:* on arn:aws:s3:::ironforge-*`, `iam:* on arn:aws:iam::*:role/ironforge-*`, etc.). Account-wide writes that resist resource scoping (`kms:*`, `cognito-idp:*`, `cloudfront:*` and similar — documented in the note immediately following Step 4 in `infra/OIDC_BOOTSTRAP.md`) are tracked for tightening in `docs/tech-debt.md` § "Tighten `kms:*` and other account-wide writes on `ironforge-ci-apply`". That work is independent of this ADR — it tightens the identity policy, not the boundary.
- **Not a claim that the CI boundary is purely cosmetic.** The DENYs are load-bearing: they prevent CI-role self-escalation (modifying their own trust or attaching policies), boundary self-modification, OIDC-provider tampering, and creation of cost-runaway services. These constraints are durable across identity-policy edits because they live in the boundary, not in the role's own policy.
- **Not a claim the asymmetry is permanent.** See § When to reconsider.

## Alternatives considered

- **Flip the CI boundary to positive-list to match the Lambda boundary.** Rejected. Imposes recurring boundary edits on every service-expansion PR for negligible additional defense given the threat-model differences. PR #25 is the case study.
- **Per-CI-role boundaries (one for plan, one for apply).** Rejected. Both CI roles share the same threat model (short-lived, human-gated, trust-narrowed) and the same DENY surface. Splitting the boundary doubles maintenance for no asymmetry that matters.
- **Drop the CI boundary entirely; rely on identity policies + DENYs inside identity policies.** Rejected. The DENYs need to be durable beyond identity-policy edits — putting them in the boundary means a future identity-policy widening cannot accidentally remove them. Defense in depth is the point.
- **Symmetric positive-list on both, with the CI list explicitly broad (`s3:*`, `iam:*`, etc.).** Rejected as a non-decision. A "positive list" with `s3:*` on `Resource: "*"` is `Allow *` with extra steps and worse readability.

## When to reconsider

Trigger any of:

- **CI roles stop being human-gated.** If `environment:production` loses its required-reviewer requirement (e.g., to allow auto-apply on merge), the threat model shifts toward the Lambda model and a positive-list boundary becomes more justified.
- **External contributors get merge access to the repo.** Today the merge gate is "Ricky." If that changes, the trust policy's `sub` claim no longer narrows to a single trusted human, and additional boundary tightening becomes load-bearing.
- **The AWS service surface stops growing.** Once Ironforge's service catalog stabilizes (post-MVP, post-Phase-2), the recurring-edit cost of a positive-list boundary drops, and the trade-off shifts.
- **A real incident demonstrates the `Allow *` was load-bearing.** If a CI-role compromise turns out to have been bounded only by identity policy and DENYs (and a positive-list boundary would have caught it earlier), revisit.

When reconsidering, the conversion path is mechanical: enumerate the actual ALLOWs from `ironforge-ci-apply` and `ironforge-ci-plan` identity policies, drop them into the boundary as positive-list ALLOWs, and remove the `AllowEverythingByDefault` statement. The DENYs stay as-is. Test in a throwaway role first — a positive-list CI boundary that misses an action will silently break apply runs.

## Related

- ADR-006 — Lambda permission boundary. The shape this ADR contrasts with.
- `infra/OIDC_BOOTSTRAP.md` Step 2 — the actual CI boundary policy document.
- `infra/OIDC_BOOTSTRAP.md` — note immediately following Step 4 documenting services without resource-level scoping support; this ADR's "What this is NOT" section explicitly cross-references that surface.
- `docs/tech-debt.md` § "Tighten `kms:*` and other account-wide writes on `ironforge-ci-apply`" — independent identity-policy tightening, not blocked by this ADR.
- `project_ci_role_expansion_pattern.md` (auto-memory) — the recurring two-step manual update pattern; this ADR explains why that pattern is one step on the boundary side and one step on the identity side, rather than two-and-two.
