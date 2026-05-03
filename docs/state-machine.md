# Provisioning state machine

Standard Step Functions workflow that orchestrates the static-site
provisioning pipeline. Eight task Lambdas drive seven workflow phases
(WaitForCloudFront's polling phase consists of one Lambda invoked in
a Wait → Choice → Task loop — see § "Polling-loop topology" below).
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
                           → InitCloudFrontPolling (Pass: seed pollState)
                             → WaitForCloudFront ←─┐
                               ↓ (Choice)          │
                               ├─ status="succeeded" → TriggerDeploy
                               └─ default → WaitForCloudFrontWaitTick (Wait)
                                                  └──────────────────┘
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
`IronforgeGitHubAuthError`, `IronforgeGitHubRepoConflictError`,
`IronforgeGitHubRateLimitedError`, `IronforgeGitHubProvisionError`,
`IronforgeRefConflictError`, `IronforgeGenerateError`,
`IronforgeRenderError`, `ProvisioningError`, etc. — for known business-logic failures that
should NOT be retried. SFN's Retry block above explicitly does NOT
include these names; they fall through to the state's `Catch` block,
which routes execution to `CleanupOnFailure`.

The GitHub-specific class is the largest cluster (introduced in
PR-C.4a/PR-C.4b for create-repo, extended in PR-C.8 for trigger-deploy):

- `IronforgeGitHubAuthError` — 401 / 403 from GitHub on token mint or
  API call. Auth failures are permanent (PEM wrong, installation revoked,
  permissions reduced). Retry would not help.
- `IronforgeGitHubRepoConflictError` — repo with the requested name
  exists but its `custom_properties["ironforge-job-id"]` does not match
  this provisioning's jobId. Means a prior failed provisioning left an
  orphan, or a manual operator action created the repo. Operator
  cleanup required.
- `IronforgeGitHubRateLimitedError` — 403 with `X-RateLimit-Remaining: 0`.
  Recoverable in principle (rate-limit window will reset), but the
  workflow can't sit idle for the rate-limit duration; CleanupOnFailure
  handles it and the user retries provisioning later. Past-participle
  naming matches AWS SDK convention (Throttled, RateLimited).
- `IronforgeGitHubProvisionError` — catch-all for unexpected GitHub
  responses (5xx that survived the Octokit retry plugin's bounded
  retries, schema mismatches, etc.). The `operation` discriminator
  (get-repo / create-repo / unknown) helps operators correlate with
  the specific call site.
- `IronforgeRefConflictError` (PR-C.5 generate-code) — `refs/heads/main`
  exists on the repo but the head commit's message lacks our jobId
  marker. Means a prior failed provisioning left an orphan, or a
  manual operator commit happened. Operator cleanup required.
- `IronforgeGenerateError` (PR-C.5 generate-code) — catch-all for
  pre-API failures during generate-code (render leftover, missing
  `$.steps.create-repo` from upstream, malformed prior-step output).
- `IronforgeRenderError` (PR-C.5 template-renderer package) — template
  references an `__IRONFORGE_<NAME>__` placeholder not in the
  renderer's substitution map. Surfaces template/renderer drift at
  first invocation rather than as silent half-rendered files in
  production.
- `IronforgeTerraformInitError` (PR-C.6 run-terraform) — `terraform
  init` exited non-zero. Most common cause is misconfigured backend
  flags or a provider not present in the filesystem mirror; sanitized
  message points operators to CloudWatch for the stderr tail. Init
  failures are permanent for this workflow execution; retry would not
  help (the state is the same).
- `IronforgeTerraformApplyError` (PR-C.6 run-terraform) — `terraform
  apply` exited non-zero. Common causes: AWS API rejection mid-apply
  (e.g., `BucketAlreadyExists` from a name collision in the
  `ironforge-svc-*` namespace, IAM eventual-consistency window after
  role create, ACM cert validation timing), an unhandled provider
  panic, or a permissions denial despite the boundary widening. Apply
  failures are NEVER retried by SFN: ADR-009 sets `run-terraform`'s
  `MaxAttempts: 0` because re-running apply against partial state can
  compound the failure rather than recover. Routes to
  `CleanupOnFailure`, which calls `terraform destroy` against the
  per-service state to reverse whatever apply DID create.
- `IronforgeTerraformOutputError` (PR-C.6 run-terraform) — `terraform
  output -json` either exited non-zero, returned malformed JSON, or
  produced a payload that failed `StaticSiteOutputsSchema` validation.
  Last case is template-author drift (the template's `outputs.tf`
  shape doesn't match the schema in
  `packages/shared-types/src/templates/static-site.ts`); first two
  are environmental. All three sanitized to a single class because
  the recovery is the same — operators inspect CloudWatch for the
  `zodIssues` payload (schema case) or `stderrTail` (exit-code case).
- `IronforgeWorkflowInputError` (PR-C.6 run-terraform; same name as
  upstream task Lambdas) — SFN execution input failed
  `WorkflowExecutionInputSchema` parse OR `templateId` was not in the
  registered enum. Both surface BEFORE any DDB write, so a malformed
  event can't even create a JobStep entry.
- `IronforgePollTimeoutError` (PR-C.7 wait-for-cloudfront) — the
  CloudFront distribution did not reach `Status === "Deployed"` within
  the 20-minute elapsed budget enforced by the polling Lambda. Routes
  to `CleanupOnFailure` via the existing `Catch` on `States.ALL` —
  the Lambda throws rather than returning a `failed` PollResult so
  `$.error` is populated automatically by SFN. CloudFront propagation
  exceeding 20 minutes is a real (but rare) event; recovery is
  operator-led re-provisioning.
- `IronforgeWaitForCloudFrontError` (PR-C.7 wait-for-cloudfront) — any
  thrown error from `cloudfront:GetDistribution` (auth failure,
  malformed distribution ID from upstream's outputs, transient SDK
  errors). Treated terminal — the elapsed budget is the bound on
  per-tick retries, so a single thrown error fails the workflow.

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
| CreateRepo         | 2           | GitHub API transients (5xx beyond the Octokit retry plugin's bounded retries). Idempotent via `custom_properties["ironforge-job-id"]` — re-invocation with same jobId returns the existing repo. |
| GenerateCode       | 1           | One retry — re-rendering a template is cheap but state-changing (rewrites the repo's contents).                                   |
| RunTerraform       | 0           | No retry. `terraform apply` failures are not transient; rerunning compounds partial state. Cleanup-on-failure runs `destroy`.     |
| WaitForCloudFront  | 1           | Polling Lambda invoked in an SFN Wait → Choice → Task loop (see § "Polling-loop topology"). SFN-level Retry catches Lambda-platform transients on a single tick; the polling cap is the wall-clock 20-minute elapsed budget enforced inside the Lambda, throwing `IronforgePollTimeoutError` when exhausted. |
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
| `distribution_domain_name` | (consumer dropped, PR-C.7) | Was originally intended as a pre-flight DNS resolution check input; dropped per § "Polling-loop topology" YAGNI decision. |
| `deploy_role_arn`       | TriggerDeploy (set as repo secret IRONFORGE_DEPLOY_ROLE_ARN before workflow_dispatch) | The role-to-assume in the user's deploy.yml. Per the Path A substitution boundary (PR-C.5; see docs/conventions.md § "Template substitution boundary"), runtime values flow through GitHub Actions repo secrets rather than file substitution. |
| `live_url`              | Finalize                   | Written to `Service.liveUrl` on the terminal-success transition.     |
| `fqdn`                  | (consumer dropped, PR-C.7) | Same as `distribution_domain_name`. Both outputs remain in the template's `outputs.tf` because Finalize's `liveUrl` is derived from the same data; the consumer table tracks downstream Lambda usage, not output existence. |

**Adding a new output that downstream Lambdas need: update both
`outputs.tf` AND this table.** The outputs declared in the manifest's
`outputsSchema` field are the ground-truth contract.

## Polling-loop topology (PR-C.7)

Tasks that wait on a long-running upstream condition (CloudFront
distribution propagation; future: ACM certificate validation, slow
GitHub workflow dispatch) use the SFN-orchestrated polling pattern,
not in-Lambda sleep loops. WaitForCloudFront is the canonical
implementation. The shape:

```
Init Pass state                     → seeds $.steps.<task> with { status: "init" }
  → polling Task                    → returns PollResult
    → Choice                        → succeeded → next phase
                                    → default → Wait
      → Wait (SecondsPath)          → consumes nextWaitSeconds from PollResult
        → polling Task (loop)
```

**Why this shape, not in-Lambda polling.** SFN is the workflow
primitive (CLAUDE.md anti-pattern: "Step Functions is the workflow
primitive"); Wait states are free; SFN execution time is decoupled
from Lambda's 15-minute ceiling, so tail-latency cases (CloudFront
occasionally takes 12-15 min to propagate) don't bump the wall.
In-Lambda sleep loops also make Lambda execution cost a function
of upstream latency rather than upstream complexity.

**Init Pass state convention.** Every polling loop begins with an
Init Pass state injecting `Result: { status: "init" }` at the
loop's `$.steps.<task>` ResultPath. SFN does not support default
values for missing JSON paths in `Parameters` blocks — without the
init seed, the first poll-task invocation's `Parameters.previousPoll.$:
"$.steps.<task>"` would runtime-fail because that key would not yet
exist. The Pass state is free; the alternative (Lambda accepts a
nullable `previousPoll` and self-initializes) couples the Lambda to
"first tick" awareness the type system already wants to enforce.

**Choice state shape.** Routes on `$.steps.<task>.status`:

- `"succeeded"` → exit the loop into the next phase.
- *(default)* → the Wait state.

There is no `"failed"` branch. Polling Lambdas throw
`IronforgePollTimeoutError` (or any other terminal error) rather
than returning `PollResult.failed`. The thrown error is caught by
the polling Task's existing `Catch` on `States.ALL` and routed to
`CleanupOnFailure` with `$.error` populated automatically by SFN.
This keeps the Choice minimal and avoids a Pass state to construct
`$.error` from a returned PollResult. The `failed` discriminant on
`PollResultSchema` remains for future polling Lambdas with
terminal-but-not-thrown upstream states (e.g. ACM
`VALIDATION_FAILED`); the schema-level forward compatibility is
free.

**Wait state shape.** `SecondsPath` consumes
`$.steps.<task>.nextWaitSeconds` from the PollResult. The schedule
itself lives in TypeScript inside the polling Lambda — the Lambda
is the source of truth for how often to poll, what backoff to use,
and when to give up. SFN's role is just to wait + re-fire the Task.
`PollResultSchema.in_progress.nextWaitSeconds` is bounded
`int.positive().max(120)`, slightly above the longest tick in
WaitForCloudFront's schedule (90s); future polling Lambdas with
longer ticks can raise this if needed.

**Per-tick state carry-forward.** The polling Task uses the same
`ResultPath: $.steps.<task>` as a single Task state would, so each
poll's PollResult overwrites the prior one. State that needs to
persist across ticks (elapsed-time start, attempt count) lives in
`PollResult.in_progress.pollState` — an opaque `Record<string,
unknown>` at the schema layer, narrowed to a per-Lambda Zod schema
on the next tick's entry. Same opaque-at-universal-layer +
narrowed-by-consumer pattern as `Service.inputs` from PR-B.1.

**DNS pre-flight YAGNI.** The original PR-C.0 design intent
included a DNS resolution check on the alias FQDN after CloudFront
status flips to `Deployed`, with `distribution_domain_name` and
`fqdn` as inputs. **Dropped at PR-C.7** as YAGNI: Route53 alias
records for in-account hosted zones are live as soon as the Route53
API returns success — Route53 is authoritative for its own zones,
no propagation delay applies. The check would always succeed and
never catch anything useful. Re-add only if the architecture
changes (cross-account hosted zone, external DNS provider, or a
class of failures emerges where Route53 returns success but
resolution lags).

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
