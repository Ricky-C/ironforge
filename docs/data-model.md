# Ironforge data model

DynamoDB single-table design. One table per environment (`ironforge-dev`,
`ironforge-prod` — see [ADR-005](adrs/005-dynamodb-multi-table-exception.md)
for the per-env rationale). All access patterns documented in this file
must be supported by the keys below; new patterns require either an
existing-key match or an explicit GSI extension.

## Single-table principle

A single table per environment holds every entity Ironforge persists
(services, jobs, job steps, audit events). Distinct entity types share
the table by encoding their type and identity in `PK` / `SK`. This is the
standard single-table design pattern: one table, many access patterns,
keys do the discrimination.

The principle:

- **Operational simplicity.** One table to provision, monitor, back up,
  restore. One PITR setting. One encryption config (AWS-managed per
  [ADR-003](adrs/003-cmk-vs-aws-managed.md)).
- **Cost efficiency.** Pay-per-request billing scales to zero when idle;
  per-entity tables would multiply that footprint without benefit at
  Ironforge's scale.
- **Access patterns drive keys, not entities drive tables.** The shape
  of the keys is determined by the queries we need to run, not by the
  shape of the data.

## Entity → key map

Each row lists the entity, its base-table keys, and any GSI1 entry it
contributes. The **Status** column tracks _schema implementation_ in
`packages/shared-types`, not write-path wiring — entities flagged
_Schema implemented (PR-C.0)_ have their Zod schemas, key helpers, and
TTL config in place but no Lambda yet performs the writes (those land
in PR-C.2+ alongside the state machine).

| Entity            | `PK`                    | `SK`                  | `GSI1PK`            | `GSI1SK`                                | Status                       |
| ----------------- | ----------------------- | --------------------- | ------------------- | --------------------------------------- | ---------------------------- |
| Service           | `SERVICE#<id>`          | `META`                | `OWNER#<sub>`       | `SERVICE#<createdAt>#<id>`              | Schema implemented (PR-B)    |
| Job               | `JOB#<id>`              | `META`                | `SERVICE#<svc-id>`  | `JOB#<createdAt>#<id>`                  | Schema implemented (PR-C.0)  |
| Job step          | `JOB#<id>`              | `STEP#<step-name>`    | _none_              | _none_                                  | Schema implemented (PR-C.0)  |
| Idempotency       | `IDEMPOTENCY#<hash>`    | `META`                | _none_              | _none_                                  | Schema implemented (PR-C.0)  |
| Audit             | `AUDIT#<yyyy-mm-dd>`    | `<iso-ts>#<event-id>` | _none_              | _none_                                  | Documented for future phase  |

Notes on the entries:

- **Service.GSI1SK** uses `<createdAt>#<id>`. The `id` suffix
  collision-proofs same-millisecond creates; without it two simultaneous
  creates would share `GSI1SK` and only one would land.
- **Job step** is queried only by-job, so the base table's
  `PK = JOB#<id>` + `SK begins_with STEP#` covers it. No GSI entry.
  The schema's `stepName` enum is co-evolved with the Step Functions
  state machine — renaming a step requires updating both, which forces
  a deliberate audit. See `packages/shared-types/src/job-step.ts`.
- **Idempotency** records are HTTP-level cache entries for mutating POST
  endpoints (CLAUDE.md § API Conventions § Idempotency). `<hash>` is
  `sha256(idempotencyKey + bodyHash + scopeId)`; `scopeId` is the
  Cognito sub of the requester so cross-tenant collision is impossible
  by construction. Records carry an `expiresAt` Unix-epoch-seconds
  attribute; DynamoDB TTL is enabled on the table for this attribute
  (`infra/modules/dynamodb/main.tf`), so eviction happens within ~48 h
  of expiry without write-path involvement. Default retention is 24 h —
  the value is set at write time by `withIdempotencyKey()`. **Do not
  rely on TTL for security-sensitive eviction** — DynamoDB's TTL SLA
  is best-effort, not guaranteed-by-deadline.
- **Audit** uses date partitioning to keep partition cardinality
  bounded and time-ordered scans cheap. No GSI entry.

## Access patterns

For PR-B, the read API exposes:

| Pattern                    | Index      | Key condition                         | Ordering                           | Pagination                        |
| -------------------------- | ---------- | ------------------------------------- | ---------------------------------- | --------------------------------- |
| `GET /api/services`        | GSI1       | `GSI1PK = OWNER#<sub>`                | `createdAt` desc (default)         | Cursor-based (see § Cursor shape) |
| `GET /api/services/:id`    | base table | `PK = SERVICE#<id>` AND `SK = META`   | n/a (single item)                  | n/a                               |

**Sort direction.** The `GET /api/services` default is newest-first
(`ScanIndexForward = false`); clients may request oldest-first via
`?order=oldest_first`. The query param flips `ScanIndexForward`; nothing
else changes.

**Page size.** `?limit=N`, default 20, valid range `1..100`. Values
outside the range return `400 INVALID_LIMIT` with the max stated
explicitly in the error message — never silently clamp.

Phase 1 will add (documented up front, not yet wired):

- **List jobs by service** — GSI1, `GSI1PK = SERVICE#<svc-id>`, ordered
  by `JOB#<createdAt>#<id>` descending.
- **List steps by job** — base table, `PK = JOB#<id>` AND
  `SK begins_with STEP#`.

## Workflow → DynamoDB write contract

The provisioning workflow is multiple task Lambdas writing into the
single table. Each row below names what attributes a Lambda writes and,
crucially, the **conditional-write check** that protects the
transition from races and out-of-order execution. Reviewers checking
workflow PRs verify the Conditional column against the state machine's
transition graph; if the check is missing or wrong, two concurrent
runs (or a stale Lambda re-fired by SFN retry) can corrupt state.

### Per-step `JobStep` write pattern

Every task Lambda's first action is to upsert its `JobStep` row with
`status: "running"`, a fresh `startedAt`, and `attempts` incremented.
SFN-driven retries overwrite the same row by primary-key uniqueness
(`PK = JOB#<jobId>`, `SK = STEP#<stepName>`) — natural idempotency, no
explicit conditional needed. On terminal success the same row is
updated to `status: "succeeded"` with `completedAt` and the per-step
`output`. On terminal failure it's updated to `status: "failed"` with
`errorName`, `errorMessage` (sanitized — no AWS resource ARNs, no
stack traces, per CLAUDE.md), and `retryable`.

This row-write contract is uniform across every task Lambda (validate-
inputs through cleanup-on-failure) and is therefore not repeated in
the table below. Service / Job transitions are where the conditional
check varies — those are what the table tracks.

### Service / Job transition table

| Trigger                                                | Service write                                                                          | Job write                                                                                            | Conditional-write check                                                                          |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `POST /api/services` — create                          | createIfNotExists: `status=pending`, `currentJobId=null`, owner-scoped fields          | —                                                                                                    | Service: `attribute_not_exists(PK)`.                                                              |
| `POST /api/services` — kickoff (after StartExecution)  | transitionStatus `pending → provisioning`, set `currentJobId=jobId`                    | createIfNotExists `status=queued`, then update to `status=running`, `executionArn`, `startedAt`      | Service: `status=:pending AND currentJobId=:null`. Job create: `attribute_not_exists(PK)`.        |
| Task Lambdas (validate-inputs … trigger-deploy)        | —                                                                                      | UpdateItem `currentStep=<step-name>`, `updatedAt=now`                                                | Job: `status=:running`.                                                                          |
| `finalize`                                             | transitionStatus `provisioning → live`, set `liveUrl`, `provisionedAt`, `currentJobId=null` | transitionStatus `running → succeeded`, set `completedAt`                                            | Service: `status=:provisioning AND currentJobId=:jobId`. Job: `status=:running`.                  |
| `cleanup-on-failure`                                   | transitionStatus `provisioning → failed`, set `failureReason`, `failedAt`, `currentJobId=null` | transitionStatus `running → failed`, set `failedAt`, `failureReason`, `failedStep`                   | Service: `status=:provisioning AND currentJobId=:jobId`. Job: `status=:running`.                  |

The two conditional clauses on `Service.currentJobId` (the kickoff row
and the two terminal rows) are what enforce the **one-active-Job
invariant**: between `POST /api/services` create and finalize/cleanup,
no second kickoff can win the `pending → provisioning` transition
(`currentJobId=:null` fails), and no stale Lambda from a prior Job can
finalize the wrong run (`currentJobId=:jobId` fails). Re-provisioning
later (`live → provisioning → live`) starts a fresh Job; the
finalize/cleanup of that fresh run are still bound to its own jobId.

### Helper mapping

The Conditional column above maps onto helpers in
`@ironforge/shared-utils`:

- `createIfNotExists()` — PutItem with `attribute_not_exists(PK)`. On
  conflict, returns the existing row so the caller decides
  idempotent-success vs. real conflict.
- `transitionStatus()` — UpdateItem with `ConditionExpression` on the
  current status; on condition fail, returns the actual current status
  from a follow-up GetItem.
- Plain `UpdateItem` (no helper) for non-status attribute updates that
  still need a status guard (e.g. `currentStep` updates inside a
  running Job).

### Idempotency layering

HTTP-level idempotency (the `Idempotency-Key` header on `POST
/api/services`) is layered **on top of** the conditional-write
contract above. `withIdempotencyKey()` caches the response shape so
client retries replay rather than re-execute, but the underlying
side-effect (the createIfNotExists in the table's first row) is
itself idempotent on the natural PK. Two layers of safety: the cache
suppresses redundant work; the conditional write suppresses
redundant entities even if the cache misses.

Workflow-level idempotency (SFN retries of task Lambdas) relies on
the `JobStep` natural-key upsert pattern plus
`awsIdempotencyToken()`-derived deterministic strings for AWS SDK
`IdempotencyToken` / `CallerReference` fields (ACM cert requests,
CloudFront distributions). See feedback memory "Two-pattern
idempotency in Ironforge" for the full split.

## GSI1 sharing convention

`GSI1` is shared across entity hierarchies via the **adjacency-list
pattern**:

- **`GSI1PK`** encodes the **parent entity** at any level:
  - `OWNER#<sub>` for top-level entities owned by a user (services).
  - `SERVICE#<id>` for entities owned by a service (jobs).
  - Future: `JOB#<id>` if a child entity needs list-by-job via the index
    (job steps don't, since the base table covers them).
- **`GSI1SK`** encodes the child as `<entity-type>#<sortable-discriminator>#<id>`:
  - `<entity-type>` discriminates child entity types within the same
    parent partition (a service might one day own both jobs and webhooks
    under the same `GSI1PK`; the entity-type prefix keeps them separable).
  - `<sortable-discriminator>` is the sort axis — by default
    `createdAt` for time-ordered lists. Other axes can be encoded
    here if a future pattern requires it; pick whichever lexicographically
    sorts in the desired order.
  - `<id>` collision-proofs same-discriminator entries.

A single GSI supports list-by-parent across the entire entity hierarchy.
New entities should follow this convention rather than carving out new
GSIs unless the access pattern genuinely cannot fit (e.g., a query
keyed off something other than a parent).

### Projection: `ALL`

`GSI1` uses `projection_type = ALL`. Rationale: in single-table designs
the index is queried for full entity data, not just keys. `KEYS_ONLY` /
`INCLUDE` projections force a base-table read per result for any
attribute outside the projection — which both doubles the read cost and
breaks the value of having one round-trip per query. At Ironforge's
scale, the storage cost of `ALL` is rounding error. Revisit only when
storage cost becomes measurable.

## Cursor shape

Cursors for `GET /api/services` encode the GSI1 query's
`LastEvaluatedKey`, which is the four key attributes (`PK`, `SK`,
`GSI1PK`, `GSI1SK`). Wire format: base64url-encoded JSON.

Validation pipeline (decode order):

1. base64url decode → JSON string. Any failure → `400 INVALID_CURSOR`.
2. `JSON.parse` → unknown. Any failure → `400 INVALID_CURSOR`.
3. `ServiceListCursorSchema.safeParse` → typed cursor. Any failure →
   `400 INVALID_CURSOR`.

Only after stage 3 does the cursor flow into DynamoDB as
`ExclusiveStartKey`. Never pass arbitrary client data to DynamoDB.

The schema lives in
[`packages/shared-types/src/pagination.ts`](../packages/shared-types/src/pagination.ts).
The base64 + JSON stages live with the API handler
(`services/api/src/lib/cursor.ts`, lands in PR-B.3) so shared-types
stays free of Node-vs-browser encoding concerns.

Other lists (jobs by service, etc.) get **their own cursor schemas**
matching their GSI's `LastEvaluatedKey` shape. Do not generalize
`ServiceListCursorSchema` — each access pattern documents its own
cursor.

## Inputs boundary

`Service.inputs` is opaque at the Service-entity level
(`z.record(z.string(), z.unknown())`). Per-template input validation
happens in **per-template schemas** that live alongside the template, not
on the Service entity:

```
packages/shared-types/src/templates/static-site.ts   (StaticSiteInputsSchema)
packages/shared-types/src/templates/<future>.ts      (when added)
```

Per-template schemas are consumed by:

- The wizard form on `apps/web` (form-level validation before submit).
- The API handler at `POST /api/services` (first-pass validation
  before kicking off the workflow).
- The `validate-inputs` workflow Lambda (workflow-time re-validation,
  guarding against schema drift between API and Lambda deploys).
- The `template-renderer` package (knows what fields to substitute into
  generated code).

All consumers resolve `templateId → InputsSchema` through
`TEMPLATE_REGISTRY` in `@ironforge/shared-types`. Single source of
truth — no parallel maps per consumer.

The Service entity stays stable as templates are added. New templates
mean new files under `templates/`, not changes to `ServiceSchema`.

## Template artifact storage

Storage is per-artifact-type, not project-wide. Each PR optimizes for
the artifact's runtime characteristics; the philosophy is "match the
storage to the access pattern," not "one bucket for everything."

| Artifact          | Storage                  | Decided in |
| ----------------- | ------------------------ | ---------- |
| Manifest YAML     | Bundled in Lambda dist   | PR-C.3     |
| Starter code      | Bundled in Lambda dist (PR-C.5). Revisit if a second template arrives or if total starter-code size exceeds 1MB. | PR-C.5     |
| Terraform module  | Baked into the run-terraform Lambda's container image at `/opt/templates/<template-id>/terraform/` (PR-C.6). Per ADR-009 § Amendments — the AWS provider 5.83.0 binary alone is 585MB, blowing Lambda's 250MB layer cap, so run-terraform deploys as a container Lambda. The template's terraform module rides in the same image because the access pattern is per-invocation read-only ("download the module once at image build, never at runtime") and locality with the bundled provider keeps `terraform init` offline. | PR-C.6     |

Manifest YAML is bundled into the validate-inputs Lambda at esbuild
time via `loader: { ".yaml": "text" }` and parsed + validated at module
load. Rationale: manifest changes are rare and always accompany a
template terraform/code change, which already requires a Lambda
redeploy — bundling adds no friction. Cold-start parse cost is
negligible.

The manifest's `inputsSchema` field (a path-with-fragment string like
`packages/shared-types/src/templates/static-site.ts#StaticSiteInputsSchema`)
is documentation-only — it tells humans where the schema lives.
Runtime resolution goes through `TEMPLATE_REGISTRY`, not by parsing
that path string.

Starter code is snapshot'd into the generate-code Lambda's bundle by
the Lambda's `build.mjs`: walks `templates/static-site/starter-code/`
and emits a `Record<string, string>` of file path → content into
`src/starter-code-snapshot/files.ts`. The committed version is a stub
(empty record) so typecheck/test pass without running the build first;
CI's build step populates the real content before bundling. This
matches the Manifest YAML pattern (cold-start config-loading
convention) — a build-time-known artifact that travels with the
Lambda's deploy.

The substitution boundary lives at the Lambda level (not the storage
level): generate-code substitutes only build-time-known placeholders
(`__IRONFORGE_SERVICE_NAME__`, `__IRONFORGE_DOMAIN__`); runtime values
from terraform outputs (deploy role ARN, S3 bucket, CloudFront
distribution) flow through GitHub Actions repo secrets populated by
trigger-deploy. See `docs/conventions.md` § "Template substitution
boundary" for the convention.

Terraform modules are staged into the run-terraform Lambda's container
image at `/opt/templates/<template-id>/terraform/` by
`infra/modules/terraform-lambda-image/build-image.sh`'s "Copy templates
into build context" step. The Dockerfile's `COPY templates
/opt/templates` lands them at the conventional `/opt` (platform tooling)
path; the handler resolves `${TEMPLATE_PATH}/<template-id>/terraform`
where `TEMPLATE_PATH=/opt/templates` is wired from the dev composition.
At runtime the handler generates a per-job wrapper main.tf at
`/tmp/<jobId>/main.tf` that imports the template via filesystem source
(`source = "/opt/templates/static-site/terraform"`) and supplies the
backend "s3" block + 11 input variables. Per the ADR-009 amendment, the
template's own `versions.tf` was modified in PR-C.6 to remove its
`backend "s3" {}` block — terraform forbids backend declarations in
non-root modules, and the wrapper is now the root.

## OwnerId convention

Service.ownerId is the Cognito `sub` claim — and only the Cognito `sub`
claim. The chain:

1. API Gateway HTTP API JWT authorizer verifies the token and injects
   claims into `event.requestContext.authorizer.jwt.claims`.
2. `services/api/src/middleware/auth.ts` reads `claims.sub`, validates
   via `IronforgeUserSchema`, and sets `c.set("user", { sub })`.
3. Handlers read `c.get("user").sub` and use it directly — both as the
   value stored on `Service.ownerId` and as the input to
   `buildServiceGSI1PK(sub)`.

Single source of truth: the `sub` from the verified JWT. No alternative
ownerId paths (email, username, custom claims) enter handler code. This
keeps the GSI1PK construction deterministic across read and write paths
and prevents a class of subtle bugs where the same user's services land
under two different `OWNER#` partitions.

See `services/api/src/middleware/claims.ts` for the canonical comment on
`sub` as the user identifier.

## Immutability commitments

### `Service.name`

`Service.name` is **immutable post-creation** as a design commitment.
The name is the subdomain (`<name>.ironforge.rickycaballero.com`) and
is baked into:

- ACM certificate SANs (CloudFront wildcard cert validates per-name).
- Route53 records.
- The provisioned GitHub repository name.
- CI/CD workflow configurations in the user's repo.
- Generated starter code (links back to the service detail page).

Changing the name is not an edit; it requires deprovisioning the
existing service and provisioning a new one. The API does **not** expose
a name-mutation endpoint. There is no Phase 1 rename flow.

### `Service.id`, `Service.ownerId`, `Service.createdAt`

Immutable for the obvious reasons (identity, ownership transfer is not a
supported operation, creation time is a fact). Mutation is a schema
violation, not an access-control failure.

### Other fields

`status`, `updatedAt`, state-specific fields (`liveUrl`, `provisionedAt`,
`failureReason`, `failedAt`, `archivedAt`) and `inputs` are mutable —
the provisioning workflow updates them as state transitions occur.

## Discriminated-union exhaustiveness

`Service` is a discriminated union on `status`. Handlers that branch on
status **must** use exhaustive `switch` with a `never`-typed default:

```ts
switch (service.status) {
  case "pending":      /* ... */ break;
  case "provisioning": /* ... */ break;
  case "live":         /* ... */ break;
  case "failed":       /* ... */ break;
  case "archived":     /* ... */ break;
  default: {
    const _exhaustive: never = service;
    throw new Error(`unhandled service status: ${(service as Service).status}`);
  }
}
```

The `never` default catches future status additions at compile time. If
a sixth status is added to `ServiceSchema` and a switch is missed, the
TypeScript compiler will flag the assignment to `_exhaustive` because
the new variant is not assignable to `never`.

`if`/`else if` chains lose this property — the compiler cannot see
which branches you skipped. Always use `switch` for status discrimination.

This pattern applies to any future discriminated union in the codebase,
not just `Service.status`.

## Bulk-create caveat

`GSI1SK` uses `<createdAt>#<id>` with **millisecond timestamp precision**.
At Phase 1's user-driven creation rate (a human filling out a wizard),
millisecond-plus-UUID collision-proofs every realistic case.

If a bulk-create or programmatic-create path lands later (e.g., an
import API, a "clone existing service" feature, or seed-data tooling),
revisit:

- Sub-millisecond clock granularity is implementation-defined. Two
  same-millisecond creates depend entirely on the UUID suffix to sort
  deterministically — fine, but `createdAt` ordering becomes
  ambiguous within the millisecond.
- Snowflake-like IDs (time-prefix + monotonic counter) become more
  useful: they remove the timestamp-collision question entirely and
  give a per-process strict total order.

The current shape is deliberate for Phase 1; the revisit trigger is
"a non-human-driven create path is added."

## Schema authority

The Zod schemas in `packages/shared-types/src/` are authoritative for
shape. This document describes intent; the schemas describe the
on-the-wire and at-rest reality. If they diverge, fix the doc — the
schemas are the source of truth.

Specifically:

- [`service.ts`](../packages/shared-types/src/service.ts) — `Service`
  variants, key construction helpers (`buildServiceKeys` and friends),
  `ServiceItem` type for the DynamoDB-side shape, including the
  `currentJobId` field that anchors the one-active-Job invariant.
- [`job.ts`](../packages/shared-types/src/job.ts) — `Job` variants
  (queued / running / succeeded / failed / cancelled), key helpers,
  `JobItem`.
- [`job-step.ts`](../packages/shared-types/src/job-step.ts) — `JobStep`
  variants (running / succeeded / failed), `StepNameSchema` enum
  co-evolved with the state machine, `JobStepItem`.
- [`workflow.ts`](../packages/shared-types/src/workflow.ts) —
  `WorkflowExecutionInputSchema`, the immutable snapshot passed at
  Step Functions `StartExecution`.
- [`idempotency.ts`](../packages/shared-types/src/idempotency.ts) —
  `IdempotencyRecordSchema`, key helpers, the `expiresAt` TTL
  attribute matched by the table's TTL config.
- [`polling.ts`](../packages/shared-types/src/polling.ts) —
  `PollResultSchema` for polling task Lambdas (wait-for-cert,
  wait-for-cloudfront).
- [`pagination.ts`](../packages/shared-types/src/pagination.ts) —
  `ServiceListCursorSchema`.
- [`api.ts`](../packages/shared-types/src/api.ts) — `ApiResponseSchema`,
  `ApiErrorCode` union, error envelope.

## Related

- [ADR-005 — DynamoDB Multi-Table Per Environment](adrs/005-dynamodb-multi-table-exception.md)
- [ADR-003 — CMK vs AWS-Managed Encryption](adrs/003-cmk-vs-aws-managed.md)
- `CLAUDE.md` § DynamoDB Single-Table Conventions
- `CLAUDE.md` § Authentication (sub-as-canonical-identifier rationale)
