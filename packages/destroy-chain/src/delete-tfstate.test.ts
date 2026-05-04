import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { buildTfstateKey, deleteTfstate } from "./delete-tfstate.js";

const s3Mock = mockClient(S3Client);

const VALID_INPUT = {
  tfstateBucket: "ironforge-dev-tfstate",
  serviceId: "11111111-1111-4111-8111-111111111111",
};

beforeEach(() => {
  s3Mock.reset();
});

describe("buildTfstateKey", () => {
  it("formats as services/<id>/terraform.tfstate", () => {
    expect(buildTfstateKey("abc-123")).toBe("services/abc-123/terraform.tfstate");
  });
});

describe("deleteTfstate", () => {
  it("returns succeeded (deleted) on a normal delete", async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});

    const outcome = await deleteTfstate(VALID_INPUT);

    expect(outcome.status).toBe("succeeded");
    if (outcome.status === "succeeded") {
      expect(outcome.detail).toBe("deleted");
    }
  });

  it("targets the correct bucket and key", async () => {
    s3Mock.on(DeleteObjectCommand).resolves({});

    await deleteTfstate(VALID_INPUT);

    const calls = s3Mock.commandCalls(DeleteObjectCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.Bucket).toBe(VALID_INPUT.tfstateBucket);
    expect(calls[0]!.args[0].input.Key).toBe(
      `services/${VALID_INPUT.serviceId}/terraform.tfstate`,
    );
  });

  it("treats NoSuchKey as succeeded (already-absent)", async () => {
    const err = new Error("The specified key does not exist.");
    err.name = "NoSuchKey";
    s3Mock.on(DeleteObjectCommand).rejects(err);

    const outcome = await deleteTfstate(VALID_INPUT);

    expect(outcome.status).toBe("succeeded");
    if (outcome.status === "succeeded") {
      expect(outcome.detail).toBe("already-absent");
    }
  });

  it("returns failed on other S3 errors", async () => {
    const err = new Error("Access denied to bucket");
    err.name = "AccessDenied";
    s3Mock.on(DeleteObjectCommand).rejects(err);

    const outcome = await deleteTfstate(VALID_INPUT);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("Access denied to bucket");
    }
  });
});
