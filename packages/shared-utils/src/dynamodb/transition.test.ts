import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { docClient } from "../aws/clients.js";

import { transitionStatus } from "./transition.js";

const ddbMock = mockClient(docClient);

const conditionalCheckFailed = (): ConditionalCheckFailedException =>
  new ConditionalCheckFailedException({
    $metadata: {},
    message: "ConditionalCheckFailedException",
  });

beforeEach(() => {
  ddbMock.reset();
});

describe("transitionStatus", () => {
  const key = { PK: "SERVICE#abc", SK: "META" };

  it("returns transitioned=true when the conditional Update succeeds", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const result = await transitionStatus({
      tableName: "ironforge-test",
      key,
      fromStatus: "pending",
      toStatus: "provisioning",
    });

    expect(result).toEqual({ transitioned: true });
    const calls = ddbMock.commandCalls(UpdateCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input;
    expect(input.ConditionExpression).toBe("#status = :from");
    expect(input.UpdateExpression).toBe("SET #status = :to");
    expect(input.ExpressionAttributeNames).toEqual({ "#status": "status" });
    expect(input.ExpressionAttributeValues).toEqual({
      ":from": "pending",
      ":to": "provisioning",
    });
  });

  it("includes additionalUpdates in the SET expression", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await transitionStatus({
      tableName: "ironforge-test",
      key,
      fromStatus: "pending",
      toStatus: "provisioning",
      additionalUpdates: {
        currentJobId: "job-123",
        updatedAt: "2026-04-30T00:00:00.000Z",
      },
    });

    const input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.UpdateExpression).toBe(
      "SET #status = :to, #u0 = :u0, #u1 = :u1",
    );
    expect(input.ExpressionAttributeNames).toEqual({
      "#status": "status",
      "#u0": "currentJobId",
      "#u1": "updatedAt",
    });
    expect(input.ExpressionAttributeValues).toEqual({
      ":from": "pending",
      ":to": "provisioning",
      ":u0": "job-123",
      ":u1": "2026-04-30T00:00:00.000Z",
    });
  });

  it("respects a custom statusAttributeName", async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await transitionStatus({
      tableName: "ironforge-test",
      key,
      fromStatus: "running",
      toStatus: "succeeded",
      statusAttributeName: "state",
    });

    const input = ddbMock.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.ExpressionAttributeNames).toEqual({ "#status": "state" });
  });

  it("on conditional fail, returns the actual current status from a follow-up Get", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailed());
    ddbMock.on(GetCommand).resolves({ Item: { ...key, status: "provisioning" } });

    const result = await transitionStatus({
      tableName: "ironforge-test",
      key,
      fromStatus: "pending",
      toStatus: "provisioning",
    });

    expect(result).toEqual({ transitioned: false, currentStatus: "provisioning" });
  });

  it("on conditional fail with no item present, returns currentStatus=null", async () => {
    ddbMock.on(UpdateCommand).rejects(conditionalCheckFailed());
    ddbMock.on(GetCommand).resolves({});

    const result = await transitionStatus({
      tableName: "ironforge-test",
      key,
      fromStatus: "pending",
      toStatus: "provisioning",
    });

    expect(result).toEqual({ transitioned: false, currentStatus: null });
  });

  it("rethrows non-ConditionalCheckFailed errors verbatim", async () => {
    const transient = new Error("ProvisionedThroughputExceeded");
    ddbMock.on(UpdateCommand).rejects(transient);

    await expect(
      transitionStatus({
        tableName: "ironforge-test",
        key,
        fromStatus: "pending",
        toStatus: "provisioning",
      }),
    ).rejects.toBe(transient);
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });
});
