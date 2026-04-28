# ADR 005 — DynamoDB Multi-Table Per Environment (Exception to Shared-Resource Default)

**Status:** Accepted

**Date:** 2026-04-27

## Context

Ironforge defaults to **one shared AWS resource with prefix/key/audience-claim separation per environment**, not multiple physical resources per env. This default is recorded as a contributor convention and applies to S3 (shared bucket, dev/ and prod/ prefixes), Cognito (shared user pool, multi-client per env), SNS (shared topic, multi-subscriber), and similar resources.

DynamoDB does not fit this pattern. Commit 3 created `ironforge-dev` and `ironforge-prod` as two separate physical tables. This ADR documents the technical reason and accepts it as the principal known exception.

## The IAM limitation

DynamoDB supports IAM-level access scoping via the `dynamodb:LeadingKeys` condition key. This restricts a principal's actions to items whose partition key matches a specific value. Crucially, `dynamodb:LeadingKeys` supports **equality only**:

```json
{
  "Effect": "Allow",
  "Action": ["dynamodb:GetItem", "dynamodb:Query"],
  "Resource": "arn:aws:dynamodb:us-east-1:<account>:table/ironforge",
  "Condition": {
    "ForAllValues:StringEquals": {
      "dynamodb:LeadingKeys": ["SERVICE#dev#service-id-1", "JOB#dev#job-id-1"]
    }
  }
}
```

There is no `StringLike`, wildcard, or prefix variant for `dynamodb:LeadingKeys`. You cannot write a condition like *"PK starts with `SERVICE#dev#`"*. This is the load-bearing fact.

## Alternatives considered

### A. Single shared table with app-code env enforcement

- **Approach:** One table named `ironforge`. Partition keys carry env prefix (`SERVICE#dev#<id>`). App code prepends `<env>#` to keys on writes and filters by env on reads.
- **Rejected because:** Env isolation becomes correctness-dependent. A bug in the filter — or a missing filter on a new endpoint — silently grants cross-env access. Without IAM-layer enforcement, the isolation is only as good as the app code's correctness, which we can't bound. This is the same class of risk the Cognito audience-claim verification mitigates with cryptographic isolation; DynamoDB has no equivalent.

### B. Single shared table with IAM-enumerated partition keys

- **Approach:** One table. IAM policies list every legal partition key the principal can access.
- **Rejected because:** Brittle and unscalable. Every new service or job entry would require updating the IAM policy. Falls apart beyond proof-of-concept.

### C. Multi-table per env (CHOSEN)

- **Approach:** Two tables: `ironforge-dev` and `ironforge-prod`. Each Lambda role gets IAM grants scoped to its env's table ARN.
- **Operational cost:** Two tables to provision, monitor, back up. Two encryption configs (currently AWS-managed per ADR-003). Two PITR settings. Schema changes need to apply to both tables.
- **Why we accept it:** AWS-enforced IAM scoping by table ARN is bulletproof. Even a buggy app cannot cross envs because the Lambda's IAM grant doesn't reach the other table.

## Decision

Ironforge uses **one DynamoDB table per environment**: `ironforge-dev` and `ironforge-prod`. Each is provisioned via the same `infra/modules/dynamodb/` module from each env's composition.

This is the principal known exception to the shared-resource-default convention. New deviations from that convention require similar threat-model justification.

## Consequences

**Positive:**

- IAM-enforced env isolation. No app-code dependency.
- Operational simplicity per table — clean cleanup, clean backup, clean restore.
- Schema changes can be tested in dev without prod risk.

**Negative:**

- Two tables to maintain instead of one.
- Schema divergence is possible if the module is applied to one env without the other. Mitigation: schema lives in the shared module, both env compositions invoke it identically.
- Cross-env analytics (e.g., aggregate metrics across envs) need to query both tables.

## When to revisit

Revisit if AWS adds prefix/wildcard support to `dynamodb:LeadingKeys` (or an equivalent partition-key scoping mechanism). At that point, switching to a shared table with IAM-enforced env separation becomes viable.

## Related

- `feedback_shared_resources_default.md` (auto-memory) — the convention this ADR documents an exception to.
- `CLAUDE.md` § Architectural Philosophy — references this ADR in the parenthetical on the shared-resources bullet.
- ADR-003 — encryption defaults; the DynamoDB module follows AWS-managed encryption per that ADR.
