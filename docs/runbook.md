# Ironforge Runbook

Recovery procedures for the foundational pieces of Ironforge's Terraform-managed infrastructure: the state bucket, the state CMK, the lock table, and "I think state is wrong, what now." Each section follows a fixed shape — **Symptom / Diagnosis / Recovery / Prevention** — so an on-call can navigate by symptom string and find the relevant procedure quickly.

This is a Phase 0 skeleton. Sections are intentionally compact: enough commands and decision points to act under pressure, not polished prose. Polish lands when an incident reveals which sentences were unclear (tracked in `docs/tech-debt.md` § "`docs/runbook.md` polish beyond Phase 0 skeleton").

For cost-incident playbooks (budget-action triggers, anomaly response, account compromise), see `docs/EMERGENCY.md`.

**Resources referenced throughout:**

- S3 state bucket: `ironforge-terraform-state-<account-id>` (versioning enabled, CMK-encrypted, TLS-only)
- KMS key: `alias/ironforge-terraform-state` (rotation enabled, 30-day deletion window)
- DynamoDB lock table: `ironforge-terraform-locks` (on-demand billing)

Bootstrap procedure for all three: `infra/BOOTSTRAP.md`.

---

## 1. State-bucket recovery

### Symptom

Any of:

- `Error: failed to get shared config profile` or `NoSuchBucket: The specified bucket does not exist` from `terraform init`.
- `AccessDenied` on state read/write during plan or apply, despite IAM perms looking correct in `OIDC_BOOTSTRAP.md`.
- `terraform state list` returns empty but resources are known to exist in AWS.
- The S3 bucket is visible in the Console but state files appear missing or zero-byte.

### Diagnosis

```bash
# Does the bucket exist?
aws s3api head-bucket --bucket "ironforge-terraform-state-${AWS_ACCOUNT_ID}"

# Versioning enabled? (must be Enabled — versioning is the recovery mechanism)
aws s3api get-bucket-versioning --bucket "ironforge-terraform-state-${AWS_ACCOUNT_ID}"

# What state objects exist (current versions only)?
aws s3 ls "s3://ironforge-terraform-state-${AWS_ACCOUNT_ID}/" --recursive

# All versions and delete markers (the recovery surface)
aws s3api list-object-versions --bucket "ironforge-terraform-state-${AWS_ACCOUNT_ID}" \
  --prefix shared/terraform.tfstate

# Bucket policy still TLS-only and not unintentionally over-restrictive?
aws s3api get-bucket-policy --bucket "ironforge-terraform-state-${AWS_ACCOUNT_ID}" \
  --query Policy --output text | jq .
```

Confirm the calling principal is `ironforge-ci-apply` or your admin profile, not something unexpected. `aws sts get-caller-identity`.

### Recovery

**A. Specific state file accidentally deleted (versioning saves you):**

```bash
# Find the most recent non-delete-marker version
aws s3api list-object-versions \
  --bucket "ironforge-terraform-state-${AWS_ACCOUNT_ID}" \
  --prefix <composition>/terraform.tfstate \
  --query 'Versions[?IsLatest==`false`] | [0]'

# Remove the delete marker (which is what made the file appear "deleted")
aws s3api delete-object \
  --bucket "ironforge-terraform-state-${AWS_ACCOUNT_ID}" \
  --key <composition>/terraform.tfstate \
  --version-id <delete-marker-version-id>
```

The previous (non-deleted) version becomes current again. Re-run `terraform plan` to confirm.

**B. State file corrupted or rolled back to wrong content:**

```bash
# Inspect specific historical version
aws s3api get-object \
  --bucket "ironforge-terraform-state-${AWS_ACCOUNT_ID}" \
  --key <composition>/terraform.tfstate \
  --version-id <known-good-version-id> \
  /tmp/recovered.tfstate

# Validate it's the version you want
jq '.terraform_version, .serial, .resources | length' /tmp/recovered.tfstate

# Make it current by copying that version back over itself
aws s3api copy-object \
  --bucket "ironforge-terraform-state-${AWS_ACCOUNT_ID}" \
  --copy-source "ironforge-terraform-state-${AWS_ACCOUNT_ID}/<composition>/terraform.tfstate?versionId=<good-version-id>" \
  --key <composition>/terraform.tfstate
```

**C. Bucket itself deleted (worst case):**

The bucket can be re-created via `infra/BOOTSTRAP.md` Step 2, but **state files inside it cannot be recovered** — S3 versioning protects against object-level deletion, not bucket-level deletion. If you have local copies of `*.tfstate` from a recent CI run, push those into the recreated bucket. Otherwise the realistic options are: rebuild Terraform-managed resources by `terraform import` against still-existing AWS resources, or full greenfield reapply.

**D. Bucket policy edits broke access:**

The TLS-only policy in `infra/BOOTSTRAP.md` Step 2 is the canonical version. Re-apply it via `aws s3api put-bucket-policy --bucket <name> --policy file://...`. Be careful: a misconfigured `Deny` statement can lock out everyone including the editor.

### Prevention

- Versioning is enabled at create time and protects against object-level mistakes — confirm it stays enabled (drift detection in Phase 4 will catch this).
- The bucket has `force_destroy = false` everywhere it's referenced; deletions require explicit removal of that flag first.
- Phase 2: enable MFA delete on the bucket (one-way change; locks down version deletion).
- The CI apply role's identity policy scopes `s3:*` to `ironforge-*` patterns; review periodically for over-broad grants that might allow accidental cross-bucket damage.

---

## 2. CMK pending-deletion recovery

### Symptom

Any of:

- `KMSInvalidStateException: <key-arn> is pending deletion`.
- `AccessDeniedException` on `kms:Decrypt` against the state CMK.
- AWS sends an email "AWS KMS scheduled key deletion" with the state key's ARN.
- `terraform plan` fails to read state with a KMS error, even though the bucket is reachable.

The deletion window is **30 days** (set in `BOOTSTRAP.md`). Within that window the key is recoverable; after, it isn't, and any data encrypted with it (i.e. the entire state) is cryptographically inaccessible.

### Diagnosis

```bash
# Is the key actually scheduled for deletion?
aws kms describe-key --key-id alias/ironforge-terraform-state \
  --query 'KeyMetadata.{State:KeyState, DeletionDate:DeletionDate, KeyId:KeyId}'

# When was deletion requested? Who requested it? (CloudTrail event)
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=ScheduleKeyDeletion \
  --max-results 5 \
  --query 'Events[*].{Time:EventTime, User:Username, Source:CloudTrailEvent}'

# Confirm the alias still maps to the same key ID (someone could have re-pointed it)
aws kms describe-key --key-id alias/ironforge-terraform-state \
  --query 'KeyMetadata.KeyId'
```

### Recovery

**A. Within the 30-day window — cancel deletion immediately:**

```bash
# Cancel deletion
aws kms cancel-key-deletion --key-id <key-id-from-diagnosis>

# Re-enable the key (cancel-key-deletion leaves it Disabled by default)
aws kms enable-key --key-id <key-id>

# Verify
aws kms describe-key --key-id alias/ironforge-terraform-state \
  --query 'KeyMetadata.KeyState'
# expect: Enabled
```

Then immediately:

1. Investigate the CloudTrail entry — was this an accident, malicious, or a misconfigured automation?
2. Tighten the key policy if needed to deny `kms:ScheduleKeyDeletion` from non-emergency principals.
3. File a tech-debt entry for any policy hardening identified.

**B. Past the 30-day window — the key is gone:**

State files encrypted with that key are not recoverable through any AWS-side process. Realistic options:

1. If you have unencrypted Terraform plan output or local state copies from before deletion, rebuild from those.
2. Otherwise, treat all Terraform-managed resources as orphaned in AWS: keep the AWS resources alive, recreate the state bucket + a new CMK via `BOOTSTRAP.md`, then `terraform import` each resource by its real-world ID.
3. Worst case: `terraform destroy` is impossible without state, so AWS resources must be deleted manually (or via `aws-nuke` if account scope allows).

This is the scenario the 30-day window exists to prevent. Don't be in this scenario.

### Prevention

- 30-day deletion window is set in `BOOTSTRAP.md` and is the upper bound AWS allows; do not shorten it.
- Key rotation is enabled (`enable_key_rotation = true`) — rotation generates new key material annually, but the key ID and policy persist, so this is a defense-in-depth measure unrelated to deletion.
- Phase 1: CloudWatch metric filter on `ScheduleKeyDeletion` events targeting any `ironforge-*` CMK, alarming to the cost/security SNS topic. Tracked in `docs/tech-debt.md` § "CloudWatch metric filters and alarms on CloudTrail security events". The CloudTrail trail (PR-B) is the foundation; the filter is Phase 1 work.
- Periodic review of which principals have `kms:ScheduleKeyDeletion` against the state key. Currently that's root + the apply role's `kms:*` blanket grant; tightening is tracked in `docs/tech-debt.md` § "Tighten `kms:*` and other account-wide writes on `ironforge-ci-apply`".

---

## 3. Lock-table corruption

### Symptom

Any of:

- `Error: Error acquiring the state lock` followed by another principal's lock ID, when no other apply is genuinely in progress (e.g. a CI run was killed mid-apply).
- `terraform plan` or `apply` hangs indefinitely at "Acquiring state lock".
- `terraform force-unlock` returns an error indicating the lock entry is malformed.
- DynamoDB throttling errors against the lock table (very unlikely on on-demand billing, but possible).

### Diagnosis

```bash
# What's in the lock table right now?
aws dynamodb scan --table-name ironforge-terraform-locks \
  --query 'Items[*].{LockID:LockID.S, Info:Info.S}'

# The Info field includes who, when, and which workspace. Check it against
# active CI runs at https://github.com/Ricky-C/ironforge/actions — if no
# active run matches, the lock is stale.

# Is the table itself healthy?
aws dynamodb describe-table --table-name ironforge-terraform-locks \
  --query 'Table.{Status:TableStatus, ItemCount:ItemCount, Billing:BillingModeSummary.BillingMode}'
# expect: ACTIVE, on-demand billing
```

### Recovery

**A. Stale lock from killed CI run (most common):**

`terraform` itself prints the lock ID in the error — use that:

```bash
cd infra/envs/<composition>
terraform force-unlock <lock-id-from-error>
# Confirm prompt: yes
```

Verify the lock is gone:

```bash
aws dynamodb scan --table-name ironforge-terraform-locks --query 'Count'
# expect: 0 (or only entries for genuinely-running applies)
```

**B. Lock entry is corrupted or `force-unlock` won't accept it:**

Delete the row directly. The lock table's primary key is `LockID` — get it from the diagnosis scan:

```bash
aws dynamodb delete-item \
  --table-name ironforge-terraform-locks \
  --key '{"LockID":{"S":"<lock-id-from-scan>"}}'
```

**C. Lock table missing or unrecoverable:**

Locks are ephemeral — there is **no data loss** from recreating the table. Re-run `infra/BOOTSTRAP.md` Step 3. Active applies will fail to acquire a lock until the table is back; once it is, retry.

### Prevention

- CI workflows use `concurrency` groups (`infra-apply` group, `app-deploy` group) so two applies cannot race against the same composition.
- The apply environment has a 5-minute wait timer — if a stale lock is in place from an earlier run, the timer gives time to notice before approving the next apply.
- Phase 2: enable point-in-time recovery on the lock table (`PITRStatus = ENABLED`); cheap, gives 35-day rollback for the (small) lock-state history.

---

## 4. "I think state is wrong, what now"

### Symptom

The vague-but-real situation. Any of:

- `terraform plan` shows resources to create that you know already exist in AWS.
- `terraform plan` shows resources to destroy that you know are still in use.
- `terraform plan` shows attribute drift on resources you haven't touched.
- `terraform state list` is missing resources you can see in the AWS Console.
- You merged a PR but the apply ran on a stale plan (resources you removed are still in state).

### Diagnosis

Before acting, narrow what's actually wrong. Most of the time the answer is operator error, not state corruption.

```bash
# Are you in the right composition directory?
pwd  # should end in infra/envs/shared, /dev, or /prod

# Is the backend config pointing where you think?
cat backend.hcl

# What's actually in state?
terraform state list

# Refresh state from AWS to detect drift without modifying anything
terraform plan -refresh-only

# Compare state's view of a specific resource to AWS reality
terraform state show <address>
aws <service> describe-<resource> --<id-arg> <id>
```

Common categories:

| Symptom | Most likely cause |
|---|---|
| "Resource I created in Console isn't in state" | Resource exists in AWS but isn't Terraform-managed; `terraform import` if it should be |
| "Resource in state isn't in AWS" | Out-of-band deletion (Console, another tool, or another principal); `terraform state rm` if intentional |
| "Resource attributes don't match" | Drift from out-of-band edits, or an upstream provider field changed; `terraform apply -refresh-only` reconciles state to AWS |
| "Plan wants to recreate something stable" | Often a provider upgrade introducing a `ForceNew` attribute change; check the resource's CHANGELOG |
| "Plan diff is enormous" | Wrong composition, wrong workspace, or stale local cache; `rm -rf .terraform && terraform init -backend-config=backend.hcl` |

### Recovery

**A. Resource exists in AWS but missing from state (`terraform import`):**

```bash
# Identify the Terraform address (address used in your .tf file) and the
# AWS resource ID that goes with the resource type. Each resource type has
# its own ID format — see Terraform AWS provider docs.

terraform import <module.path.resource_type.name> <aws-resource-id>
```

After import, run `terraform plan` to confirm zero diff. If the plan shows attribute differences, your `.tf` config doesn't match the imported resource — adjust the config, not the state.

**B. Resource in state but no longer in AWS (`terraform state rm`):**

```bash
# Removes the resource from state without touching AWS. Use only when AWS
# truly doesn't have the resource and you don't want to recreate it.
terraform state rm <module.path.resource_type.name>
```

**C. Roll back state to a previous version (S3 versioning):**

State changes are durable from `terraform apply` onward. If a recent apply put state into a known-bad shape, the bucket's versioning lets you go back.

```bash
# List state versions for the relevant composition
aws s3api list-object-versions \
  --bucket "ironforge-terraform-state-${AWS_ACCOUNT_ID}" \
  --prefix <composition>/terraform.tfstate \
  --query 'Versions[*].{VersionId:VersionId, Modified:LastModified, Size:Size}'

# Pull the version you want to compare
aws s3api get-object \
  --bucket "ironforge-terraform-state-${AWS_ACCOUNT_ID}" \
  --key <composition>/terraform.tfstate \
  --version-id <version-id> /tmp/old.tfstate

# Inspect first
diff <(aws s3api get-object \
        --bucket "ironforge-terraform-state-${AWS_ACCOUNT_ID}" \
        --key <composition>/terraform.tfstate /dev/stdout) /tmp/old.tfstate

# If satisfied, copy the version back as the current
aws s3api copy-object \
  --bucket "ironforge-terraform-state-${AWS_ACCOUNT_ID}" \
  --copy-source "ironforge-terraform-state-${AWS_ACCOUNT_ID}/<composition>/terraform.tfstate?versionId=<version-id>" \
  --key <composition>/terraform.tfstate
```

Always inspect first. State rollback can be more disruptive than the original problem if it puts state behind reality (next apply would attempt to create things that already exist).

**D. Total reset of local working tree:**

Sometimes the issue is local cache, not remote state. `rm -rf .terraform .terraform.lock.hcl` and re-init. The lockfile is committed (PR #10) so reinit pulls the same provider versions.

### Prevention

- Apply only via CI, not locally. The CI workflow guarantees a known-clean working tree, the right backend config, and the right principal. Local applies are a primary source of "I think state is wrong."
- Phase 1+: drift detection. Tracked in `docs/tech-debt.md`; the long-term plan is a scheduled drift detector that compares Terraform state to AWS reality and surfaces deltas before they bite.
- Treat the `infra/envs/<composition>` directories as the single source of truth for "what exists." Don't create resources in the Console. If something must be created out-of-band (e.g., the bootstrap resources themselves), document it in `infra/BOOTSTRAP.md` and never let Terraform manage it.
- Versioning on the state bucket is what makes recovery procedure C work — keep it enabled.

---

## See also

- `infra/BOOTSTRAP.md` — initial creation of state bucket, CMK, lock table.
- `infra/OIDC_BOOTSTRAP.md` — CI roles, trust policies, identity policies.
- `docs/EMERGENCY.md` — cost-incident playbooks.
- `docs/cost-safeguards.md` — budget actions, deny policies, circuit-breaker design.
- `docs/tech-debt.md` § "`docs/runbook.md` polish beyond Phase 0 skeleton" — what this skeleton intentionally defers.
