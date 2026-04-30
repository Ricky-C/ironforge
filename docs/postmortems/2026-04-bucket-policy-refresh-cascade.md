# Postmortem — Artifacts bucket policy refresh-cascade incident (2026-04-30)

**Status:** Workaround applied (cross-env statements disabled in PR #39); root cause unidentified; redesign required to re-enable.

**Severity:** Phase 0, no data exposure (bucket was empty). Would have been higher in Phase 1+ if Lambda consumers had been writing to the bucket.

## Symptom

`terraform apply` against the shared composition fails with:

```
Note: Objects have changed outside of Terraform
  # module.artifacts.aws_s3_bucket.artifacts has been deleted
  ...
Plan: N to add, 0 to change, M to destroy.
...
[ERROR] creating S3 Bucket (ironforge-artifacts-***): BucketAlreadyExists
```

The "has been deleted" message appears in `terraform`'s pre-plan drift-detection output. terraform interprets the bucket as gone, plans to create it fresh, schedules dependent sub-resources for replacement, executes the destroys, and then fails when AWS rejects the bucket creation because the bucket actually exists.

State is left with the destroys committed but no creates. Subsequent applies repeat the failure pattern indefinitely without intervention.

## Reproduction conditions

The failure is deterministic when:
1. The artifacts bucket has the cross-env bucket policy statements (`DenyCrossEnvObjectAccess` and `DenyCrossEnvListing`) attached in AWS at the start of the next apply.
2. The next apply runs `terraform apply` (which performs its own refresh + plan + apply, no saved plan).

The failure does NOT occur when:
- The bucket policy is absent or contains only `DenyInsecureTransport`.
- The same apply that adds the cross-env statements is also the one running (refresh sees the pre-state without the statements).

Reproduced twice across the incident timeline (see § Timeline).

## Timeline

| Time (UTC) | PR | Event |
|---|---|---|
| 18:26 | #33 | Apply fails with `MalformedPolicy` on `PutBucketPolicy` (unrelated bug — `s3:ListBucketMultipartUploads` doesn't support `s3:prefix`). Bucket policy not updated; pre-existing TLS-only policy remains. |
| 19:09 | #34 | Apply succeeds. Updates bucket policy to 3-statement version (TLS-only + `DenyCrossEnvObjectAccess` + `DenyCrossEnvListing`). State and AWS aligned. |
| 19:17 | #35 | Apply runs. Refresh produces `# bucket has been deleted` despite bucket existing. Plan: replace 5 sub-resources, create bucket. Apply destroys sub-resources successfully, then `BucketAlreadyExists` on bucket create. State left with destroys committed; bucket policy and 4 other sub-resources gone from AWS. |
| 19:34 | #36 | Apply hits same `BucketAlreadyExists` (same state divergence persists). |
| 20:01 | #37 | Recovery via Terraform 1.5+ `import` block in `infra/envs/shared/imports.tf`. Apply succeeds: imports bucket, re-creates 5 sub-resources including the 3-statement bucket policy. |
| 20:20 | #38 | Cleanup PR (removes the one-shot import block). Apply reproduces the PR #35 cascade exactly: refresh says "deleted," destroys the 5 sub-resources, fails at bucket create. |
| (this PR) | #39 | Recovery via second import block + cross-env statements DISABLED to break the loop. |

## Diagnostics performed

### CloudTrail queries

CloudTrail trail (`ironforge-cloudtrail`) captures all S3 management events for this account.

**Query 1:** Events on the artifacts bucket from any session.

```bash
aws cloudtrail lookup-events --lookup-attributes AttributeKey=ResourceName,AttributeValue=ironforge-artifacts-010438464240 --max-results 200 --output json
```

**Result:** 44 events on the bucket over the incident window. All from the `ironforge-ci-apply/GitHubActions` session ARN. Errors observed:
- `OperationAborted` on `DeleteBucketEncryption`/`DeleteBucketLifecycle`/`PutBucketEncryption` during apply phases. Standard S3 concurrency error during parallel mutations on the same bucket; terraform retried and these eventually succeeded.
- `MalformedPolicy` on `PutBucketPolicy` during PR #33 (separate, fixed in PR #34).

**Result:** Zero `AccessDenied`. Zero `NoSuchBucket` on the bucket itself. Zero refresh-API failures.

**Query 2:** Distinct sessions touching the bucket.

```bash
aws cloudtrail lookup-events --lookup-attributes AttributeKey=ResourceName,AttributeValue=ironforge-artifacts-010438464240 --max-results 200 --output json | jq -r '.Events | map(.CloudTrailEvent | fromjson | .userIdentity.arn) | group_by(.) | map({arn: .[0], count: length}) | .[] | "\(.count) events  \(.arn)"'
```

**Result:** Exactly one session — `arn:aws:sts::*:assumed-role/ironforge-ci-apply/GitHubActions`. Plan role (`ironforge-ci-plan`) does not appear; apply runs its own refresh in this workflow rather than using a plan-job-generated saved plan.

**Query 3:** Refresh-phase API calls during the failed PR #38 apply.

```bash
aws cloudtrail lookup-events --lookup-attributes AttributeKey=Username,AttributeValue=GitHubActions --max-results 200 --output json
```

**Result:** Apply role's refresh API calls (`GetBucketVersioning`, `GetBucketLifecycle`) executed at 15:20:34-35 local (20:20:34-35 UTC) and **succeeded** (`err=''`). No failed refresh calls visible. Subsequent calls at 20:20:40 returning `NoSuchLifecycleConfiguration`/`NoSuchPublicAccessBlockConfiguration`/`NoSuchBucketPolicy` were *post-destroy* re-reads, expected after the destroys had already removed those resources.

### Hypotheses ruled out

1. **Bucket policy denies refresh API calls.** Static analysis predicted no statement should fire on the apply role's bucket-level reads (NotResource includes the bucket ARN; ironforge-managed condition matches but doesn't gate alone). CloudTrail confirmed: no `AccessDenied` on any refresh API call from the apply role.

2. **`Statement 3` (DenyCrossEnvListing) firing on prefix-less ListBucket.** Was offered as a candidate, ruled out: per AWS IAM evaluation rules, when a condition key is absent from the request context, a non-`IfExists` operator returns null, and null result on a Deny statement means the deny does NOT apply. Confirmed against AWS IAM documentation.

3. **Plan-role permission gap.** Hypothesized that `ironforge-ci-plan` has narrower S3 perms than `ironforge-ci-apply`, and the plan job's refresh fails (generating a broken plan) while apply succeeds. Ruled out by Query 2: the plan role's session ARN never appears on the bucket, and apply runs its own refresh — there's no saved plan from a separate plan job.

4. **`MalformedPolicy` on policy validation.** Was the cause of PR #33's failure, but not this incident — the cross-env statements pass AWS's bucket-policy validator (PR #34 applied successfully).

### Hypotheses still unprovable

1. **terraform-aws-provider parses `${aws:PrincipalTag/...}` substitution in GetBucketPolicy responses incorrectly.** The provider's `aws_s3_bucket` Read function aggregates multiple S3 API responses to populate state. If the substitution variable in the response confuses the provider's parser and triggers internal "not found" logic, terraform would conclude "deleted" without any AWS-side API failure. Plausible but not proven without provider source review or `TF_LOG=DEBUG` evidence.

2. **HeadBucket (or another refresh API call) is not in CloudTrail's S3 management event coverage.** AWS documentation explicitly lists `GetBucketAcl`, `GetBucketTagging`, etc. as management events but is inconsistent on `HeadBucket`. If the failing call is invisible to CloudTrail, our diagnostics couldn't see it. Plausible but unverifiable from the event-log surface.

3. **State-file consistency interaction.** terraform's S3 backend stores state in `ironforge-terraform-state-*`. If state-read returns a stale or partial version, refresh might compute drift incorrectly. No evidence either way.

## Workaround applied (PR #39)

1. **Recovery import block** (`infra/envs/shared/imports.tf`) — re-attaches the bucket to terraform state so the apply can re-create the 5 destroyed sub-resources from config. One-shot; removed in a follow-up PR.

2. **Cross-env policy statements DISABLED** (`infra/modules/artifacts/main.tf`). The `DenyCrossEnvObjectAccess` and `DenyCrossEnvListing` statements are removed from `data.aws_iam_policy_document.artifacts`. Only `DenyInsecureTransport` remains. This breaks the empirical correlation pattern by removing the conditions under which the failure reproduces.

3. **Tech-debt entry** (`docs/tech-debt.md` § "Re-enable artifacts cross-env bucket policy after refresh-cascade redesign") — actionable plan with redesign direction and the verification gate.

4. **ADR-006 update** (`docs/adrs/006-permission-boundary.md`) — § "What we lose" mitigation #3 reverted from "in-place via PR #33" to "deferred to redesign" with cross-link to this postmortem.

5. **`docs/tech-debt.md` § "Diagnostics breadcrumbs"** — the entry I added in PR #38 about Terraform refresh false-positives is corrected; my hypothesis there about NotResource semantics turned out to be wrong, and the corrected entry references this postmortem rather than asserting a mechanism we couldn't prove.

## Outstanding work

### Re-enable the cross-env policy with a redesign

Not a tweak. Restructuring required:

- **Split object-level vs bucket-level deny statements**, with explicit action lists rather than `s3:*`.
  - Object-level statement: `s3:GetObject*`, `s3:PutObject*`, `s3:DeleteObject*`, `s3:RestoreObject`, `s3:AbortMultipartUpload`, `s3:CreateMultipartUpload`, etc. (explicit enumeration).
  - Bucket-level statement: either left unrestricted (rely on identity policies + permission boundary for that layer) or scoped via a different mechanism.
- **Or move cross-env enforcement off the bucket policy entirely** — use an IAM-side mechanism (permission boundary `Deny` or service-control policy), where terraform refresh isn't subject to the same evaluation path.

### Empirical-refresh-stability gate (mandatory before merge)

The next attempt must include this verification step before the redesigned policy lands. Static analysis ("the policy looks correct") is what cleared PR #34 and got us here. Don't repeat it.

Procedure:
1. Apply the redesigned policy on a feature branch against a real environment (the shared composition, post-recovery).
2. Wait for the apply to complete cleanly.
3. **Run `terraform plan` against the existing state** — same composition, no config changes, just plan.
4. **Confirm the plan output is `No changes`**: zero resources marked "deleted", "+ create", or "must be replaced" due to refresh drift.
5. If any resource shows refresh drift in step 4, the redesign reproduced the bug — do not merge. Iterate.
6. Only after step 4 returns clean does the redesign PR get approved.

This gate would have caught the original PR #34 cascade before PR #35. Making it a procedural requirement for the redesign is the durable fix.

### Investigation tasks (to identify the actual mechanism)

When the redesign session begins:
1. **Run `terraform apply` with `TF_LOG=DEBUG` set** in a dev-equivalent environment with the cross-env policy in place. Capture the full API call/response sequence. The HTTP-level traces will show what the AWS provider's `aws_s3_bucket` Read function actually sees, and which response triggers the "deleted" interpretation.
2. **Review terraform-aws-provider source for `aws_s3_bucket`** — specifically the Read function's drift-detection logic. Identify how it concludes "resource gone" from API responses.
3. **Check the AWS provider GitHub issue tracker** for similar reports involving `${aws:PrincipalTag/...}` substitution in bucket policies and refresh false-positives. If a known issue, capture the link in this postmortem.

## Lessons learned

- **CloudTrail's S3 management event coverage is necessary but not sufficient diagnostic surface.** Some terraform-provider-internal interpretations happen at a layer CloudTrail doesn't expose. `TF_LOG=DEBUG` should be the next-up diagnostic when CloudTrail comes back clean.
- **"The policy validates, applies, and looks correct" is not the same as "the policy is safe to leave in production state."** What matters is whether the *next* refresh against state-with-this-policy produces a clean plan. Make that a gate.
- **Recovery via Terraform `import` blocks works cleanly** for state divergence that doesn't repair itself. The one-shot pattern (import block in PR, remove in cleanup PR) is auditable and matches Terraform 1.5+ convention.
- **State-divergence loops are silent** — both PR #35 and PR #38 produced apparently-successful merges (the GitHub PR showed green) but apply failed. The merge-without-apply-success state needs a CI-side detection (alarm if `infra-apply` fails, even though the merge already happened) so future incidents surface immediately rather than at the next contributor's surprise.
