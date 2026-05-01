import { z } from "zod";

import { ServiceNameSchema } from "./service.js";

// Input payload for a Step Functions execution. Carries the
// workflow-invariant snapshot — fields that are immutable across the run
// — so each task Lambda has them at hand without re-reading DynamoDB.
//
// Three data classes flow through a workflow execution:
//
//   1. Workflow-invariant snapshots (this schema)
//      Captured at execution start; never mutated mid-run. Lambdas read
//      from the SFN execution input.
//   2. Mutable Service / Job state
//      Lambdas read+write to DynamoDB. The source of truth.
//   3. Transient inter-step data (intermediate ARNs, temp keys)
//      Lambdas pass via SFN ResultPath. Not persisted.
//
// `executionName` equals `jobId` and is the idempotency boundary —
// SFN rejects a second StartExecution with the same name in the same
// state machine, so the kickoff endpoint is naturally idempotent on
// (serviceId, jobId).
export const WorkflowExecutionInputSchema = z.object({
  serviceId: z.string().uuid(),
  jobId: z.string().uuid(),
  executionName: z.string().min(1),

  // Snapshots — immutable for the run. Re-provisioning later starts a
  // new execution with a new snapshot.
  serviceName: ServiceNameSchema,
  ownerId: z.string().uuid(),
  templateId: z.string().min(1),

  // `inputs` is the per-template input payload. Validated against the
  // template-specific schema (e.g. StaticSiteInputsSchema) inside the
  // validate-inputs task Lambda — at the entity level it's opaque so
  // the workflow contract stays template-agnostic.
  inputs: z.record(z.string(), z.unknown()),
});
export type WorkflowExecutionInput = z.infer<typeof WorkflowExecutionInputSchema>;
