import { describe, expect, it } from "vitest";

import { WorkflowExecutionInputSchema } from "./workflow.js";

const SERVICE_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_ID = "33333333-3333-4333-8333-333333333333";

const baseInput = {
  serviceId: SERVICE_ID,
  jobId: JOB_ID,
  executionName: JOB_ID,
  serviceName: "my-site",
  ownerId: OWNER_ID,
  templateId: "static-site",
  inputs: { framework: "next" },
};

describe("WorkflowExecutionInputSchema", () => {
  it("accepts a well-formed input", () => {
    expect(WorkflowExecutionInputSchema.safeParse(baseInput).success).toBe(true);
  });

  it("accepts empty inputs record", () => {
    expect(
      WorkflowExecutionInputSchema.safeParse({ ...baseInput, inputs: {} }).success,
    ).toBe(true);
  });

  it("rejects when serviceId is not a uuid", () => {
    const result = WorkflowExecutionInputSchema.safeParse({
      ...baseInput,
      serviceId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when serviceName violates the DNS-label rules", () => {
    const result = WorkflowExecutionInputSchema.safeParse({
      ...baseInput,
      serviceName: "UPPER",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when executionName is empty", () => {
    const result = WorkflowExecutionInputSchema.safeParse({
      ...baseInput,
      executionName: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects when templateId is empty", () => {
    const result = WorkflowExecutionInputSchema.safeParse({
      ...baseInput,
      templateId: "",
    });
    expect(result.success).toBe(false);
  });
});
