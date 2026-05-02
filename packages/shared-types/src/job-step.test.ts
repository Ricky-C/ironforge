import { describe, expect, it } from "vitest";

import {
  buildJobStepKeys,
  buildJobStepPK,
  buildJobStepSK,
  JobStepFailedSchema,
  JobStepRunningSchema,
  JobStepSchema,
  JobStepSucceededSchema,
  STEP_NAMES,
  StepNameSchema,
} from "./job-step.js";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const TIMESTAMP = "2026-04-30T15:20:34.567Z";

const baseFields = {
  jobId: JOB_ID,
  stepName: "validate-inputs" as const,
  attempts: 0,
  updatedAt: TIMESTAMP,
};

describe("StepNameSchema", () => {
  it.each(STEP_NAMES)("accepts %s", (name) => {
    expect(StepNameSchema.safeParse(name).success).toBe(true);
  });

  it("rejects unknown step name", () => {
    expect(StepNameSchema.safeParse("not-a-step").success).toBe(false);
  });

  it("rejects wait-for-cert (dropped at PR-C.1)", () => {
    // wait-for-cert was removed from the workflow when the cert
    // strategy switched to the shared wildcard. Confirming the
    // enum no longer accepts it prevents an accidental re-add.
    expect(StepNameSchema.safeParse("wait-for-cert").success).toBe(false);
  });
});

describe("JobStepSchema variants", () => {
  it("parses running", () => {
    const result = JobStepRunningSchema.safeParse({
      ...baseFields,
      status: "running",
      startedAt: TIMESTAMP,
    });
    expect(result.success).toBe(true);
  });

  it("parses succeeded with output", () => {
    const result = JobStepSucceededSchema.safeParse({
      ...baseFields,
      status: "succeeded",
      startedAt: TIMESTAMP,
      completedAt: TIMESTAMP,
      output: { repoUrl: "https://github.com/ironforge-svc/foo", repoId: 42 },
    });
    expect(result.success).toBe(true);
  });

  it("parses succeeded with empty output object", () => {
    const result = JobStepSucceededSchema.safeParse({
      ...baseFields,
      status: "succeeded",
      startedAt: TIMESTAMP,
      completedAt: TIMESTAMP,
      output: {},
    });
    expect(result.success).toBe(true);
  });

  it("parses failed with retryable=true", () => {
    const result = JobStepFailedSchema.safeParse({
      ...baseFields,
      status: "failed",
      startedAt: TIMESTAMP,
      failedAt: TIMESTAMP,
      errorName: "ThrottlingException",
      errorMessage: "rate exceeded",
      retryable: true,
    });
    expect(result.success).toBe(true);
  });

  it("parses failed with retryable=false", () => {
    const result = JobStepFailedSchema.safeParse({
      ...baseFields,
      status: "failed",
      startedAt: TIMESTAMP,
      failedAt: TIMESTAMP,
      errorName: "ValidationException",
      errorMessage: "invalid input shape",
      retryable: false,
    });
    expect(result.success).toBe(true);
  });

  it("rejects failed with empty errorMessage", () => {
    const result = JobStepFailedSchema.safeParse({
      ...baseFields,
      status: "failed",
      startedAt: TIMESTAMP,
      failedAt: TIMESTAMP,
      errorName: "X",
      errorMessage: "",
      retryable: true,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative attempts", () => {
    const result = JobStepRunningSchema.safeParse({
      ...baseFields,
      attempts: -1,
      status: "running",
      startedAt: TIMESTAMP,
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer attempts", () => {
    const result = JobStepRunningSchema.safeParse({
      ...baseFields,
      attempts: 1.5,
      status: "running",
      startedAt: TIMESTAMP,
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown stepName", () => {
    const result = JobStepRunningSchema.safeParse({
      ...baseFields,
      stepName: "not-a-step",
      status: "running",
      startedAt: TIMESTAMP,
    });
    expect(result.success).toBe(false);
  });

  it("discriminated union dispatches on status", () => {
    const result = JobStepSchema.safeParse({
      ...baseFields,
      status: "succeeded",
      startedAt: TIMESTAMP,
      completedAt: TIMESTAMP,
      output: {},
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown status", () => {
    const result = JobStepSchema.safeParse({ ...baseFields, status: "ghost" });
    expect(result.success).toBe(false);
  });
});

describe("JobStep key construction helpers", () => {
  it("buildJobStepPK formats JOB#<id>", () => {
    expect(buildJobStepPK(JOB_ID)).toBe(`JOB#${JOB_ID}`);
  });

  it("buildJobStepSK formats STEP#<step>", () => {
    expect(buildJobStepSK("create-repo")).toBe("STEP#create-repo");
  });

  it("buildJobStepKeys produces the full key set", () => {
    const keys = buildJobStepKeys({ jobId: JOB_ID, stepName: "create-repo" });
    expect(keys).toEqual({
      PK: `JOB#${JOB_ID}`,
      SK: "STEP#create-repo",
    });
  });
});
