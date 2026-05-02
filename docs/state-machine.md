# Provisioning state machine

Standard Step Functions workflow that orchestrates the static-site
provisioning pipeline. One state per task Lambda; eight tasks total.
This document is the load-bearing reference for retry semantics,
error-class taxonomy, ResultPath threading, and which inter-Lambda
data lives where.

The definition itself lives at
[`infra/modules/step-functions/definition.json.tpl`](../infra/modules/step-functions/definition.json.tpl).
The terraform module lives alongside it. Wiring (which task Lambdas
the state machine invokes) happens in `infra/envs/<env>/main.tf` —
the module is per-env because Lambda ARNs are per-env.

## States

```
ValidateInputs       → CreateRepo
                       → GenerateCode
                         → RunTerraform
                           → WaitForCloudFront
                             → TriggerDeploy
                               → Finalize        (terminal SUCCESS)

(any state's Catch)  → CleanupOnFailure        (terminal FAIL)
```

Each task state writes its corresponding `JobStep` row through the
PR-C.0 § "Per-step JobStep write pattern" contract: upsert running on
entry, transition to succeeded with `output` on success, transition
to failed with sanitized `errorName`/`errorMessage`/`retryable` on
error before throwing.

## Error-class taxonomy

Step Functions matches errors by name. The state machine retry +
catch logic depends on which class an error falls into. Three
canonical classes:

### Retryable AWS infrastructure errors

Every task state's `Retry` block matches:

```json
[
  "Lambda.ServiceException",
  "Lambda.AWSLambdaException",
  "Lambda.SdkClientException",
  "Lambda.TooManyRequestsException",
  "States.Timeout"
]
```

These cover Lambda invocation infrastructure (control plane errors,
service blips, throttling) and SFN's own task-level timeout. Per-task
`MaxAttempts` is calibrated to the cost of a re-run (see § "Per-task
retry counts" below). `IntervalSeconds: 2`, `BackoffRate: 2.0` —
exponential doubling — for every state.

### Custom application errors (terminal)

Lambda code throws errors with custom names — `IronforgeValidationError`,
`ProvisioningError`, etc. — for known business-logic failures that
should NOT be retried. SFN's Retry block above explicitly does NOT
include these names; they fall through to the state's `Catch` block,
which routes execution to `CleanupOnFailure`.

**Why not `States.TaskFailed` in Retry?** `States.TaskFailed` is the
SFN umbrella that matches *any* task failure, including custom-named
errors. Including it would silently retry on
`IronforgeValidationError` (and similar), which contradicts the
intent: a validation failure is the user's fault, not a transient
condition. Listing only the AWS infrastructure error names keeps
custom-error → cleanup behavior deterministic.

### CleanupOnFailure self-protection

`CleanupOnFailure` itself can fail (DynamoDB throttle, transient
Lambda issue). Its own `Retry` block matches the same AWS
infrastructure errors with `MaxAttempts: 3` — more than the per-step
counts because cleanup is the safety net and a failed cleanup leaves
inconsistent state. If cleanup retries are exhausted, the workflow
ends in the `TerminalFail` state, which is a `Fail` state surfacing
"workflow ended via cleanup-on-failure path" — operators investigate
via JobStep entries + `$.error` ResultPath + CloudWatch log group.

## Per-task retry counts

| State              | MaxAttempts | Rationale                                                                                                                        |
| ------------------ | ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| ValidateInputs     | 2           | Cheap, idempotent. Transient Lambda errors retry; user-input errors fall to Catch.                                                |
| CreateRepo         | 2           | GitHub API transients. Idempotent on repo name (existing repo → check ownership, treat as success).                               |
| GenerateCode       | 1           | One retry — re-rendering a template is cheap but state-changing (rewrites the repo's contents).                                   |
| RunTerraform       | 0           | No retry. `terraform apply` failures are not transient; rerunning compounds partial state. Cleanup-on-failure runs `destroy`.     |
| WaitForCloudFront  | 1           | Polling Lambda; SFN-level retry is for Lambda invocation failures, not for CloudFront-status polling (that's the Lambda's loop).  |
| TriggerDeploy      | 2           | GitHub API transients. Idempotent: workflow_dispatch with the same ref + payload is harmless to repeat.                           |
| Finalize           | 1           | DynamoDB transition writes. Should rarely retry — the writes are the only side effect.                                            |
| CleanupOnFailure   | 3           | Safety net. Higher than any per-step count.                                                                                       |

`run-terraform` having `MaxAttempts: 0` is a deliberate choice. The
Catch block still routes to CleanupOnFailure — the difference is no
*retry* before that. CleanupOnFailure is responsible for whatever
destroy semantics PR-C.2's tech-debt entry calls out (currently
status-writes-only; destroy chain deferred).

## ResultPath threading

State machine input at `StartExecution` is the
`WorkflowExecutionInputSchema` (defined in
[`packages/shared-types/src/workflow.ts`](../packages/shared-types/src/workflow.ts)):

```ts
{
  serviceId: string,
  jobId: string,
  executionName: string,    // = jobId, idempotency boundary
  serviceName: string,
  ownerId: string,
  templateId: string,
  inputs: Record<string, unknown>
}
```

Each task state has `"ResultPath": "$.steps.<step-name>"`, so the
state machine's running input layers up like:

```json
{
  "serviceId": "...",
  "jobId": "...",
  "...other invariants": "...",
  "steps": {
    "validate-inputs": { /* validate-inputs Lambda's return value */ },
    "create-repo":     { /* create-repo's return value */ },
    "...": "..."
  }
}
```

Downstream Lambdas read upstream outputs from `$.steps.<earlier-step>`.
The PR-C.0 data taxonomy holds: `serviceId` / `jobId` / `executionName`
flow through the input invariants; per-step inter-Lambda data
(intermediate ARNs, repo URLs) flows through `$.steps.*` ResultPath;
all persistent state lives in DynamoDB (not in `$`).

### `run-terraform` outputs consumed downstream

The terraform apply produces several outputs (see
[`templates/static-site/terraform/outputs.tf`](../templates/static-site/terraform/outputs.tf))
that downstream Lambdas read from `$.steps.run-terraform`:

| Output key              | Consumed by                | Purpose                                                              |
| ----------------------- | -------------------------- | -------------------------------------------------------------------- |
| `bucket_name`           | TriggerDeploy              | Substitutes into the `aws s3 sync s3://...` step in the user's repo. |
| `distribution_id`       | WaitForCloudFront, TriggerDeploy | Status polling target; substituted into the deploy.yml's invalidation. |
| `distribution_domain_name` | WaitForCloudFront      | Pre-flight DNS resolution check before declaring propagation.        |
| `deploy_role_arn`       | TriggerDeploy (via GenerateCode substitution) | The role-to-assume in the user's deploy.yml.       |
| `live_url`              | Finalize                   | Written to `Service.liveUrl` on the terminal-success transition.     |
| `fqdn`                  | WaitForCloudFront          | The alias FQDN to verify is resolvable.                              |

**Adding a new output that downstream Lambdas need: update both
`outputs.tf` AND this table.** The outputs declared in the manifest's
`outputsSchema` field are the ground-truth contract.

## Cleanup-on-failure scope (PR-C.2 — minimal)

PR-C.2 ships path (a) of the design conversation: cleanup-on-failure
performs **status writes only**. Specifically:

1. `transitionStatus` on Service: `provisioning → failed`, set
   `currentJobId = null`, `failureReason`, `failedAt`. Conditional
   protected on `currentJobId = :jobId`.
2. `transitionStatus` on Job: `running → failed`, set `failedAt`,
   `failureReason`, `failedStep` (read from `$.error` ResultPath).
   Conditional on `status = :running`.
3. Upsert JobStep `STEP#cleanup-on-failure` running → succeeded.

Cleanup does **NOT** delete created AWS resources, GitHub repos,
CloudFront distributions, or run `terraform destroy`. Orphaned
resources are discoverable via the `ironforge-managed = true` tag
and cleaned up manually in Phase 1.

A future destroy chain is tracked in `docs/tech-debt.md` §
"Cleanup-on-failure destroy chain". Triggers (any one):

- > 10 orphaned resources accumulated
- Single failure leaves orphans taking >5 min to clean manually
- Multi-tenant requirement lands
- Phase 2 begins

## Idempotency layering

Two distinct layers of idempotency interact in the workflow — see
`feedback_idempotency_patterns.md` and
[`docs/data-model.md`](data-model.md) § "Idempotency layering".

- **HTTP layer** — `withIdempotencyKey()` middleware on
  `POST /api/services`. Replays the original 201 response on retry.
  Caches the `{ service, job }` body keyed on
  `sha256(idempotencyKey + bodyHash + ownerId)` for 24 h.
- **Workflow layer** — `executionName = jobId` makes
  `StartExecution` natively idempotent (SFN rejects a second start
  with the same name in the same state machine). Each task Lambda's
  natural-key JobStep upsert means SFN-driven retries don't duplicate
  rows.

Both layers compose: an HTTP-level retry that hit the cache replays
the 201 without re-calling StartExecution. An HTTP-level retry that
missed the cache and reached the handler again finds the existing
`Service` (createIfNotExists conflict, scope-checked → 200 with
existing) and the existing `Job` (createIfNotExists conflict),
re-invokes `StartExecution` with the same `executionName` (no-op),
and returns the same `{ service, job }`. End state: the resource
exists exactly once; the workflow runs exactly once; the client
sees a consistent response.

## Operational reference

- **Console deep-link pattern:** open the executions list filtered by
  date range; the `executionName` equals the `jobId` so a Job row's
  `executionArn` field links directly.
- **Failed-execution triage:** read `$.error` for the originating
  failure, then read JobStep rows for `PK = JOB#<id>` to see which
  step transitioned to `failed`. The `failedStep` field on the Job
  itself denormalizes that for O(1) operator queries.
- **Manual stop:** SFN `StopExecution` from the console; cleanup-on-
  failure does NOT run (Stop bypasses Catch). Operator is responsible
  for reconciling Service/Job state in that case.
