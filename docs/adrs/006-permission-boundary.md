# ADR 006 — IronforgePermissionBoundary

**Status:** Accepted

**Date:** 2026-04-28

## Context

Ironforge Lambdas execute with role-based permissions. CLAUDE.md mandates:

- "Lambdas have purpose-specific roles. No shared 'ironforge-lambda-role.'"
- "Permission boundaries on all Ironforge IAM roles."
- "No `Resource: \"*\"` on `iam:*`, `sts:AssumeRole`, or anything granting elevation."

Per-Lambda inline policies grant the specific permissions each Lambda needs. The permission boundary CAPS what those inline policies can ever grant — even a misconfigured policy can't escape the boundary.

Without a boundary:

- A typo'd inline policy could grant `iam:*` on `Resource: "*"`. Privilege escalation.
- A future copy-pasted policy could grant `ec2:RunInstances`, bypassing cost guards.
- A buggy Lambda role could in principle do anything its inline policy says.

This ADR codifies the boundary's design.

## Decision

`IronforgePermissionBoundary` is a single managed IAM policy attached as the permissions boundary on every Ironforge Lambda execution role. It is an ALLOW-list with explicit DENY statements for high-risk actions (defense in depth).

Lives in `infra/modules/lambda-baseline/`. Applied via the `permissions_boundary_arn` variable threaded through Lambda-creating modules.

## ALLOW list

Each ALLOW statement caps the broadest permission an inline policy can grant. Per-Lambda inline policies should be tighter than these.

| Sid | Why |
|---|---|
| `AllowLogsForIronforgeLambdas` | Lambda runtime requires log writes. Scoped to `/aws/lambda/ironforge-*` log groups so a buggy inline policy can't write to other services' logs. |
| `AllowXRayWrite` | Tracing. `xray:Put*` is account-scoped per AWS service authorization reference (no resource-level support). See `docs/iam-exceptions.md`. |
| `AllowDynamoDBOnIronforgeTables` | Per-env tables `ironforge-dev` / `ironforge-prod` (ADR-005 exception). Scope covers tables and their indexes via `ironforge-*` and `ironforge-*/index/*`. |
| `AllowArtifactsBucketAccess` | Single shared artifacts bucket. **Boundary allows broadly on `ironforge-artifacts-*`; per-Lambda inline policies scope to env prefixes** (e.g., `${bucket_arn}/dev/*`). See "Why not principal-tag substitution" below. |
| `AllowRoute53OnIronforgeZone` | Provisioning workflow Lambdas (Phase 1) will create per-service CNAMEs. Scoped to `var.route53_zone_arn` only — never the parent zone, never `Resource: "*"`. |
| `AllowSNSPublishOnIronforgeTopics` | Currently the cost-alerts topic; future cross-Lambda fan-out. |
| `AllowStepFunctionsOnIronforgeStateMachines` | Phase 1 orchestration. |
| `AllowSecretsManagerOnIronforgeSecrets` | Future credentials (GitHub App private key, etc.). Scope `ironforge/*` reflects the secret-naming convention. |
| `AllowCostExplorerRead` | Daily cost reporter Lambda. `Resource: "*"` per `iam-exceptions.md`. |
| `AllowLambdaInvokeOnIronforgeFunctions` | Inter-Lambda calls without Step Functions. |

## DENY list

Belt-and-suspenders. The ALLOW list doesn't include these, so they would be denied by default. Explicit DENY makes the intent durable — no future widening of ALLOW can grant these.

| Sid | Why |
|---|---|
| `DenyIAMManagement` | Lambdas should NEVER manage IAM. Mirrors `iam:Create*` / `iam:Attach*Policy` from the cost-safeguards deny policy. |
| `DenySTSAssumeRole` | Lambdas shouldn't role-chain. Each Lambda has its own role with the perms it needs. |
| `DenyExpensiveServicesPermanently` | `ec2:*`, `rds:*`, `redshift:*`, `elasticache:*`, `es:*`, `opensearch:*`, `sagemaker:*`, `emr:*`, `eks:*`, `ecs:*`, `kafka:*`, `memorydb:*`, `qldb:*`, `documentdb:*`. The cost-safeguards deny policy applies the same set on budget breach; this boundary makes them blocked at all times. |

## Deliberate exclusions

**KMS.** Post-ADR-003 most Ironforge resources use AWS-managed encryption (handled transparently by data-plane services). No current Lambda directly calls KMS. Adding KMS perms speculatively risks the tag/alias condition pitfalls — boundary KMS conditions have inconsistent behavior across operations. `docs/tech-debt.md` § "KMS permissions absent from the IronforgePermissionBoundary" tracks the deferral and how to add them safely when the first direct-KMS-access Lambda lands.

**`route53:GetChange`.** Phase 1 workflow Lambdas (wait-for-cert step) will need this with `Resource: "*"` for ACM cert validation polling. Saved memory `project_phase1_route53_getchange.md` flags it for the Phase 1 boundary update.

**API Gateway / CloudFront / Cognito direct API calls.** Lambdas don't currently manage these resources. If a future Lambda needs (e.g.) `cognito-idp:AdminCreateUser`, add it to the boundary then.

**Cross-account access.** Single-account by design. No `sts:AssumeRole` across accounts.

## Why not principal-tag substitution for env-prefix scoping

The alternative considered: have the boundary's S3 ALLOW statement reference `${aws:PrincipalTag/ironforge-environment}` so the artifacts bucket prefix automatically scopes to the role's env. The pattern would look like:

```hcl
resources = [
  "arn:aws:s3:::ironforge-artifacts-*/$${aws:PrincipalTag/ironforge-environment}/*"
]
```

Considered and rejected for several specific reasons. Future reviewers (including future-me) should not have to re-derive this — the trade-offs below justify the conventional pattern.

### Tag context is subtler than it looks

`aws:PrincipalTag/<key>` evaluates against the principal's tags at request time. For an IAM role assumed by Lambda, this resolves to the role's IAM tags (set via Terraform `tags = {...}` on the role). But the same context key behaves differently in adjacent paths:

- If a role is assumed via `sts:AssumeRole` with explicit `--tags` (session tagging), the session tag value can override the role's IAM tag for `aws:PrincipalTag` evaluation. We deny `sts:AssumeRole` in the boundary, but the semantic surface is wider than it appears at first glance.
- If a role is created without the env tag — e.g., a future module that misses `default_tags` propagation — the substitution evaluates to empty. IAM treats this as a non-match in resource ARNs, so the action is denied. Safe failure mode, but a debugging ordeal: "why is this Lambda denied" leads to "the tag isn't on the role," which isn't obvious from the access-denied message alone.

### Reviewer cost

When you read a literal `arn:aws:s3:::ironforge-artifacts-*/dev/*` in an inline policy, you can answer "what does this allow?" in one trip. When you read `arn:aws:s3:::ironforge-artifacts-*/${aws:PrincipalTag/ironforge-environment}/*` in a boundary, you have to:

1. Establish what `aws:PrincipalTag/ironforge-environment` evaluates to in your context.
2. Look up the role's IAM tags.
3. Confirm `default_tags` is propagating correctly from the provider config.
4. Confirm no session tags are in play.
5. Then compute the effective resource pattern.

Five lookups for what should be a single-line answer. Compounded across every Lambda role, this is non-trivial reviewer cost.

### Static-analysis tooling friction

IAM Access Analyzer and third-party policy auditors handle literal resource patterns reliably. Variable substitutions evaluate symbolically rather than concretely, so static analysis is harder. We'd be opting out of cleaner audit reports for marginal benefit.

### Inverts the conventional pattern

Established AWS guidance and most production IAM policies put identity-scope logic in identity policies and use boundaries for broad caps. Inverting that — putting scope in the boundary, broad allow in the identity policy — is non-obvious to anyone reviewing IAM at scale. Engineers joining the project would have to learn a non-standard pattern before they could read our policies.

### What we lose

A buggy inline policy that grants `${bucket_arn}/*` (without an env prefix) would NOT be caught by the boundary in our chosen pattern. The boundary allows broadly on `ironforge-artifacts-*`; the inline grant would be within the boundary's cap.

This is a real risk, accepted with three mitigations:

1. **Code review.** Inline policies are short, reviewable, and the env prefix is a one-line check.
2. **Saved memory `project_commit_10_iam_prefix_scoping.md`** flags this requirement so it surfaces in every future commit adding a Lambda role.
3. **Deferred bucket-policy enforcement** (`docs/tech-debt.md` § "Prefix-scoped artifacts bucket policy"). When that lands, the bucket itself enforces prefix-scoped access at the AWS level — third layer behind boundary and inline.

The trade-off: less defense-in-depth at the boundary, more reliance on inline policy correctness. Accepted for the reviewer-cost reduction and the conventional pattern.

## Retrofit pattern

Lambda-creating modules accept a `permissions_boundary_arn` variable, defaulting to `null`. The role resource sets `permissions_boundary = var.permissions_boundary_arn`. When `null`, no boundary is applied. When non-null, the boundary applies.

The shared composition wires `module.lambda_baseline.boundary_policy_arn` through to all Lambda-creating modules:

```hcl
module "cost_safeguards" {
  source = "../../modules/cost-safeguards"
  # ...
  permissions_boundary_arn = module.lambda_baseline.boundary_policy_arn
}
```

This pattern is applied retroactively to the cost-reporter Lambda in this commit. Future Lambda-creating modules in Phase 1+ should follow it — the variable threads through cleanly without needing to refactor existing modules.

## Verification

These commands are concrete and intended for execution. Phase 0 verifies the cost-reporter retrofit. Phase 1 verifies cross-prefix isolation when the first multi-env Lambda exists.

### Phase 0 — boundary attached to cost-reporter

Run after `terraform apply` of the shared composition.

```bash
# 1. Boundary is attached to the role
aws iam get-role --role-name ironforge-cost-reporter \
  --query 'Role.PermissionsBoundary'
```

Expected:

```json
{
    "PermissionsBoundaryType": "Policy",
    "PermissionsBoundaryArn": "arn:aws:iam::<account-id>:policy/IronforgePermissionBoundary"
}
```

```bash
# 2. cost-reporter still functions after the retrofit
aws lambda invoke \
  --function-name ironforge-cost-reporter \
  --invocation-type RequestResponse \
  --log-type Tail \
  /tmp/cost-reporter-output.json \
  --query 'StatusCode' --output text
```

Expected: `200`. Verify the alert email arrives within ~30 seconds confirming SNS publish succeeded inside the boundary.

### Phase 1 — cross-prefix isolation (when the first multi-env Lambda exists)

These commands assume a dev-tagged Lambda role exists with an inline policy granting `s3:GetObject` on `arn:aws:s3:::ironforge-artifacts-<account-id>/dev/*` only.

Setup test objects (run as the operator account):

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET="ironforge-artifacts-${ACCOUNT_ID}"

echo "dev-content" | aws s3 cp - "s3://${BUCKET}/dev/verify-test"
echo "prod-content" | aws s3 cp - "s3://${BUCKET}/prod/verify-test"
```

**Success case** — same-env access succeeds:

```bash
ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/<dev-lambda-role-name>"

CREDS=$(aws sts assume-role \
  --role-arn "$ROLE_ARN" \
  --role-session-name boundary-verify-success \
  --query 'Credentials' --output json)

AWS_ACCESS_KEY_ID=$(echo "$CREDS" | jq -r .AccessKeyId) \
AWS_SECRET_ACCESS_KEY=$(echo "$CREDS" | jq -r .SecretAccessKey) \
AWS_SESSION_TOKEN=$(echo "$CREDS" | jq -r .SessionToken) \
aws s3api get-object \
  --bucket "$BUCKET" \
  --key dev/verify-test \
  /tmp/verify-out
```

Expected: command succeeds, status `200`, `/tmp/verify-out` contains `dev-content`. Access is granted by the inline policy and falls within the boundary's broad ALLOW on `ironforge-artifacts-*`.

**Denial case** — cross-env access fails:

```bash
# Same role credentials from above
AWS_ACCESS_KEY_ID=$(echo "$CREDS" | jq -r .AccessKeyId) \
AWS_SECRET_ACCESS_KEY=$(echo "$CREDS" | jq -r .SecretAccessKey) \
AWS_SESSION_TOKEN=$(echo "$CREDS" | jq -r .SessionToken) \
aws s3api get-object \
  --bucket "$BUCKET" \
  --key prod/verify-test \
  /tmp/verify-out
```

Expected:

```
An error occurred (403) when calling the GetObject operation: Forbidden
```

Note: the denial happens at the **inline policy level**, not the boundary. The inline policy scopes to `dev/*`; `prod/verify-test` does not match. The boundary itself allows broadly on `ironforge-artifacts-*` — the boundary is not the deny source. This is exactly the trade-off documented in "Why not principal-tag substitution" above; verifying it explicitly here makes the boundary's role and the inline policy's role visible.

Cleanup:

```bash
aws s3 rm "s3://${BUCKET}/dev/verify-test"
aws s3 rm "s3://${BUCKET}/prod/verify-test"
```

## Consequences

**Positive:**

- A single source of truth for "what Ironforge Lambdas can ever do."
- Privilege escalation via inline-policy mistakes is bounded.
- Reviewers can audit the boundary once and trust it across all Lambdas.

**Negative:**

- Adding a new permission requires editing the boundary, not just the Lambda.
- Mistakes in the boundary can break ALL Lambdas at once. Deploy carefully; test with one Lambda before applying widely.

**Migration:**

- Roles created before Commit 10 (cost-reporter) get the boundary retroactively via the `permissions_boundary_arn` variable threaded through. Once applied, the cost-reporter still works because its inline policy is well within the boundary's ALLOW list.

## Related

- ADR-002 — managed IAM policies. The boundary itself is a custom policy (not managed) because no AWS-provided policy fits.
- ADR-003 — encryption defaults. KMS exclusion from the boundary follows from "no Lambda directly calls KMS post-ADR-003."
- ADR-005 — DynamoDB multi-table exception. The boundary's DynamoDB allow scopes to `ironforge-*` (matching both env-named tables).
- `docs/iam-exceptions.md` — `Resource: "*"` actions used by the boundary.
- `docs/tech-debt.md` — deferred KMS perms; deferred bucket-policy prefix enforcement.
