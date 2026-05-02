import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@ironforge/shared-utils";
import type { IronforgeManifest } from "@ironforge/shared-types";
import { mockClient } from "aws-sdk-client-mock";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildHandler } from "./handle-event.js";

const ddbMock = mockClient(docClient);

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

const STATIC_SITE_MANIFEST: IronforgeManifest = {
  id: "static-site",
  name: "Static Website",
  description: "test fixture",
  version: 1,
  compatibleIronforgeVersion: 1,
  inputsSchema: "packages/shared-types/src/templates/static-site.ts#StaticSiteInputsSchema",
  outputsSchema: "templates/static-site/terraform/outputs.tf",
  allowedResourceTypes: ["aws_s3_bucket"],
};

const VALID_INPUT = {
  serviceId: "11111111-1111-4111-8111-111111111111",
  jobId: "22222222-2222-4222-8222-222222222222",
  executionName: "22222222-2222-4222-8222-222222222222",
  serviceName: "my-site",
  ownerId: "33333333-3333-4333-8333-333333333333",
  templateId: "static-site",
  inputs: {},
};

const findUpdateBy = (predicate: (e: Record<string, unknown>) => boolean) => {
  const calls = ddbMock.commandCalls(UpdateCommand);
  const match = calls.find((c) => {
    const values = c.args[0].input.ExpressionAttributeValues ?? {};
    return predicate(values);
  });
  return match?.args[0].input;
};

describe("validate-inputs handler — happy path", () => {
  it("returns { valid, templateId, validatedAt } and writes JobStep running → succeeded", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const handler = buildHandler(STATIC_SITE_MANIFEST);
    const result = await handler(VALID_INPUT);

    expect(result.valid).toBe(true);
    expect(result.templateId).toBe("static-site");
    expect(typeof result.validatedAt).toBe("string");
    expect(result.validatedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(2); // running + succeeded

    expect(calls[0]!.args[0].input.UpdateExpression).toContain("ADD attempts :one");
    expect(calls[1]!.args[0].input.UpdateExpression).toContain("#status = :succeeded");
    expect(calls[1]!.args[0].input.ExpressionAttributeValues?.[":output"]).toEqual({
      valid: true,
      templateId: "static-site",
      validatedAt: result.validatedAt,
    });
  });
});

describe("validate-inputs handler — workflow input parse failure", () => {
  it("throws IronforgeWorkflowInputError with sanitized message and writes nothing", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const handler = buildHandler(STATIC_SITE_MANIFEST);
    await expect(handler({ not: "valid" })).rejects.toMatchObject({
      name: "IronforgeWorkflowInputError",
    });

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("does not leak zod issues into the thrown error message", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const handler = buildHandler(STATIC_SITE_MANIFEST);
    try {
      await handler({ jobId: "not-a-uuid" });
      expect.fail("expected throw");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain("jobId");
      expect(message).toContain("see CloudWatch");
    }
  });
});

describe("validate-inputs handler — manifest mismatch", () => {
  it("throws IronforgeTemplateMismatchError when input.templateId differs from manifest.id", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    // Manifest claims static-site, but input arrives with a different
    // templateId. Real-world cause: state machine routed wrong, or two
    // Lambdas deployed under the wrong function names.
    const otherManifest: IronforgeManifest = {
      ...STATIC_SITE_MANIFEST,
      id: "some-other-template",
    };
    const handler = buildHandler(otherManifest);

    await expect(handler(VALID_INPUT)).rejects.toMatchObject({
      name: "IronforgeTemplateMismatchError",
    });

    // Running upsert lands first (we have a jobId), then failed.
    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(2);
    const failed = findUpdateBy((v) => v[":failed"] === "failed");
    expect(failed?.ExpressionAttributeValues?.[":errorName"]).toBe(
      "IronforgeTemplateMismatchError",
    );
    expect(failed?.ExpressionAttributeValues?.[":retryable"]).toBe(false);
  });
});

describe("validate-inputs handler — per-template inputs rejection", () => {
  it("throws IronforgeValidationError when StaticSiteInputsSchema rejects (strict-mode unknown key)", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const handler = buildHandler(STATIC_SITE_MANIFEST);
    const badInputs = { ...VALID_INPUT, inputs: { pageTitle: "anything" } };

    await expect(handler(badInputs)).rejects.toMatchObject({
      name: "IronforgeValidationError",
    });

    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(2); // running + failed (no succeeded)
    const failed = findUpdateBy((v) => v[":failed"] === "failed");
    expect(failed?.ExpressionAttributeValues?.[":errorName"]).toBe(
      "IronforgeValidationError",
    );
    expect(failed?.ExpressionAttributeValues?.[":retryable"]).toBe(false);
    expect(failed?.ExpressionAttributeValues?.[":errorMessage"]).toMatch(
      /per-template validation/,
    );
  });

  it("does not leak zod issues into the JobStep errorMessage", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const handler = buildHandler(STATIC_SITE_MANIFEST);
    const badInputs = {
      ...VALID_INPUT,
      inputs: { pageTitle: "anything", anotherField: 42 },
    };
    await expect(handler(badInputs)).rejects.toThrow();

    const failed = findUpdateBy((v) => v[":failed"] === "failed");
    const message = failed?.ExpressionAttributeValues?.[":errorMessage"] as string;
    expect(message).not.toContain("pageTitle");
    expect(message).not.toContain("anotherField");
  });
});
