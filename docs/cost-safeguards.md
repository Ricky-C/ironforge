# Cost Safeguards

Multi-layered protection against runaway AWS spend on the Ironforge account. Each layer catches a different failure mode; defense in depth is the goal.

## Layers at a glance

1. **AWS Budgets — $30 alert.** Email when actual spend hits 50%/80%/100% of $30, or when forecasted spend hits 100%. No action — pure heads-up.
2. **AWS Budgets — $50 deny action.** When actual spend hits $50, the budget action attaches a deny IAM policy to designated principals, blocking new resource creation.
3. **AWS Cost Anomaly Detection.** Detects unusual spend patterns and alerts via SNS → email. Two subscriptions: $3 absolute deviation, 40% relative deviation.
4. **Daily cost report.** TypeScript Lambda fires daily at 14:00 UTC, queries Cost Explorer for yesterday's spend by service, publishes to SNS → email. (Commit 5.)
5. **Service-quota lockdowns.** Manual support cases reduce default EC2 quotas to near-zero. Defense in depth — even if a deny policy is somehow bypassed, AWS quotas refuse to launch instances.

## Terraform-managed vs manual

**Terraform** (`infra/modules/cost-safeguards/`):

- Both budgets and their notifications
- Deny IAM managed policy
- Cost Anomaly Detection monitor + subscriptions
- SNS topic + email subscription + topic policy for `costalerts.amazonaws.com`
- IAM execution role for the budget action
- Daily cost reporter Lambda *(added in Commit 5)*

**Manual:**

- Confirming the SNS email subscription (you click a link)
- Lowering EC2 service quotas (support case)
- Testing the budget action (one-time exercise after the role list is populated)
- Reversing a triggered budget action (after an actual breach)

## Manual setup checklist

### 1. Confirm the SNS email subscription

After `terraform apply`, AWS sends a confirmation email to your `alert_email` address. Click the **Confirm subscription** link. Without this, no anomaly notifications or daily reports will arrive.

Verify with:

```bash
aws sns list-subscriptions-by-topic \
  --topic-arn arn:aws:sns:us-east-1:<account>:ironforge-cost-alerts \
  --query 'Subscriptions[].SubscriptionArn'
```

A confirmed subscription has a real ARN. An unconfirmed one shows `PendingConfirmation`.

### 2. Lower EC2 service quotas (support case)

Defense in depth. Ironforge is purely serverless and never launches EC2 instances. Lowering the quotas means even if a deny policy fails, AWS infrastructure refuses to create EC2.

For each quota below, open Console → **Service Quotas** → **AWS services** → **Amazon Elastic Compute Cloud (Amazon EC2)** → click the quota → **Request quota decrease** → fill in the target value and a justification ("internal-developer-platform project, all infrastructure is serverless, EC2 not used").

| Quota name | Quota code | Default | Target |
|---|---|---|---|
| Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances | `L-1216C47A` | 5 vCPUs (new accounts) | **2 vCPUs** |
| Running On-Demand G and VT instances | `L-DB2E81BA` | 0–4 vCPUs | **0 vCPUs** |
| Running On-Demand P instances | `L-417A185B` | 0 vCPUs | **0 vCPUs** |
| Running On-Demand X instances | `L-7212CCBC` | 0 vCPUs | **0 vCPUs** |

If a default is already 0, skip.

> **Note.** The Service Quotas API only supports requesting *increases*. Decreases must go through support cases — there is no Terraform path. AWS typically responds within 1–2 business days. After approval, the lower quota is in effect.

### 3. Verify the budget action plumbing

Run this once after the cost-safeguards module is applied with at least one principal in `var.budget_action_target_roles` / `_users` / `_groups`. Re-run quarterly as a recurring verification cadence.

**What this procedure tests, and what it doesn't.**

This procedure tests *our* surface: that the executor role's IAM policy permits attaching `IronforgeBudgetActionDeny` and only that policy (the `iam:PolicyARN` `ArnEquals` condition pin), and that the deny policy actually denies what it claims to deny once attached. It does NOT exercise AWS Budgets' threshold-firing path — "AWS detects spend ≥ $50, looks up the action, assumes the executor role, calls `iam:Attach*Policy`" is AWS-internal and not under our test surface. There is also no API to force-fire an `AUTOMATIC` budget action; the Console's "Run action now" button only appears for `MANUAL` actions in `Pending` state, and ours is `AUTOMATIC`.

The procedure therefore replays *the call the executor role would make at runtime* (`iam:AttachUserPolicy` against a target principal) using the operator's credentials, after the simulator has already confirmed the executor role's policy permits exactly that call.

**Prerequisites.** AWS CLI configured with operator credentials that have `iam:CreateUser`, `iam:DeleteUser`, `iam:AttachUserPolicy`, `iam:DetachUserPolicy`, `iam:GetUser`, `iam:ListAttachedUserPolicies`, `iam:SimulateCustomPolicy`, `iam:SimulatePrincipalPolicy`. The cost-safeguards module already applied with `local.budget_action_enabled = true` (at least one target principal populated).

**Step 1 — Static config inspection.** Confirm the action and executor-role plumbing are in place.

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
DENY_POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/IronforgeBudgetActionDeny"
EXECUTOR_ROLE="ironforge-budget-action-executor"

# 1a. The deny policy exists with the expected ARN.
aws iam get-policy --policy-arn "$DENY_POLICY_ARN" --query 'Policy.PolicyName'
```

> Expect: `"IronforgeBudgetActionDeny"`. Anything else (NoSuchEntity, different name) means terraform apply did not run successfully against the cost-safeguards module.

```bash
# 1b. The executor role exists and has the inline attach/detach policy.
aws iam list-role-policies --role-name "$EXECUTOR_ROLE" \
  --query 'PolicyNames'
```

> Expect: `["ironforge-budget-action-executor-inline"]`. If empty, the inline policy from PR #30 didn't apply — re-check `local.budget_action_enabled`.

```bash
# 1c. The budget action references the deny policy by ARN.
aws budgets describe-budget-actions-for-budget \
  --account-id "$ACCOUNT_ID" \
  --budget-name ironforge-monthly-action-50 \
  --query 'Actions[0].Definition.IamActionDefinition.PolicyArn'
```

> Expect: the value of `$DENY_POLICY_ARN`. If the action is missing, `local.budget_action_enabled` is false (no target principals populated).

**Step 2 — Simulate the executor role's IAM policy.** Two cases. The success case proves the executor role can attach the deny policy; the negative case proves the `iam:PolicyARN` `ArnEquals` condition is enforcing scope (the executor cannot attach any other policy).

```bash
# 2a. Success case — attach IronforgeBudgetActionDeny → expect ALLOWED.
aws iam simulate-principal-policy \
  --policy-source-arn "arn:aws:iam::${ACCOUNT_ID}:role/${EXECUTOR_ROLE}" \
  --action-names iam:AttachUserPolicy \
  --resource-arns "arn:aws:iam::${ACCOUNT_ID}:user/any-target-user" \
  --context-entries \
    "ContextKeyName=iam:PolicyARN,ContextKeyValues=${DENY_POLICY_ARN},ContextKeyType=string" \
  --query 'EvaluationResults[0].EvalDecision'
```

> Expect: `"allowed"`. This confirms PR #30's inline `aws_iam_role_policy.budget_action_executor` permits the exact runtime call AWS Budgets would make.

```bash
# 2b. Negative case — try to attach AdministratorAccess instead → expect DENIED.
aws iam simulate-principal-policy \
  --policy-source-arn "arn:aws:iam::${ACCOUNT_ID}:role/${EXECUTOR_ROLE}" \
  --action-names iam:AttachUserPolicy \
  --resource-arns "arn:aws:iam::${ACCOUNT_ID}:user/any-target-user" \
  --context-entries \
    "ContextKeyName=iam:PolicyARN,ContextKeyValues=arn:aws:iam::aws:policy/AdministratorAccess,ContextKeyType=string" \
  --query 'EvaluationResults[0].EvalDecision'
```

> Expect: `"implicitDeny"`. If `"allowed"`, the `iam:PolicyARN` `ArnEquals` condition is not in place — re-check `data.aws_iam_policy_document.budget_action_executor` in `infra/modules/cost-safeguards/budgets.tf`. This is the load-bearing scope check; if it fails, stop the procedure and triage before continuing.

**Step 3 — Manually attach the deny policy to a throwaway test user.** The user is created bare — no console password, no MFA device, no access keys, no other policy attachments. It exists solely as a target for the policy attach/detach pair.

```bash
TEST_USER="ironforge-budget-test-user"

# 3a. Create the bare test user.
aws iam create-user --user-name "$TEST_USER" \
  --tags Key=ironforge-managed,Value=true \
         Key=ironforge-component,Value=cost-safeguards-verification \
         Key=ironforge-purpose,Value=throwaway
```

> Expect: JSON output with `User.UserName` = `ironforge-budget-test-user` and a `CreateDate`. Note: do not run `iam:CreateLoginProfile`, `iam:CreateAccessKey`, or `iam:EnableMFADevice` against this user — bareness is the safety property.

```bash
# 3b. Attach the deny policy. This is the same call the executor role makes at runtime.
aws iam attach-user-policy \
  --user-name "$TEST_USER" \
  --policy-arn "$DENY_POLICY_ARN"

# 3c. Confirm the attachment.
aws iam list-attached-user-policies \
  --user-name "$TEST_USER" \
  --query 'AttachedPolicies[].PolicyName'
```

> Expect: `["IronforgeBudgetActionDeny"]`.

**Step 4 — Simulate that the deny policy denies what it claims to.** Use `simulate-principal-policy` against the test user, supplying a hypothetical `Allow *` identity policy via `--policy-input-list` so the deny is unambiguously the source of denial (and not the test user being bare). The deny policy attached in Step 3 evaluates as part of the principal's effective permissions; the simulator confirms an explicit deny wins over the supplied allow.

```bash
ALLOW_ALL='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"*","Resource":"*"}]}'

# 4a. Statement-1 action (expensive service) — expect explicitDeny.
aws iam simulate-principal-policy \
  --policy-source-arn "arn:aws:iam::${ACCOUNT_ID}:user/${TEST_USER}" \
  --policy-input-list "$ALLOW_ALL" \
  --action-names ec2:RunInstances \
  --query 'EvaluationResults[0].EvalDecision'
```

> Expect: `"explicitDeny"`. Confirms Statement 1 of `IronforgeBudgetActionDeny` is in force.

```bash
# 4b. Statement-2 action (Ironforge-style infrastructure) — expect explicitDeny.
aws iam simulate-principal-policy \
  --policy-source-arn "arn:aws:iam::${ACCOUNT_ID}:user/${TEST_USER}" \
  --policy-input-list "$ALLOW_ALL" \
  --action-names s3:CreateBucket \
  --query 'EvaluationResults[0].EvalDecision'
```

> Expect: `"explicitDeny"`. Confirms Statement 2.

```bash
# 4c. Statement-3 action (IAM privilege escalation) — expect explicitDeny.
aws iam simulate-principal-policy \
  --policy-source-arn "arn:aws:iam::${ACCOUNT_ID}:user/${TEST_USER}" \
  --policy-input-list "$ALLOW_ALL" \
  --action-names iam:CreateRole \
  --resource-arns "arn:aws:iam::${ACCOUNT_ID}:role/anywhere" \
  --query 'EvaluationResults[0].EvalDecision'
```

> Expect: `"explicitDeny"`. Confirms Statement 3.

```bash
# 4d. Action NOT in the deny policy — expect allowed (proves the deny is targeted, not blanket).
aws iam simulate-principal-policy \
  --policy-source-arn "arn:aws:iam::${ACCOUNT_ID}:user/${TEST_USER}" \
  --policy-input-list "$ALLOW_ALL" \
  --action-names s3:GetObject \
  --resource-arns "arn:aws:s3:::any-bucket/any-key" \
  --query 'EvaluationResults[0].EvalDecision'
```

> Expect: `"allowed"`. Confirms the deny policy is a circuit breaker (blocks new resource creation), not a blanket lockout — existing infrastructure keeps serving.

**Step 5 — Detach, delete, and verify cleanup.** The procedure must leave no residue.

```bash
# 5a. Detach the deny policy.
aws iam detach-user-policy \
  --user-name "$TEST_USER" \
  --policy-arn "$DENY_POLICY_ARN"

# 5b. Confirm detachment.
aws iam list-attached-user-policies \
  --user-name "$TEST_USER" \
  --query 'AttachedPolicies[].PolicyName'
```

> Expect: `[]`.

```bash
# 5c. Delete the test user.
aws iam delete-user --user-name "$TEST_USER"

# 5d. Confirm deletion.
aws iam get-user --user-name "$TEST_USER" 2>&1 | grep -q NoSuchEntity \
  && echo "OK — test user deleted" \
  || echo "ERROR — test user still exists, see Cleanup on failure"
```

> Expect: `OK — test user deleted`. If the grep doesn't match, the user wasn't deleted; jump to "Cleanup on failure" below.

**What was tested.**

- The executor role's inline policy permits the exact `iam:AttachUserPolicy` call AWS Budgets would make at runtime (Step 2a).
- The executor role's inline policy denies attaching any other policy (Step 2b proves the `iam:PolicyARN` `ArnEquals` is enforcing).
- The deny policy, when attached, explicit-denies all three statement categories (Steps 4a/4b/4c).
- The deny policy is targeted — non-listed actions still pass (Step 4d).
- The procedure leaves no residue (Step 5d).

**What was not tested.** AWS Budgets' threshold-detection and role-assumption path is AWS-internal. The only ways to exercise it are (a) an actual budget breach or (b) a force-fire API for `AUTOMATIC` actions, which AWS does not provide. Accepted as outside our test surface.

**Cleanup on failure.** If the procedure fails at any step, run this block to return to a clean state. Idempotent — safe to re-run.

```bash
TEST_USER="ironforge-budget-test-user"
DENY_POLICY_ARN="arn:aws:iam::$(aws sts get-caller-identity --query Account --output text):policy/IronforgeBudgetActionDeny"

# Detach all attached managed policies (defensive: in case other policies got attached during a botched test).
for POLICY_ARN in $(aws iam list-attached-user-policies --user-name "$TEST_USER" \
                      --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
  aws iam detach-user-policy --user-name "$TEST_USER" --policy-arn "$POLICY_ARN"
done

# Remove any inline policies (shouldn't exist on a bare user but check anyway).
for POLICY_NAME in $(aws iam list-user-policies --user-name "$TEST_USER" \
                       --query 'PolicyNames' --output text 2>/dev/null); do
  aws iam delete-user-policy --user-name "$TEST_USER" --policy-name "$POLICY_NAME"
done

# Delete access keys, login profile, MFA devices (shouldn't exist on a bare user but check anyway —
# delete-user fails if any of these are present).
for KEY_ID in $(aws iam list-access-keys --user-name "$TEST_USER" \
                  --query 'AccessKeyMetadata[].AccessKeyId' --output text 2>/dev/null); do
  aws iam delete-access-key --user-name "$TEST_USER" --access-key-id "$KEY_ID"
done

aws iam delete-login-profile --user-name "$TEST_USER" 2>/dev/null || true

for MFA_SERIAL in $(aws iam list-mfa-devices --user-name "$TEST_USER" \
                      --query 'MFADevices[].SerialNumber' --output text 2>/dev/null); do
  aws iam deactivate-mfa-device --user-name "$TEST_USER" --serial-number "$MFA_SERIAL"
  aws iam delete-virtual-mfa-device --serial-number "$MFA_SERIAL" 2>/dev/null || true
done

# Delete the user.
aws iam delete-user --user-name "$TEST_USER" 2>/dev/null

# Verify.
aws iam get-user --user-name "$TEST_USER" 2>&1 | grep -q NoSuchEntity \
  && echo "OK — clean state restored" \
  || { echo "ERROR — user still exists after cleanup; investigate manually"; exit 1; }
```

If the cleanup block also fails, the residual state is a single test user (`ironforge-budget-test-user`) potentially with policies attached. It has no console access, no MFA, no access keys (per Step 3a's bareness invariant), so it cannot authenticate to AWS — the residual risk is bounded to "this user shows up in `iam:ListUsers` until manually cleaned up." Investigate via `aws iam get-user` + `aws iam list-attached-user-policies` and clean up each blocker explicitly.

**Capture artifacts.** Append a one-line entry to the verification log below with date, AWS account ID, and the EvalDecision string from each simulator step. Establishes the quarterly cadence per `docs/tech-debt.md` § "End-to-end verification of the cost-safeguards circuit breaker".

#### Verification log

| Date | Account ID | Step 2a | Step 2b | Step 4a | Step 4b | Step 4c | Step 4d | Notes |
|---|---|---|---|---|---|---|---|---|
| _(first run pending)_ | | | | | | | | |

### 4. Manual reversal procedure (real breach)

> **AWS Budgets actions do not auto-reverse.** When the action triggers and attaches the deny policy, the policy stays attached until you explicitly reset it — even if spend falls back below threshold.

When you receive the $50 breach notification:

1. **Triage first.** See `EMERGENCY.md` for the investigation playbook. Don't reverse until you understand why it triggered.
2. **Address the root cause.** Either: stop the runaway resource, raise the budget intentionally, or accept the spend with eyes open.
3. **Reverse the action.** Use `REVERSE_BUDGET_ACTION`, not `RESET_BUDGET_ACTION`. The two are different operations — `REVERSE` undoes a previously executed action (for our `APPLY_IAM_POLICY` action, this means detaching the deny policy from every target principal). `RESET` returns the action's execution state to standby so it can fire again on the next breach but does NOT detach the policy. Recovery requires `REVERSE`.
   ```bash
   aws budgets execute-budget-action \
     --account-id <your-account-id> \
     --budget-name ironforge-monthly-action-50 \
     --action-id <action-id> \
     --execution-type REVERSE_BUDGET_ACTION
   ```
4. **Verify** the deny policy is detached from every target principal:
   ```bash
   for role in <list of target role names>; do
     echo "=== $role ==="
     aws iam list-attached-role-policies --role-name "$role" \
       --query 'AttachedPolicies[?PolicyName==`IronforgeBudgetActionDeny`]'
   done
   ```
   Empty result = clean.

## The deny policy — full rationale (verbatim from review)

The `IronforgeBudgetActionDeny` policy is attached by the $50 budget action. It's a circuit breaker: block new infrastructure creation, allow operations on existing infrastructure.

### Statement 1 — Block creation of expensive services Ironforge never uses

```
ec2:RunInstances, ec2:StartInstances
rds:CreateDBInstance, rds:CreateDBCluster
rds:RestoreDBInstanceFromSnapshot, rds:RestoreDBClusterFromSnapshot
redshift:CreateCluster, redshift:RestoreFromClusterSnapshot
elasticache:CreateCacheCluster, elasticache:CreateReplicationGroup
es:CreateDomain, opensearch:CreateDomain
sagemaker:CreateNotebookInstance, sagemaker:CreateEndpoint
sagemaker:CreateTrainingJob, sagemaker:CreateProcessingJob, sagemaker:CreateTransformJob
emr:RunJobFlow
eks:CreateCluster, eks:CreateNodegroup
ecs:CreateCluster, ecs:RunTask, ecs:CreateService
kafka:CreateClusterV2, kafka:CreateCluster
memorydb:CreateCluster
qldb:CreateLedger
documentdb:CreateDBCluster
```

**Rationale.** Ironforge is purely serverless. None of these services should ever be used. They are pure runaway-cost vectors. Denying with prejudice costs nothing.

### Statement 2 — Block creation of new Ironforge-style infrastructure

```
s3:CreateBucket
cloudfront:CreateDistribution
lambda:CreateFunction
dynamodb:CreateTable
states:CreateStateMachine
apigateway:POST                  // POST against /restapis = create API
secretsmanager:CreateSecret
kms:CreateKey
route53:CreateHostedZone
logs:CreateLogGroup
events:PutRule
```

**Rationale.** Stops Ironforge from provisioning *new* user services or expanding its own footprint while we investigate. Existing user services keep serving traffic; existing Lambdas keep invoking; the portal stays up.

### Statement 3 — Block IAM privilege escalation

```
iam:CreateUser, iam:CreateRole, iam:CreatePolicy, iam:CreatePolicyVersion
iam:AttachRolePolicy, iam:AttachUserPolicy
iam:PutRolePolicy, iam:PutUserPolicy
iam:CreateLoginProfile, iam:CreateAccessKey
```

**Rationale.** If a runaway is somehow IAM-driven, stop it from making more IAM. Note: `iam:UpdateRole` (e.g., changing a description) stays allowed for response/recovery; it's *attaching* and *creating* that escalates.

### Deliberately NOT denied — allows normal Ironforge ops to continue

- `lambda:InvokeFunction` — existing Lambdas keep running
- `dynamodb:GetItem` / `PutItem` / `UpdateItem` / `Query` / `Scan` — CRUD on existing tables works
- `s3:GetObject` / `PutObject` — existing buckets serve and accept writes
- `cloudfront:GetDistribution` — read existing CF
- `sts:AssumeRole` — role assumption stays open (CI can still run)
- `cognito-idp:*` — auth flows work
- All `*:Describe*`, `*:Get*`, `*:List*` — investigation is unimpeded
- `lambda:UpdateFunctionCode` / `lambda:UpdateFunctionConfiguration` — you can still deploy a fix

### Aggressiveness vs blast radius

Tier 2 (this policy) is the chosen middle ground:

- Aggressive enough to halt new-resource creation across both Ironforge-internal infra and user-provisioned services.
- Not so aggressive that the live portal dies. CloudFront keeps serving. Cognito keeps authing. API Gateway keeps routing to existing Lambdas, which keep CRUDing existing DynamoDB tables.

CI deploys *will* fail while the action is triggered. That's intentional — when over budget, you should not be deploying.

## Anomaly detection notes

- One `aws_ce_anomaly_monitor` watches all SERVICE-level spend.
- Two subscriptions hold the thresholds independently:
  - `ironforge-anomaly-absolute-3usd` — $3 absolute deviation
  - `ironforge-anomaly-relative-40pct` — 40% relative deviation
- Both subscriptions publish to the same SNS topic. If both trigger on the same anomaly, you get two emails — acceptable cost for keeping each threshold cleanly auditable.
- AWS Cost Anomaly Detection takes ~10 days of historical spend before it produces useful baselines. Expect noisy or absent alerts in the first ~2 weeks of operation.

## Building the cost-reporter Lambda

The Lambda's deploy artifact is `services/cost-reporter/dist/index.js`. Terraform reads it via `data.archive_file`; if it doesn't exist, `terraform plan` fails with a clear "no such file" error.

**Local:**

```bash
pnpm install
pnpm --filter @ironforge/cost-reporter build
```

Run `build` again after any change in `services/cost-reporter/src/`. esbuild produces a single bundled CJS file with inline source maps; `@aws-sdk/*` packages are externalized because they ship in the Lambda Node.js 22 runtime.

**CI (Commit 11):**

The `infra-apply.yml` workflow runs `pnpm install && pnpm --filter @ironforge/cost-reporter build` before `terraform apply` on the `shared` composition. Other Lambdas added in later commits join this build step.

**Redeploy trigger:**

Terraform sees a new `source_code_hash` whenever the bundle changes; the Lambda redeploys on the next apply. No source change → no redeploy on subsequent applies.

**SNS topic reuse:**

The cost reporter publishes to the same `ironforge-cost-alerts` SNS topic that Cost Anomaly Detection uses. Distinct subject lines keep them sortable in the inbox:

| Source | Subject |
|---|---|
| Cost reporter Lambda | `Ironforge daily cost report — YYYY-MM-DD` |
| Cost Anomaly Detection | AWS-set: `AWS Cost Anomaly Detection has detected an anomaly` (or similar) |

**Log group encryption:**

The Lambda's CloudWatch log group uses AWS-managed encryption (no CMK). Cost summaries are operational data — none of ADR-003's CMK criteria apply.
