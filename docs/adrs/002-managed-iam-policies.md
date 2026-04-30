# ADR 002 — When to use AWS managed IAM policies vs custom

**Status:** Accepted (2026-04-27); amended 2026-04-30 — see § Empirical reality.

**Date:** 2026-04-27

## Context

CLAUDE.md mandates least-privilege IAM:

- "No `Resource: "*"` on `iam:*`, `sts:AssumeRole`, or anything granting elevation."
- "Lambdas have purpose-specific roles. No shared `ironforge-lambda-role`."
- "All cross-service access via specific IAM roles, not shared keys."

Most AWS managed policies, by virtue of being general-purpose, use `Resource: "*"` and broad action lists. Strict reading of CLAUDE.md would reject them in all cases.

But AWS provides certain managed policies specifically for service-to-service integration patterns where the access boundary is enforced by the role's *trust* policy rather than its *permission* policy. `AWSBudgetsActionsWithAWSResourceControlAccess` was the canonical motivating example: it grants `iam:Attach*Policy` on `Resource: "*"`, but the role attached to it can only be assumed by `budgets.amazonaws.com` and only for actions on a specific budget. (See § Empirical reality below — that example does not actually work in practice; the four-criteria rule remains valid as governance, but its motivating case turned out to be a category we cannot consume directly.)

Rejecting managed policies wholesale would force us to rewrite well-vetted AWS code, often introducing subtle bugs (missing actions for new AWS features, etc.). Accepting them wholesale violates the spirit of CLAUDE.md.

This ADR codifies the boundary.

## Decision

**Default: write custom IAM policies, scoped tightly to specific resources.**

**Exception — AWS managed policies are acceptable when ALL of the following apply:**

1. The policy is purpose-built for an AWS service-to-service integration (typically with the `aws-service-role/` path on its ARN).
2. The IAM role's trust policy restricts assumption to a specific AWS service principal (e.g., `budgets.amazonaws.com`, not `*`).
3. The trust policy includes confused-deputy protections via condition keys: at minimum `aws:SourceAccount`; ideally also `aws:SourceArn` scoped to the specific resource (budget, log group, etc.).
4. The role serves a single, narrow purpose. No general-purpose roles use managed policies.

**Always rejected:**

- `AdministratorAccess` on any role.
- `PowerUserAccess` on any role.
- Managed policies on Lambda execution roles (Lambdas need narrow custom permissions per CLAUDE.md).
- Managed policies on roles assumable by humans (CLI users, console operators, break-glass).
- Managed policies on roles assumable by AWS services without confused-deputy protection in the trust policy.

## Empirical reality (added 2026-04-30)

When we attempted to actually attach `AWSBudgetsActionsWithAWSResourceControlAccess` to `ironforge-budget-action-executor` during the April 2026 cost-safeguard E2E verification attempt, AWS rejected it with `PolicyNotAttachable: Cannot attach AWS reserved policy to an IAM role`. The policy lives at `arn:aws:iam::aws:policy/aws-service-role/...`, and AWS reserves policies on that path for service-linked roles (SLRs) — roles AWS creates and manages on a service's behalf, not customer-managed roles like ours.

This is the rule, not the exception. AWS managed policies designed for service-to-service integration patterns are largely SLR-reserved precisely because they encode permissions that assume AWS itself controls the role's lifecycle. Criterion 1 of § Decision (`aws-service-role/` path) is therefore in tension with the empirical attachability constraint: the very policies most likely to satisfy the four-criteria exception are also the ones AWS won't let us attach.

What this means for ADR-002:

- **The four criteria remain sound as governance.** If AWS ever ships a customer-attachable managed policy that meets all four, this ADR governs the decision. The criteria are a forward-looking guardrail, not a current operational rule.
- **No current Ironforge resource qualifies.** A grep across `infra/` confirms zero `aws_iam_role_policy_attachment` resources and zero `arn:aws:iam::aws:policy/` references as of 2026-04-30. The original canonical example was the only attachment in the codebase, and it has been replaced.
- **Custom inline policies turned out to be both correct and tighter.** PR #30 (commit `f46913e`) replaced the budgets.tf attachment with a 10-line `aws_iam_role_policy` pinning Attach/Detach to a single deny policy via an `iam:PolicyARN` `ArnEquals` condition — strictly tighter than the AWS-managed policy was, with no maintenance burden beyond reviewing six action names. The "Always custom is busywork" rejection in § Alternatives considered was wrong in this case; custom won on every dimension.

When evaluating a future managed-policy candidate:

1. Check the policy ARN path. If it's `aws-service-role/`, it is almost certainly SLR-reserved — confirm by attempting an attachment to a throwaway customer-managed role before designing around it.
2. If it is empirically attachable, apply the four criteria from § Decision.
3. If it is not, write a custom inline policy.

## Consequences

**Positive:**

- Documented exception keeps reviewers and future-Ricky honest about the trade-off.
- Reviewers can assess managed-policy usage by checking the four criteria *and* the SLR-attachability check from § Empirical reality.
- Onboarding is easier for well-known service-integration patterns (Budgets, AWS Config, GuardDuty, etc.) — the rule is "default custom, escape hatch documented."

**Negative:**

- "AWS managed for service-to-service" is a judgment call; reasonable people might disagree on edge cases.
- A policy attached now might need refactoring if AWS adds new actions to it later that we don't want.
- The four-criteria rule has zero current instances. It exists as governance for hypothetical future cases, which means reviewers may forget it applies; future managed-policy attachment proposals should explicitly cite this ADR even if rejecting it.

## How to apply in code

There are currently no managed-policy attachments in the Ironforge codebase (confirmed 2026-04-30). The previously documented attachment in `infra/modules/cost-safeguards/budgets.tf` was replaced with an inline `aws_iam_role_policy` in PR #30 (commit `f46913e`) for the empirical-reality reasons above.

If a future case clears both the four criteria from § Decision and the SLR-attachability check from § Empirical reality, use this template:

```hcl
# AWS-managed policy <NAME>. Acceptable per ADR-002:
#   - Purpose-built for <SERVICE> service-to-service integration.
#   - Trust policy restricts assumption to <SERVICE>.amazonaws.com.
#   - aws:SourceAccount and (where applicable) aws:SourceArn conditions
#     prevent confused-deputy abuse.
#   - Role serves a single narrow purpose.
#   - Verified empirically attachable to a customer-managed role (<DATE>).
resource "aws_iam_role_policy_attachment" "<name>" {
  role       = aws_iam_role.<role>.name
  policy_arn = "arn:aws:iam::aws:policy/<path>/<NAME>"
}
```

The accompanying trust policy must include both `aws:SourceAccount` and (where the resource ARN is known) `aws:SourceArn` conditions. The "verified empirically attachable" line is non-negotiable — past assumptions about attachability turned out to be wrong.

## Alternatives considered

- **Always custom.** Originally rejected as busywork, but the budgets.tf case study (PR #30) showed custom inline policies are tighter, more reviewable, and avoid SLR-attachability risk entirely. The four-criteria rule remains as forward-looking governance, but in current practice every IAM permission set in the codebase is custom — and likely will remain so until AWS ships a customer-attachable managed policy that fits a use case we have.
- **Always managed where AWS provides one.** Rejected: violates least-privilege when the trust policy isn't strict, and most service-integration policies are SLR-reserved anyway.
- **Wrapper module that takes a managed-policy ARN and applies our extra constraints.** Rejected: over-engineered for current scale; with zero qualifying instances it would be pure speculative scaffolding.
