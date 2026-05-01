import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { docClient } from "../aws/clients.js";

import { createIfNotExists } from "./conditional-write.js";

const ddbMock = mockClient(docClient);

const conditionalCheckFailed = (): ConditionalCheckFailedException =>
  new ConditionalCheckFailedException({
    $metadata: {},
    message: "ConditionalCheckFailedException",
  });

beforeEach(() => {
  ddbMock.reset();
});

describe("createIfNotExists", () => {
  const item = {
    PK: "JOB#abc",
    SK: "META",
    id: "abc",
    status: "queued",
  };

  it("returns created=true when the conditional Put succeeds", async () => {
    ddbMock.on(PutCommand).resolves({});

    const result = await createIfNotExists({
      tableName: "ironforge-test",
      item,
    });

    expect(result).toEqual({ created: true, item });
    const calls = ddbMock.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.ConditionExpression).toBe(
      "attribute_not_exists(#pk)",
    );
    expect(calls[0]!.args[0].input.ExpressionAttributeNames).toEqual({
      "#pk": "PK",
    });
  });

  it("returns created=false with the existing item when conditional fails", async () => {
    const existing = { PK: "JOB#abc", SK: "META", id: "abc", status: "running" };
    ddbMock.on(PutCommand).rejects(conditionalCheckFailed());
    ddbMock.on(GetCommand).resolves({ Item: existing });

    const result = await createIfNotExists({
      tableName: "ironforge-test",
      item,
    });

    expect(result).toEqual({ created: false, existing });
    const getCalls = ddbMock.commandCalls(GetCommand);
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0]!.args[0].input.Key).toEqual({
      PK: "JOB#abc",
      SK: "META",
    });
  });

  it("throws when conditional fails AND the follow-up Get returns no item", async () => {
    ddbMock.on(PutCommand).rejects(conditionalCheckFailed());
    ddbMock.on(GetCommand).resolves({});

    await expect(
      createIfNotExists({ tableName: "ironforge-test", item }),
    ).rejects.toThrowError(/item not found on follow-up Get/);
  });

  it("rethrows non-ConditionalCheckFailed errors verbatim", async () => {
    const transient = new Error("ProvisionedThroughputExceeded");
    ddbMock.on(PutCommand).rejects(transient);

    await expect(
      createIfNotExists({ tableName: "ironforge-test", item }),
    ).rejects.toBe(transient);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });
});
