# Emergency Procedures

Last-resort playbooks for cost incidents and account-level emergencies. Sections are intentionally light right now — fill in as we encounter (or simulate) each scenario.

## 1. Triage: investigating a high-spend alert

You received a budget breach or anomaly notification. What do you do first?

**TODO:**
- [ ] Cost Explorer queries to run (group by service, by usage type, by tag)
- [ ] CloudTrail searches for recent resource creation (Console → CloudTrail → Event history → filter on `EventName` = create*)
- [ ] How to identify which provisioning job / service is responsible (correlate `ironforge-service-id` tag against active services)
- [ ] When to escalate to AWS Support vs handle locally
- [ ] Decision tree: investigate further vs reverse the action vs nuke

## 2. Recovery: reversing a triggered deny policy

The $50 budget action triggered. The deny policy is attached. How do you safely lift it?

**Verified recovery paths** (per cost-safeguards verification runs in `cost-safeguards.md` § "Verification log"):

- **Canonical**: `aws budgets execute-budget-action --execution-type REVERSE_BUDGET_ACTION` (full procedure in `cost-safeguards.md` § 4).
- **Manual fallback**: `aws iam detach-role-policy` against each target principal. Verified working in the [2026-05-04 verification run](cost-safeguards-verification-runs/2026-05-04.md) (Phase 3) — both `ironforge-ci-apply` and `ironforge-dev-run-terraform-execution` confirmed `allowed → explicitDeny → allowed` lifecycle. Use only if `REVERSE_BUDGET_ACTION` is unavailable.

**TODO:**
- [ ] Confirm root cause is addressed before reversing
- [ ] Step-by-step reset (CLI + Console) — partial procedure already in `cost-safeguards.md` § 4; cross-link here once expanded
- [ ] Verifying the deny policy is detached across all target principals
- [ ] What to monitor for 24h after reversal (CloudWatch billing alarm? Daily report?)
- [ ] When to leave the policy attached longer than minimum

If reversing the deny policy also revealed Terraform-state inaccessibility (e.g., the deny policy denied `kms:Decrypt` against the state CMK and now plan/apply fail), continue to `docs/runbook.md` § "State-bucket recovery" and § "CMK pending-deletion recovery" for the state-side recovery path.

## 3. Forensics: identifying unknown resources

You see resources in your account that you didn't knowingly create. Or you see costs you can't attribute.

**TODO:**
- [ ] AWS Config queries (advanced query language) for "resources without `ironforge-managed=true`"
- [ ] CloudTrail event lookups by user/role over the suspect period
- [ ] Tag-based ownership reconciliation (every Ironforge resource should have `ironforge-component`, `ironforge-environment`)
- [ ] Detecting orphaned Ironforge-provisioned services (DynamoDB has the catalog; AWS has the resources; reconcile)
- [ ] What "unknown resource" means in a single-account portfolio (vs multi-account)

## 4. Last resort: full account nuke

Worst case: account compromise, bill spiking past tolerable, no time to triage carefully.

**TODO:**
- [ ] Inventory of resources to terminate, in priority order:
  - [ ] EC2 instances (shouldn't exist)
  - [ ] RDS / Redshift / ElastiCache (shouldn't exist)
  - [ ] CloudFront distributions (Ironforge's portal + provisioned user services)
  - [ ] Lambdas (Ironforge's + provisioned user CI/CD if any)
  - [ ] DynamoDB tables (the Ironforge catalog — backup first)
- [ ] Tools: aws-nuke, manual via AWS CLI, or AWS Console
- [ ] Order of operations: rotate IAM credentials and disable access keys *first*, then terminate resources
- [ ] Recovery: rebuilding from Terraform state (assuming state file survives) vs greenfield rebuild
- [ ] When to call AWS Support and what to ask for
- [ ] Worst case: account closure procedure
