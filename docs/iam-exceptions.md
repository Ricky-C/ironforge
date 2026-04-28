# IAM exceptions: services where Resource: "*" is required

Some AWS service actions don't support resource-level permissions per [AWS's service authorization reference](https://docs.aws.amazon.com/service-authorization/latest/reference/reference_policies_actions-resources-contextkeys.html). For these actions, IAM policies must use `Resource: "*"`. This document is the authoritative list of every Ironforge IAM policy where that exception applies and the AWS-imposed reason for it.

When `CLAUDE.md` says "No `Resource: "*"`", that's the default rule. This file is the explicit allowlist of exceptions.

## Adding an entry

When a new AWS-imposed `Resource: "*"` is unavoidable:

1. Confirm the limitation in AWS's service authorization reference (link the specific actions/resources page).
2. Add a row to the table below.
3. Add an inline code comment at the policy site that points here, e.g.:

   ```hcl
   # ce:GetCostAndUsage does not support resource-level permissions per
   # AWS service authorization reference. Resource: "*" is required.
   # See docs/iam-exceptions.md.
   ```

## Removing an entry

When AWS adds resource-level support to a previously-broad action:

1. Narrow the inline policy to specific resource ARNs.
2. Remove the inline code comment.
3. Delete the corresponding row below.

## Current exceptions

| Action(s) | Service | Reason | Used in |
|---|---|---|---|
| `ce:GetCostAndUsage` | AWS Cost Explorer | All Cost Explorer `Get*` actions are account-level only — no resource-level granularity. | `infra/modules/cost-safeguards/lambda.tf` (cost-reporter Lambda role) |
| `xray:PutTraceSegments`, `xray:PutTelemetryRecords` | AWS X-Ray | X-Ray write actions are account-scoped; no resource-level support. | `infra/modules/cost-safeguards/lambda.tf` (cost-reporter Lambda role) |

## Related

- `CLAUDE.md` § "Security Guardrails" / IAM rules — the default rule this file documents exceptions to.
- `docs/adrs/002-managed-iam-policies.md` — companion ADR governing when AWS-managed IAM policies are acceptable. `Resource: "*"` inside a managed policy is allowed only when the criteria there are met.
