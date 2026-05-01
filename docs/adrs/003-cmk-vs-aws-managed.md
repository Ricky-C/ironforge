# ADR 003 — When to use customer-managed KMS keys vs AWS-managed encryption

**Status:** Accepted

**Date:** 2026-04-27

## Context

Earlier Ironforge code reflexively reached for customer-managed KMS keys (CMKs) on every encryption-at-rest decision: DynamoDB (Commit 3), the original draft of the cost-reporter log group (Commit 5). The reasoning was "best practice" / "senior signal."

On review during Commit 5, the question got pressed: *what does the CMK key policy actually enable that AWS-managed encryption doesn't?*

For the cost-reporter log group, the answer was nothing concrete. The logs hold cost-summary text and Cost Explorer query results — operational data, not sensitive content. The proposed CMK key policy with the `kms:EncryptionContext:aws:logs:arn` condition was scaffolding without any access-control benefit, since the log content wasn't sensitive in the first place.

Reflexive CMK usage adds:

- Key policy complexity (rotation, deletion windows, principal lists, EncryptionContext conditions).
- Operational risk (forgotten keys block recovery; broken policies break service).
- Cost (~$1/month per CMK).

Without a corresponding access-control or compliance benefit, this is over-engineering. AWS-managed encryption provides the same cryptographic guarantee at rest with zero customer-controlled key policy.

## Decision

**Default: AWS-managed encryption (no `kms_key_id`).** Same crypto strength, zero operational surface.

**CMK is justified only when at least one of the following applies:**

1. **Fine-grained decrypt control beyond IAM.** The key policy needs to restrict decryption to a principal subset narrower than IAM alone can express, or includes principals from outside the account.
2. **Cryptographic auditability.** CloudTrail key-usage events are required for compliance or forensics — typically because the data is regulated (PII, PHI, financial records).
3. **Content sensitivity.** The encrypted content would harm Ironforge or its users if exfiltrated even within the AWS account (e.g., actual secrets, customer-supplied keys, auth tokens).
4. **Compliance mandate.** A specific control framework requires customer-managed keys for the data class.

**Justification must be specific.** "Best practice" and "senior signal" are not justifications. The PR/commit must name which of the four criteria applies and what specifically the key policy enables.

## Applied to Ironforge resources

| Resource | Choice | Reason |
|---|---|---|
| Terraform state S3 bucket (BOOTSTRAP.md) | **CMK** | Criteria 1 + 2: state files reference sensitive resource ARNs and provider config; CloudTrail decrypt audit is meaningful for state access. |
| Cost-alerts SNS topic (Commit 4) | AWS-managed (`alias/aws/sns`) | No criterion applies; messages are alert text. |
| Cost reporter log group (Commit 5) | AWS-managed | No criterion applies; logs are operational data. |
| DynamoDB table (Commit 3) | **CMK currently — flagged for revisit** | At commit time the rationale was "best practice." Per this ADR, AWS-managed is the right default. Refactor in a follow-up commit. |
| Artifacts S3 bucket (Commit 6, planned) | AWS-managed | No criterion applies; artifacts are build outputs. |
| CloudTrail S3 log bucket (PR-B) | **CMK** | Criteria 1 + 2: this bucket *is* the audit trail. Key policy admits the `cloudtrail.amazonaws.com` service principal only with an `aws:cloudtrail:arn` EncryptionContext condition pinned to our trail's ARN — narrower than IAM can express. CloudTrail decrypt events on the key form the chain-of-custody record for the audit logs themselves. |
| CloudTrail CloudWatch log group (PR-B) | **CMK** (same key as the S3 bucket) | Same data as the S3-side logs, same audit purpose; sharing one key keeps the policy surface and rotation surface single. The `logs.<region>.amazonaws.com` principal is admitted only with an `aws:logs:arn` EncryptionContext condition pinned to this log group's ARN. |
| Secrets Manager secrets (future) | **CMK** | Criteria 1 + 3: actual secrets; fine-grained decrypt control matters. |

**General pattern: audit logs are a strong fit for CMK.** When a resource holds the forensic record (CloudTrail logs, future security-event archives, regulated audit data), criterion 2 applies almost by definition — the decrypt events on the key become part of the audit trail. Criterion 1 typically pairs with it because the key policy can pin the legitimate service principal via an `EncryptionContext` condition that IAM alone cannot enforce.

## CMK boundary tiering — when one CMK can encrypt multiple resources

When a CMK is justified per the four criteria above, the next question is whether *this* resource gets a dedicated CMK or shares one with peers. The unit of separation is the **trust boundary**, not the resource:

- **Tier 1 — Per-resource CMK.** Single high-impact resource with a distinct principal scope. The key's blast radius is exactly one resource: a leaked decrypt grant exposes that resource and nothing else. *Examples: GitHub App private key (PR #41), Terraform state CMK.*
- **Tier 2 — Per-trust-boundary CMK.** Multiple resources accessed by exactly the same principal set with exactly the same key-policy needs. One key, one rotation surface, one policy surface. *Existing example: the CloudTrail CMK encrypts both the S3 log bucket and the CloudWatch log group — same audit data, same principals, same EncryptionContext-bound access pattern. Future example: per-environment Lambda runtime config secrets, if and when they exist.*
- **Tier 3 — AWS-managed (AES256).** No principal-scoped access control needed. This is the default per the four criteria above.

**Rule:** prefer Tier 2 over Tier 1 when resources *genuinely* share a trust boundary; prefer Tier 1 over Tier 2 when in doubt.

**Reason for the asymmetry:** splitting a Tier 2 CMK into multiple Tier 1 CMKs later is operationally easy — decrypt with the old key, re-encrypt with the new key, swap consumers, then schedule the old key for deletion. Merging Tier 1 CMKs into a shared Tier 2 CMK requires either widening the original key's policy (potentially exposing all merged resources to the new principals) or migrating each resource individually — both are riskier and the merged policy is harder to undo if the assumption that the boundaries match turns out to be wrong. Choose the easier-to-undo direction when uncertain.

**Test before adding a resource to an existing CMK:** "Are the principals that need to use this key *exactly* the principals already on it, with no foreseeable divergence?" If no, new CMK.

CMK sprawl is real and worth tracking, but it's the lesser failure mode vs accidentally widening a key's blast radius by sharing it across boundaries that diverge later.

## Consequences

**Positive:**

- Reduces operational surface (fewer keys, fewer policies, lower chance of misconfiguration).
- Reduces cost.
- Makes CMK presence a real signal: "this resource has a CMK *because* X" — not "because we always do CMK."
- Forces the question to be answered before code is written.

**Negative:**

- Requires retroactive review of resources that were defaulted to CMK on the old principle. Commit 3's DynamoDB module is the immediate case.
- Requires future contributors to articulate why, not just default.

## Migrating away from a CMK

When a previously-CMK resource is downgraded to AWS-managed:

1. Update the resource to remove `kms_key_id` (or the equivalent CMK reference).
2. The first apply re-encrypts new data with the AWS-managed key; existing data stays under the old CMK until rewritten by AWS during normal operations.
3. Schedule deletion of the old CMK with a long enough window (30+ days) to recover if something needs decryption.
4. Update outputs and any downstream IAM policies that reference the old CMK ARN.

## Related

- `CLAUDE.md` § "Security Guardrails / Data" — encryption rules updated by this ADR.
- `docs/adrs/002-managed-iam-policies.md` — same "default vs justified exception" shape applied to IAM policies.
