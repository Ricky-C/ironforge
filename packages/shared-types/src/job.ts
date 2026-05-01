import { z } from "zod";

// A Job represents one execution of the provisioning workflow against a
// Service. There is at most one active Job per Service at a time;
// re-provisioning later (live → provisioning → live) creates a new Job
// rather than mutating the prior one. See docs/data-model.md §
// "One-active-Job invariant" and Service.currentJobId.
//
// Job is a discriminated union on `status`. The variants encode the
// state-machine progression of a Step Functions execution:
//
//   queued    — DynamoDB row exists; SFN execution not yet started.
//   running   — SFN execution started; in-flight at one of the task steps.
//   succeeded — terminal; the workflow ran finalize successfully.
//   failed    — terminal; cleanup-on-failure ran. failedStep names which
//               task Lambda surfaced the error (denormalized from JobStep
//               so "what failed" is an O(1) read on the Job item).
//   cancelled — terminal; operator-initiated stop via SFN StopExecution.
//
// State-specific fields appear only on the variants that populate them
// (no nullable across-status fields). Code that branches on status must
// use exhaustive switch with `never` default — same discipline as
// ServiceSchema (see docs/data-model.md § Discriminated-union exhaustiveness).

const IsoTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "must be ISO 8601 UTC with milliseconds (e.g. 2026-04-30T15:20:34.567Z)",
  );

// Common fields across all Job status variants.
const JobBaseSchema = z.object({
  id: z.string().uuid(),
  serviceId: z.string().uuid(),
  ownerId: z.string().uuid(),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
});

export const JobQueuedSchema = JobBaseSchema.extend({
  status: z.literal("queued"),
});

// `executionArn` lets operators pivot from a Job row to the underlying
// Step Functions execution in one click. `currentStep` denormalizes
// "where is this?" so operators don't have to scan JobStep entries to
// answer that hot question.
export const JobRunningSchema = JobBaseSchema.extend({
  status: z.literal("running"),
  startedAt: IsoTimestampSchema,
  executionArn: z.string().min(1),
  currentStep: z.string().min(1),
});

export const JobSucceededSchema = JobBaseSchema.extend({
  status: z.literal("succeeded"),
  startedAt: IsoTimestampSchema,
  completedAt: IsoTimestampSchema,
  executionArn: z.string().min(1),
});

// `failedStep` is denormalized from JobStep — Job-level "what failed?" is
// a hot read path; avoiding the JobStep query is worth the small denorm.
// `failureReason` MUST be sanitized by the cleanup-on-failure Lambda
// before write (no AWS resource identifiers, no stack traces) — per
// CLAUDE.md error-handling discipline.
export const JobFailedSchema = JobBaseSchema.extend({
  status: z.literal("failed"),
  startedAt: IsoTimestampSchema,
  failedAt: IsoTimestampSchema,
  executionArn: z.string().min(1),
  failureReason: z.string().min(1),
  failedStep: z.string().min(1),
});

export const JobCancelledSchema = JobBaseSchema.extend({
  status: z.literal("cancelled"),
  startedAt: IsoTimestampSchema,
  cancelledAt: IsoTimestampSchema,
  executionArn: z.string().min(1),
  cancelReason: z.string().min(1),
});

export const JobSchema = z.discriminatedUnion("status", [
  JobQueuedSchema,
  JobRunningSchema,
  JobSucceededSchema,
  JobFailedSchema,
  JobCancelledSchema,
]);
export type Job = z.infer<typeof JobSchema>;

export const JOB_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// DynamoDB single-table key shape for Job items. Mirrors ServiceItem's
// pattern: schema describes entity fields, a separate ItemKeys type
// documents the wire shape, ItemKeys + Job = ItemShape. See
// docs/data-model.md § Entity → key map.
export type JobItemKeys = {
  PK: `JOB#${string}`;
  SK: "META";
  GSI1PK: `SERVICE#${string}`;
  GSI1SK: `JOB#${string}`;
};
export type JobItem = Job & JobItemKeys;

export const buildJobPK = (id: string): `JOB#${string}` => `JOB#${id}`;
export const JOB_SK_META = "META" as const;
export const buildJobGSI1PK = (serviceId: string): `SERVICE#${string}` =>
  `SERVICE#${serviceId}`;
export const buildJobGSI1SK = (
  createdAt: string,
  id: string,
): `JOB#${string}` => `JOB#${createdAt}#${id}`;

export const buildJobKeys = (job: {
  id: string;
  serviceId: string;
  createdAt: string;
}): JobItemKeys => ({
  PK: buildJobPK(job.id),
  SK: JOB_SK_META,
  GSI1PK: buildJobGSI1PK(job.serviceId),
  GSI1SK: buildJobGSI1SK(job.createdAt, job.id),
});
