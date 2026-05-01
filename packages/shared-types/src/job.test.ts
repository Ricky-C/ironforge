import { describe, expect, it } from "vitest";

import {
  buildJobGSI1PK,
  buildJobGSI1SK,
  buildJobKeys,
  buildJobPK,
  JobCancelledSchema,
  JobFailedSchema,
  JobQueuedSchema,
  JobRunningSchema,
  JobSchema,
  JobSucceededSchema,
  JOB_SK_META,
  JOB_STATUSES,
} from "./job.js";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const SERVICE_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";
const TIMESTAMP = "2026-04-30T15:20:34.567Z";
const EXECUTION_ARN =
  "arn:aws:states:us-east-1:123456789012:execution:ironforge-provisioning:" + JOB_ID;

const baseFields = {
  id: JOB_ID,
  serviceId: SERVICE_ID,
  ownerId: OWNER_ID,
  createdAt: TIMESTAMP,
  updatedAt: TIMESTAMP,
};

describe("JobSchema variants", () => {
  it("parses queued", () => {
    const result = JobQueuedSchema.safeParse({ ...baseFields, status: "queued" });
    expect(result.success).toBe(true);
  });

  it("parses running with startedAt + executionArn + currentStep", () => {
    const result = JobRunningSchema.safeParse({
      ...baseFields,
      status: "running",
      startedAt: TIMESTAMP,
      executionArn: EXECUTION_ARN,
      currentStep: "create-repo",
    });
    expect(result.success).toBe(true);
  });

  it("rejects running without executionArn", () => {
    const result = JobRunningSchema.safeParse({
      ...baseFields,
      status: "running",
      startedAt: TIMESTAMP,
      currentStep: "create-repo",
    });
    expect(result.success).toBe(false);
  });

  it("rejects running with empty executionArn", () => {
    const result = JobRunningSchema.safeParse({
      ...baseFields,
      status: "running",
      startedAt: TIMESTAMP,
      executionArn: "",
      currentStep: "create-repo",
    });
    expect(result.success).toBe(false);
  });

  it("parses succeeded with completedAt", () => {
    const result = JobSucceededSchema.safeParse({
      ...baseFields,
      status: "succeeded",
      startedAt: TIMESTAMP,
      completedAt: TIMESTAMP,
      executionArn: EXECUTION_ARN,
    });
    expect(result.success).toBe(true);
  });

  it("parses failed with failureReason and failedStep", () => {
    const result = JobFailedSchema.safeParse({
      ...baseFields,
      status: "failed",
      startedAt: TIMESTAMP,
      failedAt: TIMESTAMP,
      executionArn: EXECUTION_ARN,
      failureReason: "ACM cert validation timeout",
      failedStep: "wait-for-cert",
    });
    expect(result.success).toBe(true);
  });

  it("rejects failed without failedStep", () => {
    const result = JobFailedSchema.safeParse({
      ...baseFields,
      status: "failed",
      startedAt: TIMESTAMP,
      failedAt: TIMESTAMP,
      executionArn: EXECUTION_ARN,
      failureReason: "anything",
    });
    expect(result.success).toBe(false);
  });

  it("parses cancelled with cancelReason", () => {
    const result = JobCancelledSchema.safeParse({
      ...baseFields,
      status: "cancelled",
      startedAt: TIMESTAMP,
      cancelledAt: TIMESTAMP,
      executionArn: EXECUTION_ARN,
      cancelReason: "operator stopped via console",
    });
    expect(result.success).toBe(true);
  });

  it("discriminated union dispatches on status", () => {
    const result = JobSchema.safeParse({
      ...baseFields,
      status: "running",
      startedAt: TIMESTAMP,
      executionArn: EXECUTION_ARN,
      currentStep: "validate-inputs",
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown status", () => {
    const result = JobSchema.safeParse({ ...baseFields, status: "ghost" });
    expect(result.success).toBe(false);
  });

  it("rejects malformed timestamp on startedAt", () => {
    const result = JobRunningSchema.safeParse({
      ...baseFields,
      status: "running",
      startedAt: "2026-04-30T15:20:34Z",
      executionArn: EXECUTION_ARN,
      currentStep: "validate-inputs",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-uuid id", () => {
    const result = JobQueuedSchema.safeParse({
      ...baseFields,
      id: "not-a-uuid",
      status: "queued",
    });
    expect(result.success).toBe(false);
  });

  it("JOB_STATUSES enumerates all variants", () => {
    expect([...JOB_STATUSES].sort()).toEqual(
      ["cancelled", "failed", "queued", "running", "succeeded"].sort(),
    );
  });
});

describe("Job key construction helpers", () => {
  it("buildJobPK formats JOB#<id>", () => {
    expect(buildJobPK(JOB_ID)).toBe(`JOB#${JOB_ID}`);
  });

  it("buildJobGSI1PK formats SERVICE#<svc-id>", () => {
    expect(buildJobGSI1PK(SERVICE_ID)).toBe(`SERVICE#${SERVICE_ID}`);
  });

  it("buildJobGSI1SK formats JOB#<timestamp>#<id>", () => {
    expect(buildJobGSI1SK(TIMESTAMP, JOB_ID)).toBe(`JOB#${TIMESTAMP}#${JOB_ID}`);
  });

  it("buildJobKeys produces the full key set", () => {
    const keys = buildJobKeys({
      id: JOB_ID,
      serviceId: SERVICE_ID,
      createdAt: TIMESTAMP,
    });
    expect(keys).toEqual({
      PK: `JOB#${JOB_ID}`,
      SK: JOB_SK_META,
      GSI1PK: `SERVICE#${SERVICE_ID}`,
      GSI1SK: `JOB#${TIMESTAMP}#${JOB_ID}`,
    });
  });
});
