import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@ironforge/shared-utils";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { stubTask } from "./stub-task.js";

const ddbMock = mockClient(docClient);

const VALID_INPUT = {
  serviceId: "11111111-1111-4111-8111-111111111111",
  jobId: "22222222-2222-4222-8222-222222222222",
  executionName: "22222222-2222-4222-8222-222222222222",
  serviceName: "my-site",
  ownerId: "33333333-3333-4333-8333-333333333333",
  templateId: "static-site",
  inputs: {},
};

const ORIGINAL_TABLE = process.env["DYNAMODB_TABLE_NAME"];
beforeAll(() => {
  process.env["DYNAMODB_TABLE_NAME"] = "ironforge-test";
});
afterAll(() => {
  if (ORIGINAL_TABLE === undefined) {
    delete process.env["DYNAMODB_TABLE_NAME"];
  } else {
    process.env["DYNAMODB_TABLE_NAME"] = ORIGINAL_TABLE;
  }
});
beforeEach(() => {
  ddbMock.reset();
});

describe("stubTask", () => {
  it("upserts JobStep running → succeeded with the supplied output", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const handler = stubTask({
      stepName: "validate-inputs",
      buildOutput: () => ({ valid: true }),
    });
    const result = await handler(VALID_INPUT);

    expect(result).toEqual({ valid: true });

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(2); // running + succeeded
    expect(calls[0]!.args[0].input.UpdateExpression).toContain("ADD attempts :one");
    expect(calls[1]!.args[0].input.UpdateExpression).toContain("#status = :succeeded");
    expect(calls[1]!.args[0].input.ExpressionAttributeValues?.[":output"]).toEqual({
      valid: true,
    });
  });

  it("passes the parsed event to buildOutput", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const handler = stubTask({
      stepName: "create-repo",
      buildOutput: (event) => ({ serviceName: event.serviceName, jobId: event.jobId }),
    });
    const result = await handler(VALID_INPUT);

    expect(result).toEqual({ serviceName: "my-site", jobId: VALID_INPUT.jobId });
  });

  it("rejects malformed input with IronforgeStubInputError (custom name → SFN no-retry)", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const handler = stubTask({
      stepName: "validate-inputs",
      buildOutput: () => ({}),
    });

    await expect(handler({ not: "valid" })).rejects.toMatchObject({
      name: "IronforgeStubInputError",
    });

    // No JobStep writes when input is unparseable — Lambda fails before
    // it can identify a jobId to write against.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("upserts JobStep failed when buildOutput throws", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const handler = stubTask({
      stepName: "create-repo",
      buildOutput: () => {
        throw new Error("simulated build error");
      },
    });

    await expect(handler(VALID_INPUT)).rejects.toThrow("simulated build error");

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(2); // running + failed (no succeeded)
    expect(calls[1]!.args[0].input.UpdateExpression).toContain("#status = :failed");
    expect(calls[1]!.args[0].input.ExpressionAttributeValues?.[":retryable"]).toBe(false);
  });
});
