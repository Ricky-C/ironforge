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

### 3. Test the budget action manually

Run this once, after at least one role is added to `var.budget_action_target_roles` and applied.

**Setup:**

1. Confirm the action exists in the plan output (`aws_budgets_budget_action.deny_at_50[0]`).
2. Identify a target role in `var.budget_action_target_roles` that you can safely "deny-test" — ideally a CI deploy role you can temporarily un-target if things go sideways.

**Test:**

1. Console → **AWS Billing and Cost Management** → **Budgets** → click `ironforge-monthly-action-50` → **Actions** tab → **Run action now**.
2. Within ~30 seconds the deny policy attaches to the target role(s).
3. Verify: `aws iam list-attached-role-policies --role-name <target-role>` should list `IronforgeBudgetActionDeny`.
4. Try a denied action with the role's credentials, e.g.:
   ```bash
   aws ec2 run-instances --image-id ami-0abcdef0 --instance-type t3.micro
   ```
   Expected: `An error occurred (UnauthorizedOperation)`.
5. Try an allowed action: `aws s3 ls`. Expected: succeeds.

**Reset (after test):**

1. Console → Budgets → `ironforge-monthly-action-50` → **Actions** → **Reset action**.
2. Or via CLI:
   ```bash
   aws budgets execute-budget-action \
     --account-id <your-account-id> \
     --budget-name ironforge-monthly-action-50 \
     --action-id <action-id-from-console> \
     --execution-type RESET
   ```
3. Verify: `aws iam list-attached-role-policies --role-name <target-role>` no longer shows the deny policy.

### 4. Manual reversal procedure (real breach)

> **AWS Budgets actions do not auto-reverse.** When the action triggers and attaches the deny policy, the policy stays attached until you explicitly reset it — even if spend falls back below threshold.

When you receive the $50 breach notification:

1. **Triage first.** See `EMERGENCY.md` for the investigation playbook. Don't reverse until you understand why it triggered.
2. **Address the root cause.** Either: stop the runaway resource, raise the budget intentionally, or accept the spend with eyes open.
3. **Reverse the action** using the same procedure as the test reset:
   ```bash
   aws budgets execute-budget-action \
     --account-id <your-account-id> \
     --budget-name ironforge-monthly-action-50 \
     --action-id <action-id> \
     --execution-type RESET
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
