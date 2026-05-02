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

## 5. GitHub org + App registration

### Symptom

Either:

- First-time Ironforge install: no GitHub org exists yet to hold provisioned repos, no GitHub App exists yet for the platform.
- Recovery: existing App private key compromised and the App needs full re-registration (rare — usually rotation alone is enough; see § 7).

### Diagnosis

```bash
# Does the org exist?
curl -s "https://api.github.com/orgs/<org-name>" | jq .login
# expect: "<org-name>" — null/error means org doesn't exist

# Does the App exist? (visit settings page in browser; no clean CLI way without auth)
# https://github.com/settings/apps for personal-account-owned Apps
# https://github.com/organizations/<org-name>/settings/apps for org-owned

# Is the App installed in the org?
# https://github.com/organizations/<org-name>/settings/installations
```

### Recovery

#### A. Create the GitHub org (skip if it exists)

1. Visit https://github.com/account/organizations/new.
2. Plan: **Free** (sufficient).
3. Org name: pick aligned with `ironforge-svc-*` naming convention. Suggestion: `ironforge-svc`.
4. Owner: your personal GitHub account.
5. After creation, **Settings → Member privileges**: Base permissions = None; Repository creation = Disabled for members. (The App is the principal that creates repos here, not org members.)
6. **Settings → Actions → General**: Allow all actions and reusable workflows.

#### B. Register the GitHub App

1. Go to https://github.com/settings/apps/new (registers under your personal account — simpler than org-owned for single-operator).
2. Name: `Ironforge Provisioner` (or similar; globally unique on github.com).
3. Homepage URL: `https://ironforge.rickycaballero.com`.
4. **Callback URL: empty** — we use installation tokens, not the OAuth user-authorization flow.
5. **Setup URL: empty.**
6. **Webhook: UNCHECKED.** No event-driven flow in Phase 1; this avoids managing a webhook secret.
7. **Repository permissions:**
   - Administration: Read and write
   - Contents: Read and write
   - Workflows: Read and write
   - Metadata: Read (mandatory)
   - Actions: Read
   - Pull requests: Read and write
8. **Organization permissions:**
   - Administration: Read and write (required for `POST /orgs/{org}/repos` to create repos in the org)
   - Members: No access
9. **Account permissions:** all No access.
10. **Where can this GitHub App be installed?** **Only on this account.**
11. Click **Create GitHub App**.
12. Note the **App ID** (top of the App's settings page; numeric, not secret).
13. **Private keys → Generate a private key.** Downloads a `.pem`. Save to `~/.ironforge-secrets/<app>.<timestamp>.pem` with the directory at `chmod 700`.

#### C. Install the App into the org

1. App settings page → **Install App** (left sidebar).
2. Click **Install** next to the org.
3. **Repository access: All repositories.** (Provisioned repos don't exist yet; the App needs blanket access in the org so it can create + manage every future provisioned repo. The org's own scope is the security boundary.)
4. After install, capture the **Installation ID** from the URL: `https://github.com/organizations/<org>/settings/installations/<INSTALLATION_ID>`.

#### D. Capture identifiers

Write to a temp file (e.g., `~/.ironforge-secrets/step1.txt`, `chmod 600`):

| Field | Sensitivity | Where it'll go |
|---|---|---|
| Org name | Not secret | `infra/envs/shared/terraform.tfvars` (gitignored) |
| App ID | Not secret | Same |
| Installation ID | Not secret | Same |
| `.pem` path | **Secret** | Stays on disk only until § 6 lands it in Secrets Manager |

### Prevention

- **Don't enable webhooks** unless and until there's a real event-driven flow to subscribe to.
- **Don't grant org-level Members write or any account-level permissions** to the App.
- **Don't commit the `.pem`.** Verify your `.gitignore` excludes `*.pem` before starting.
- **Don't paste the `.pem` into chat, email, Slack, or any GitHub Issue.**
- **Don't lose the App ID + Installation ID.** They're not secret but are needed for every API call. The App settings page shows the App ID; the install page URL shows the Installation ID — see § 5 Diagnosis above to recover them.

---

## 6. GitHub App private key — initial install

### Symptom

GitHub App registered (§ 5 complete), `.pem` on local disk, ready to land in AWS Secrets Manager. The Terraform module `infra/modules/github-app-secret/` declares the CMK, alias, secret resource (metadata), and SSM params — but the secret value itself never flows through Terraform per `feedback_secrets_via_import.md`.

Two valid bootstrap paths cover the two states the AWS-side resources can be in:

- **Path A (canonical) — fresh install, nothing in AWS yet.** Apply the CMK + alias + SSM params via targeted apply, then `aws secretsmanager create-secret` with the `.pem`, then `terraform import` the secret. Discipline-pure: Terraform never sees the value at any point.
- **Path B (recovery) — CI ran a full apply and created an empty secret first.** Happens when the github-app-secret module merges and `infra-apply` runs against shared composition end-to-end before the operator has a chance to do Path A. Same security property (value never in Terraform state), reached via `aws secretsmanager put-secret-value` against the already-existing empty secret resource.

Both paths achieve "the secret value never flows through tfvars/state/plan." Path A is preferred when achievable; Path B is the inevitable result of a normal merge-and-apply flow when Path A wasn't preempted.

### Diagnosis

Determine which path applies:

```bash
# Does the CMK alias exist in AWS yet?
aws kms describe-key --key-id alias/ironforge-github-app-private-key 2>&1 | grep -E "(NotFound|Enabled)"

# Does the secret resource exist?
aws secretsmanager describe-secret --secret-id ironforge/github-app/private-key 2>&1 | grep -E "(ResourceNotFound|ARN)"

# If the secret exists, does it have a current version?
aws secretsmanager list-secret-version-ids --secret-id ironforge/github-app/private-key 2>&1 | grep -E "(VersionId|ResourceNotFound)"

# .pem accessible
ls -la ~/.ironforge-secrets/*.pem
```

Decision matrix:

| CMK alias | Secret exists | Secret has version | Path |
|---|---|---|---|
| NotFound | NotFound | n/a | **A — fresh install** |
| Enabled | NotFound | n/a | **A — partial state**, complete from step 4 |
| Enabled | Yes | No | **B — empty secret from CI apply**, populate via put-secret-value |
| Enabled | Yes | Yes | Already bootstrapped — see § 7 if rotating |

If any state is unexpected (e.g., `NotFound` on the CMK but secret exists), don't proceed — figure out the prior state first.

### Recovery — Path A (canonical, fresh install)

Run from `infra/envs/shared/` with admin AWS credentials. Discipline-pure: Terraform never holds the value.

```bash
cd infra/envs/shared
```

1. **Plan** — confirm what will be created (CMK, alias, secret resource, three SSM params).

```bash
terraform plan
```

2. **Targeted apply** — create everything *except* the secret resource. The secret is created out-of-band in step 4 with the actual `.pem` value, then imported in step 5.

```bash
terraform apply -target=module.github_app_secret.aws_kms_key.github_app -target=module.github_app_secret.aws_kms_alias.github_app -target=module.github_app_secret.aws_ssm_parameter.org_name -target=module.github_app_secret.aws_ssm_parameter.app_id -target=module.github_app_secret.aws_ssm_parameter.installation_id
```

3. **Verify CMK exists.**

```bash
aws kms describe-key --key-id alias/ironforge-github-app-private-key --query 'KeyMetadata.{State:KeyState, Arn:Arn, RotationEnabled:KeyRotationStatus}'
```

Expected: `State: Enabled`, `RotationEnabled: ...` (key rotation is enabled).

4. **Manually create the secret** with the `.pem` value, encrypted with the CMK.

```bash
aws secretsmanager create-secret --name ironforge/github-app/private-key --description "Ironforge GitHub App private key (.pem) for repo creation in the org. Value managed out-of-band; rotate via update-secret." --secret-string file://${HOME}/.ironforge-secrets/<filename>.pem --kms-key-id alias/ironforge-github-app-private-key --tags Key=ironforge-managed,Value=true Key=ironforge-component,Value=github-app-auth Key=ironforge-environment,Value=shared
```

Capture the returned ARN.

5. **Terraform import** the secret resource against the now-existing AWS secret.

```bash
terraform import 'module.github_app_secret.aws_secretsmanager_secret.github_app_private_key' ironforge/github-app/private-key
```

6. **Verification gate** — the load-bearing step.

```bash
terraform plan
```

Expected: `No changes. Your infrastructure matches the configuration.` If the plan shows changes (description mismatch, tag drift, recovery_window mismatch, etc.), **fix the module to match the imported state** before proceeding. Do NOT apply changes that would alter the imported secret's metadata mid-bootstrap.

7. **Shred the local `.pem`.**

```bash
shred -u ~/.ironforge-secrets/<filename>.pem
```

(`shred -u` overwrites then unlinks. On macOS, use `srm` from the homebrew `secure-delete` package, or `rm -P` if available. If neither works, plain `rm` plus a full-disk encryption assumption is acceptable for a portfolio project but document the deviation.)

8. **Push the branch + open the PR + merge.** CI's `infra-apply` runs against the now-imported state; expected output is no-op against the secret resource.

### Recovery — Path B (CI-bootstrapped, populate empty secret)

Used when CI's `infra-apply` ran end-to-end after the github-app-secret module merged. Terraform created the empty `aws_secretsmanager_secret` resource (no version) — the value just needs to be added.

This is the path used during PR #41's initial deployment (2026-04-30): the operator merged before doing the targeted-apply dance, so CI created the empty secret first.

1. **Verify the secret exists with no current version.**

```bash
aws secretsmanager describe-secret --secret-id ironforge/github-app/private-key --query '{ARN:ARN, KmsKeyId:KmsKeyId, VersionStages:VersionIdsToStages}'
```

Expected: `ARN` populated, `KmsKeyId` is the github-app CMK ARN, `VersionStages` is empty/null.

2. **Add the first version with the `.pem` value.**

```bash
aws secretsmanager put-secret-value --secret-id ironforge/github-app/private-key --secret-string file://${HOME}/.ironforge-secrets/<filename>.pem
```

Output includes the new `VersionId`; AWS sets it as `AWSCURRENT` automatically since this is the first version.

3. **Verify the version is now `AWSCURRENT`.**

```bash
aws secretsmanager describe-secret --secret-id ironforge/github-app/private-key --query 'VersionIdsToStages'
```

Expected: one VersionId mapped to `["AWSCURRENT"]`.

4. **Shred the local `.pem`** (same as Path A step 7).

```bash
shred -u ~/.ironforge-secrets/<filename>.pem
```

Path B does NOT involve `terraform plan`/`apply` — Terraform manages the secret's metadata only, and its view of the resource is unchanged by `put-secret-value`. The next CI run will plan+apply with `No changes` for the secret.

### Prevention

- **Don't add `aws_secretsmanager_secret_version` to the module ever.** Adding it routes the value through Terraform state. The module deliberately omits it; keep it omitted. This is the load-bearing invariant that makes both Path A and Path B safe.
- **Don't put the `.pem` content into `terraform.tfvars`** (or any tfvars file). Both bootstrap paths exist precisely so the value never enters Terraform.
- **For Path A, don't skip the verification-gate `terraform plan` in step 6.** Static analysis can miss drift between module config and imported state; the empty plan is the only proof of bootstrap correctness.
- **For Path A, don't apply without `-target` in step 2.** Without `-target`, Terraform creates an empty `aws_secretsmanager_secret` itself — which is actually fine (it puts you on Path B), but defeats the purpose of choosing Path A in the first place.
- **For Path B, don't use `aws secretsmanager create-secret` after the empty resource exists.** AWS rejects with `ResourceExistsException`. Use `put-secret-value`.
- **Rotation uses § 7, not this procedure.** Re-running this procedure on a key-already-installed (current `AWSCURRENT` version exists) leads to ambiguous state.

---

## 7. GitHub App private key rotation

### Symptom

Any of:

- Periodic rotation (target cadence: every 12 months, aligned with the CMK's annual rotation).
- Suspected compromise of the private key (key found in a leaked file, accidentally committed, laptop stolen, etc.) — emergency rotation.
- GitHub forced rotation (rare; GitHub announces an issuer-key incident or the App is migrated).

### Diagnosis

```bash
# Confirm the secret currently in Secrets Manager
aws secretsmanager describe-secret --secret-id ironforge/github-app/private-key --query '{ARN:ARN, KmsKeyId:KmsKeyId, LastChanged:LastChangedDate, LastAccessed:LastAccessedDate}'

# What does the consuming Lambda last successfully decrypt? (When that role lands.)
# Future-Phase-1 diagnosis: check CloudWatch metrics on
# `secretsmanager:GetSecretValue` failures or KMS Decrypt denies.
```

### Recovery

1. **Generate a new private key in GitHub.** App settings page → **Private keys → Generate a private key**. Saves a new `.pem` to `~/.ironforge-secrets/<app>.<timestamp>.pem`.

2. **Update the secret value via CLI.** Terraform never sees the new value — same discipline as the initial install.

```bash
aws secretsmanager update-secret --secret-id ironforge/github-app/private-key --secret-string file://${HOME}/.ironforge-secrets/<new-filename>.pem
```

This creates a new `AWSCURRENT` version while preserving the prior one as `AWSPREVIOUS` in case immediate rollback is needed. Consumers calling `GetSecretValue` without a version stage receive the new current.

3. **(Optional) Delete the old GitHub-side private key.** App settings → Private keys → next to the old key, **Delete**. Important for emergency rotation; less critical for periodic. GitHub allows multiple active keys per App; deleting the old one is the actual revocation.

4. **Verify a consuming Lambda can still mint installation tokens.** When that Lambda exists (Phase 1+), trigger a workflow that exercises the path. For now (Phase 1 pre-Lambda), no operational verification beyond `aws secretsmanager get-secret-value` succeeding for an admin principal.

5. **Shred the new local `.pem`.**

```bash
shred -u ~/.ironforge-secrets/<new-filename>.pem
```

6. **Document the rotation.** Add an entry to a rotation log (TODO: create `docs/operations-log.md` when this happens for the first time) with: date, reason (periodic / compromise / forced), any anomalies. Future-you investigating an incident months later benefits from the trail.

### Prevention

- **Schedule the next rotation.** Use `/schedule` to set a 12-month reminder when this rotation completes.
- **Never re-use a `.pem` across rotations.** Each rotation gets a fresh GitHub-generated key.
- **Don't run `terraform apply` as part of rotation.** The Terraform module manages metadata; the value lives in Secrets Manager. There's nothing for Terraform to do during rotation.
- **If the consuming Lambda fails after rotation, suspect IAM, not Terraform.** Most likely cause: the workflow Lambda's role has stale credentials cached, or `kms:Decrypt` permission has drifted. Force a Lambda concurrent execution to refresh the role's KMS grants.

---

## 8. GitHub custom property bootstrap (PR-C.4b prerequisite)

### Symptom

`create-repo` Lambda invocations fail with the GitHub API rejecting `custom_properties: {"ironforge-job-id": ...}` in the create-repo POST body — typically with a 422 response and a message like "ironforge-job-id is not a valid custom property name."

### Diagnosis

The org's custom property schema does not include the `ironforge-job-id` property. GitHub validates `custom_properties` values against the org's defined property schemas at create-repo time; an unknown property name is rejected.

This is a **one-time pre-merge step** for PR-C.4b — the org-level property must exist before the first invocation. Subsequent provisionings reuse the same property; no per-provisioning setup.

```bash
# Confirm the property does NOT exist (gh CLI uses the User personal access
# token, not the App; org admin permissions required for this list)
gh api -X GET "/orgs/ironforge-svc/properties/schema" | jq '.[] | select(.property_name == "ironforge-job-id")'
```

Empty output → property is missing. Non-empty output → property exists and the Lambda failure is something else (likely a permissions issue on the App's "Custom properties" permission — see § "App permissions check" below).

### Recovery

#### A. Define the custom property at the org level

Manual click-through (no API path that works without org-admin OAuth scope, and the App can't define properties — only set values on existing ones):

1. Navigate to `https://github.com/organizations/ironforge-svc/settings/custom_properties`.
2. Click "New property."
3. Fill in:
   - **Name:** `ironforge-job-id`
   - **Type:** `Text`
   - **Required:** unchecked
   - **Default value:** leave empty
   - **Allowed values:** leave empty (free-text — UUIDs go in)
   - **Description:** `Set by Ironforge platform on repo creation. Identifies the provisioning job that created this repo. Do not edit manually — Ironforge uses this for idempotent retry.`
4. Click "Save property."

Verification:

```bash
gh api -X GET "/orgs/ironforge-svc/properties/schema" | jq '.[] | select(.property_name == "ironforge-job-id")'
```

Expected: a single object with `property_name: "ironforge-job-id"`, `value_type: "string"`, `required: false`.

#### B. App permissions check

The Ironforge GitHub App must have the "Custom properties" permission set to "Write" (org-level) for it to set property values on repo creation.

1. Navigate to `https://github.com/organizations/ironforge-svc/settings/installations` (or the App's settings page).
2. Find the Ironforge App, click "Configure."
3. Scroll to "Permissions" → "Organization permissions" → "Custom properties."
4. If currently "Read" or "No access," change to "Write."
5. Save changes. The org admin must approve the new permission scope (GitHub prompts on save).

If you change permissions, the App's existing installation may need to be re-acknowledged in the org admin UI before changes take effect.

### Prevention

- **This is a one-time per-org setup.** Once the property is defined, all subsequent create-repo invocations work without further bootstrap.
- **If a future template needs additional org-level metadata** (`ironforge-template-id`, `ironforge-owner-id`, `ironforge-managed`, etc.), follow the same procedure — add to the schema before the first invocation that sets the property.
- **Do not delete the property post-bootstrap.** Existing repos retain their `ironforge-job-id` values; deleting the property schema would unbind those values (GitHub keeps the data but stops surfacing it in API responses), breaking idempotency for any retry of an in-flight provisioning workflow.
- **Schedule a quarterly check** that the property still exists. Org-admin actions can drop it; the App can't recreate it.

---

## 9. GitHub App re-installation recovery

### Symptom

After an operational change to the GitHub App (transferred ownership, uninstalled-and-reinstalled, install scope change), workflow Lambdas start failing with `IronforgeGitHubAuthError` status 404 on the installation-token exchange. CloudWatch logs show the request hitting `POST /app/installations/<old-id>/access_tokens`.

### Diagnosis

Re-installation creates a new Installation ID. The old Installation ID stored in SSM points at an installation that no longer exists; GitHub returns 404. The App ID is stable across re-install; only the Installation ID changes.

```bash
# Find the current Installation ID from GitHub
gh api /orgs/ironforge-svc/installations --jq '.installations[].id'

# Compare against what's stored in SSM
aws ssm get-parameter --name /ironforge/github-app/installation-id --query Parameter.Value --output text

# Compare against what's deployed to Lambda env vars
aws lambda get-function-configuration --function-name ironforge-dev-create-repo \
  --query 'Environment.Variables.GITHUB_APP_INSTALLATION_ID' --output text
```

If the three values disagree, recovery is required.

### Recovery

#### Step 1 — Update SSM with the new Installation ID

```bash
aws ssm put-parameter \
  --name /ironforge/github-app/installation-id \
  --type String \
  --value <NEW_INSTALLATION_ID> \
  --overwrite
```

**Verification step (mandatory).** Always round-trip the value back to confirm the put took effect. SSM is strongly consistent for reads, but the verification protects against typos in the operator's `--value` argument and against partial-rollback scenarios where the put silently regressed:

```bash
aws ssm get-parameter --name /ironforge/github-app/installation-id --query Parameter.Value --output text
```

Expected: prints `<NEW_INSTALLATION_ID>` exactly. **If the output differs from what you intended to put, the next steps will silently use the wrong value** — the discovery cost in Case 4 of PR-C.4b's verification was non-trivial.

This verification idiom — `put-parameter` always followed by `get-parameter` round-trip — should apply to every operator-driven SSM update. The cost is one extra command; the benefit is "did my put actually work?" with zero ambiguity.

#### Step 2 — Update the Lambda env vars

Two real paths:

**Path A — terraform-driven (canonical).** Trigger a `terraform plan` against dev composition; the data source reads the new SSM value and computes the Lambda env var. CI's `infra-apply-dev` updates the function configuration. No drift; reproducible.

**Path B — direct AWS API (recovery).** When CI is slow or you need the fix immediately, update the Lambda env var directly:

```bash
aws lambda update-function-configuration \
  --function-name ironforge-dev-create-repo \
  --environment "Variables={...,GITHUB_APP_INSTALLATION_ID=<NEW_INSTALLATION_ID>,...}"
```

The full Variables map must be supplied (the API is replace-not-merge). Path B is drift-free as long as SSM has been updated first — terraform's next plan reads SSM (now matching) and computes the same env var the Lambda already has, so no diff.

Repeat for every Lambda that consumes the GitHub App installation token (currently: create-repo, generate-code; future: trigger-deploy).

#### Step 3 — Verify end-to-end

Invoke a workflow Lambda with a test payload and confirm the GitHub call succeeds:

```bash
aws lambda invoke --function-name ironforge-dev-create-repo --payload '{"...":"..."}' /tmp/out.json
cat /tmp/out.json
```

If still failing with 404 on installations, the SSM update didn't propagate to the Lambda env var. Re-check Step 2.

### Prevention

- **Always run the Step 1 verification round-trip.** A silent `put-parameter` failure (typo, wrong AWS profile, IAM denial that returned 200 misleadingly) is the most common cause of re-installation recovery taking longer than it should.
- **Document the new Installation ID alongside the operational change** that caused the re-install (e.g., in the PR description or runbook entry). Don't rely on `aws ssm get-parameter` as the canonical record.
- **Don't transfer App ownership or change install scope mid-provisioning-workflow.** Workflows in flight will fail mid-execution with auth errors. Wait for active workflows to drain.

---

## See also

- `infra/BOOTSTRAP.md` — initial creation of state bucket, CMK, lock table.
- `infra/OIDC_BOOTSTRAP.md` — CI roles, trust policies, identity policies.
- `docs/EMERGENCY.md` — cost-incident playbooks.
- `docs/cost-safeguards.md` — budget actions, deny policies, circuit-breaker design.
- `docs/tech-debt.md` § "`docs/runbook.md` polish beyond Phase 0 skeleton" — what this skeleton intentionally defers.
