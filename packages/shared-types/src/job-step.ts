import { z } from "zod";

// A JobStep is one row per (Job, step-name) — the step's per-run record.
// Entries don't exist until a step starts running; there is no "pending"
// status in the schema. Each step Lambda writes the row when it begins
// (status = running) and updates the same row to the terminal status
// (succeeded / failed) before exiting. The DynamoDB primary key
// (PK = JOB#<jobId>, SK = STEP#<stepName>) gives natural idempotency: a
// retry overwrites rather than duplicates.

const IsoTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "must be ISO 8601 UTC with milliseconds (e.g. 2026-04-30T15:20:34.567Z)",
  );

// stepName is enumerated against the Step Functions state machine. The
// schema and the state machine co-evolve; renaming a step requires
// updating this enum, which forces a deliberate audit. New steps land
// here when the state machine adds them.
//
// `wait-for-cert` was originally listed here (PR-C.0) but was dropped
// from the workflow at PR-C.1 design conversation when the cert
// strategy switched to the shared `*.ironforge.rickycaballero.com`
// wildcard cert. Re-introduction would happen in tandem with the
// per-service cert opt-in feature tracked in `docs/tech-debt.md` —
// extending this enum is one of the change-set items there.
export const STEP_NAMES = [
  "validate-inputs",
  "create-repo",
  "generate-code",
  "run-terraform",
  "wait-for-cloudfront",
  "trigger-deploy",
  "wait-for-deploy",
  "finalize",
  "cleanup-on-failure",
] as const;
export const StepNameSchema = z.enum(STEP_NAMES);
export type StepName = (typeof STEP_NAMES)[number];

const JobStepBaseSchema = z.object({
  jobId: z.string().uuid(),
  stepName: StepNameSchema,
  // `attempts` increments on every Lambda invocation for this step,
  // including SFN retries. Operators read it to spot retry-storm
  // patterns without parsing CloudWatch logs.
  attempts: z.number().int().nonnegative(),
  updatedAt: IsoTimestampSchema,
});

export const JobStepRunningSchema = JobStepBaseSchema.extend({
  status: z.literal("running"),
  startedAt: IsoTimestampSchema,
});

// `output` is opaque per-step. Each step Lambda defines its own shape
// — e.g. create-repo writes `{ repoUrl, repoId }`, generate-code writes
// `{ artifactKey }`. Consumers that need a typed view validate against
// the step-specific schema downstream. Keeping this opaque at the
// JobStep level avoids coupling all step output shapes into one schema.
export const JobStepSucceededSchema = JobStepBaseSchema.extend({
  status: z.literal("succeeded"),
  startedAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema,
  output: z.record(z.string(), z.unknown()),
});

// `errorMessage` MUST be sanitized by the step Lambda before write (no
// AWS resource identifiers, no stack traces) — per CLAUDE.md error
// sanitization. `retryable` discriminates "SFN may invoke me again"
// from "terminal — stop retrying." cleanup-on-failure consumes this.
export const JobStepFailedSchema = JobStepBaseSchema.extend({
  status: z.literal("failed"),
  startedAt: IsoTimestampSchema,
  failedAt: IsoTimestampSchema,
  errorName: z.string().min(1),
  errorMessage: z.string().min(1),
  retryable: z.boolean(),
});

export const JobStepSchema = z.discriminatedUnion("status", [
  JobStepRunningSchema,
  JobStepSucceededSchema,
  JobStepFailedSchema,
]);
export type JobStep = z.infer<typeof JobStepSchema>;

export const JOB_STEP_STATUSES = ["running", "succeeded", "failed"] as const;
export type JobStepStatus = (typeof JOB_STEP_STATUSES)[number];

// DynamoDB single-table key shape. JobStep is queried only by-job
// (PK = JOB#<id> AND SK begins_with STEP#) so it has no GSI1 entry —
// the base table covers all access patterns. See docs/data-model.md.
export type JobStepItemKeys = {
  PK: `JOB#${string}`;
  SK: `STEP#${StepName}`;
};
export type JobStepItem = JobStep & JobStepItemKeys;

export const buildJobStepPK = (jobId: string): `JOB#${string}` => `JOB#${jobId}`;
export const buildJobStepSK = (stepName: StepName): `STEP#${StepName}` =>
  `STEP#${stepName}`;

export const buildJobStepKeys = (step: {
  jobId: string;
  stepName: StepName;
}): JobStepItemKeys => ({
  PK: buildJobStepPK(step.jobId),
  SK: buildJobStepSK(step.stepName),
});
