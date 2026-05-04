import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { Uint8ArrayBlobAdapter } from "@smithy/util-stream";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { destroyTerraform } from "./destroy-terraform.js";

// Lambda InvokeCommandOutput.Payload is typed as Uint8ArrayBlobAdapter
// (a Uint8Array subclass with `transformToString`). Buffer.from doesn't
// satisfy that subtype, so test fixtures use the Smithy helper.
const payload = (s: string): Uint8ArrayBlobAdapter =>
  Uint8ArrayBlobAdapter.fromString(s);

const lambdaMock = mockClient(LambdaClient);

const VALID_INPUT = {
  runTerraformLambdaName: "ironforge-dev-run-terraform",
  event: {
    serviceId: "11111111-1111-4111-8111-111111111111",
    jobId: "22222222-2222-4222-8222-222222222222",
    serviceName: "my-site",
  },
};

beforeEach(() => {
  lambdaMock.reset();
});

describe("destroyTerraform", () => {
  it("returns succeeded when the Lambda invocation has no FunctionError", async () => {
    lambdaMock.on(InvokeCommand).resolves({
      StatusCode: 200,
      Payload: payload(JSON.stringify({ live_url: "https://example.com" })),
    });

    const outcome = await destroyTerraform(VALID_INPUT);

    expect(outcome.status).toBe("succeeded");
    if (outcome.status === "succeeded") {
      expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("forwards the SFN event with action=destroy merged in", async () => {
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 200 });

    await destroyTerraform(VALID_INPUT);

    const calls = lambdaMock.commandCalls(InvokeCommand);
    expect(calls).toHaveLength(1);
    const payload = JSON.parse(
      Buffer.from(calls[0]!.args[0].input.Payload as Uint8Array).toString("utf-8"),
    );
    expect(payload).toMatchObject({ ...VALID_INPUT.event, action: "destroy" });
  });

  it("uses RequestResponse invocation (sync, not Event)", async () => {
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 200 });

    await destroyTerraform(VALID_INPUT);

    const calls = lambdaMock.commandCalls(InvokeCommand);
    expect(calls[0]!.args[0].input.InvocationType).toBe("RequestResponse");
  });

  it("returns failed (function-error) when FunctionError is set", async () => {
    lambdaMock.on(InvokeCommand).resolves({
      StatusCode: 200,
      FunctionError: "Unhandled",
      Payload: payload(
        JSON.stringify({ errorType: "Error", errorMessage: "terraform exit 1" }),
      ),
    });

    const outcome = await destroyTerraform(VALID_INPUT);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failureKind).toBe("function-error");
      if (outcome.failureKind === "function-error") {
        expect(outcome.functionError).toBe("Unhandled");
        expect(outcome.payloadPreview).toContain("terraform exit 1");
      }
    }
  });

  it("truncates payloadPreview to 1000 chars on FunctionError", async () => {
    const huge = "x".repeat(2000);
    lambdaMock.on(InvokeCommand).resolves({
      StatusCode: 200,
      FunctionError: "Unhandled",
      Payload: payload(huge),
    });

    const outcome = await destroyTerraform(VALID_INPUT);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed" && outcome.failureKind === "function-error") {
      expect(outcome.payloadPreview.length).toBe(1000);
    }
  });

  it("returns empty payloadPreview when FunctionError is set without Payload", async () => {
    lambdaMock.on(InvokeCommand).resolves({
      StatusCode: 200,
      FunctionError: "Unhandled",
    });

    const outcome = await destroyTerraform(VALID_INPUT);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed" && outcome.failureKind === "function-error") {
      expect(outcome.payloadPreview).toBe("");
    }
  });

  it("returns failed (exception) when the invoke throws", async () => {
    lambdaMock.on(InvokeCommand).rejects(new Error("network unreachable"));

    const outcome = await destroyTerraform(VALID_INPUT);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.failureKind).toBe("exception");
      if (outcome.failureKind === "exception") {
        expect(outcome.error).toBe("network unreachable");
      }
    }
  });

  it("stringifies non-Error throw values", async () => {
    lambdaMock.on(InvokeCommand).rejects("string error");

    const outcome = await destroyTerraform(VALID_INPUT);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed" && outcome.failureKind === "exception") {
      // mockClient wraps non-Error throws into an Error object — confirm
      // we still produce a string error field rather than [object Object].
      expect(typeof outcome.error).toBe("string");
      expect(outcome.error.length).toBeGreaterThan(0);
    }
  });
});
