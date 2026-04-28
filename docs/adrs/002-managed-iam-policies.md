# ADR 002 — When to use AWS managed IAM policies vs custom

**Status:** Accepted

**Date:** 2026-04-27

## Context

CLAUDE.md mandates least-privilege IAM:

- "No `Resource: "*"` on `iam:*`, `sts:AssumeRole`, or anything granting elevation."
- "Lambdas have purpose-specific roles. No shared `ironforge-lambda-role`."
- "All cross-service access via specific IAM roles, not shared keys."

Most AWS managed policies, by virtue of being general-purpose, use `Resource: "*"` and broad action lists. Strict reading of CLAUDE.md would reject them in all cases.

But AWS provides certain managed policies specifically for service-to-service integration patterns where the access boundary is enforced by the role's *trust* policy rather than its *permission* policy. `AWSBudgetsActionsWithAWSResourceControlAccess` is the canonical example: it grants `iam:Attach*Policy` on `Resource: "*"`, but the role attached to it can only be assumed by `budgets.amazonaws.com` and only for actions on a specific budget.

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

## Consequences

**Positive:**

- Documented exception keeps reviewers and future-Ricky honest about the trade-off.
- Reviewers can assess managed-policy usage by checking the four criteria.
- Onboarding is easier for well-known service-integration patterns (Budgets, AWS Config, GuardDuty, etc.).

**Negative:**

- "AWS managed for service-to-service" is a judgment call; reasonable people might disagree on edge cases.
- A policy attached now might need refactoring if AWS adds new actions to it later that we don't want.

## How to apply in code

Every managed-policy attachment must have an inline comment explaining which exception criterion applies and pointing to this ADR. Example (from `infra/modules/cost-safeguards/budgets.tf`):

```hcl
# AWS-managed policy purpose-built for Budgets actions. Acceptable per ADR-002:
# the role's trust policy restricts assumption to budgets.amazonaws.com with
# aws:SourceAccount and aws:SourceArn confused-deputy protections, so the broad
# iam:Attach*Policy permissions only apply during AWS-Budgets-initiated invocations
# on this account's specific deny-50 budget action.
resource "aws_iam_role_policy_attachment" "budget_action_managed" {
  count = local.budget_action_enabled ? 1 : 0

  role       = aws_iam_role.budget_action[0].name
  policy_arn = "arn:aws:iam::aws:policy/aws-service-role/AWSBudgetsActionsWithAWSResourceControlAccess"
}
```

The accompanying trust policy must include both `aws:SourceAccount` and (where the resource ARN is known) `aws:SourceArn` conditions.

## Alternatives considered

- **Always custom.** Rejected: rewriting `AWSBudgetsActionsWithAWSResourceControlAccess` inline is busywork, and AWS-maintained policies stay current as the service evolves.
- **Always managed where AWS provides one.** Rejected: violates least-privilege when the trust policy isn't strict.
- **Wrapper module that takes a managed-policy ARN and applies our extra constraints.** Rejected: over-engineered for current scale; revisit if managed-policy usage proliferates.
