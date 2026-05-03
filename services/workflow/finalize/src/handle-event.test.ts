import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { docClient } from "@ironforge/shared-utils";
import { mockClient } from "aws-sdk-client-mock";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { buildHandler, HandlerInputSchema } from "./handle-event.js";

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

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const SERVICE_ID = "11111111-1111-4111-8111-111111111111";
const LIVE_URL = "https://my-site.ironforge.rickycaballero.com";
const PROVISIONED_AT_MS = new Date("2026-05-03T12:00:00.000Z").getTime();
const PROVISIONED_AT_ISO = "2026-05-03T12:00:00.000Z";

const VALID_INPUT = {
  jobId: JOB_ID,
  serviceId: SERVICE_ID,
  liveUrl: LIVE_URL,
};

// Helper — build the conditional-check-failed exception aws-sdk
// throws on UpdateCommand condition failure. Identical shape to
// what the SDK raises in production.
const conditionFailed = (): Error =>
  new ConditionalCheckFailedException({
    $metadata: {},
    message: "The conditional request failed",
  });

describe("HandlerInputSchema", () => {
  it("accepts the focused {jobId, serviceId, liveUrl} shape", () => {
    expect(HandlerInputSchema.safeParse(VALID_INPUT).success).toBe(true);
  });

  it("rejects non-URL liveUrl", () => {
    expect(
      HandlerInputSchema.safeParse({ ...VALID_INPUT, liveUrl: "not-a-url" })
        .success,
    ).toBe(false);
  });

  it("rejects malformed jobId", () => {
    expect(
      HandlerInputSchema.safeParse({ ...VALID_INPUT, jobId: "not-a-uuid" })
        .success,
    ).toBe(false);
  });
});

describe("finalize — happy path", () => {
  it("transitions Service + Job, returns liveUrl + provisionedAt, writes 4 DDB updates", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const handler = buildHandler({ now: () => PROVISIONED_AT_MS });

    const result = await handler(VALID_INPUT);

    expect(result).toEqual({
      liveUrl: LIVE_URL,
      provisionedAt: PROVISIONED_AT_ISO,
    });

    // 4 UpdateCommand calls: JobStep running, Service transition,
    // Job transition, JobStep succeeded.
    const updateCalls = ddbMock.commandCalls(UpdateCommand);
    expect(updateCalls).toHaveLength(4);

    // Service transition: provisioning → live with companion fields.
    const serviceUpdate = updateCalls[1]!.args[0].input;
    expect(serviceUpdate.ConditionExpression).toBe("#status = :from");
    expect(serviceUpdate.ExpressionAttributeValues?.[":from"]).toBe(
      "provisioning",
    );
    expect(serviceUpdate.ExpressionAttributeValues?.[":to"]).toBe("live");
    // currentJobId, liveUrl, provisionedAt, updatedAt all set in the
    // same UpdateItem.
    const valuesEntries = Object.entries(
      serviceUpdate.ExpressionAttributeValues ?? {},
    );
    expect(valuesEntries.some(([, v]) => v === LIVE_URL)).toBe(true);
    expect(valuesEntries.some(([, v]) => v === null)).toBe(true);

    // Job transition: running → succeeded.
    const jobUpdate = updateCalls[2]!.args[0].input;
    expect(jobUpdate.ExpressionAttributeValues?.[":from"]).toBe("running");
    expect(jobUpdate.ExpressionAttributeValues?.[":to"]).toBe("succeeded");

    // No GetCommand calls on the happy path.
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(0);
  });
});

describe("finalize — Service idempotent retry", () => {
  it("Service conditional fails but state shows our markers → success", async () => {
    // Strategy: 1st update (JobStep running) succeeds. 2nd update
    // (Service transition) throws ConditionalCheckFailed. Then the
    // helper's internal GetItem AND finalize's inspectService both
    // resolve to the already-finalized state. 3rd update (Job
    // transition) succeeds. 4th (JobStep succeeded) succeeds.
    let updateCallIndex = 0;
    ddbMock.on(UpdateCommand).callsFake(async () => {
      const i = updateCallIndex++;
      if (i === 1) throw conditionFailed();
      return {};
    });
    ddbMock.on(GetCommand).resolves({
      Item: {
        status: "live",
        currentJobId: null,
        liveUrl: LIVE_URL,
      },
    });
    const handler = buildHandler({ now: () => PROVISIONED_AT_MS });

    const result = await handler(VALID_INPUT);

    expect(result.liveUrl).toBe(LIVE_URL);
    // 2 GetCommand calls: 1 by transitionStatus's internal lookup, 1
    // by finalize's inspectService.
    expect(ddbMock.commandCalls(GetCommand)).toHaveLength(2);
  });

  it("Service conditional fails and currentJobId is someone else's → IronforgeFinalizeError with context", async () => {
    let updateCallIndex = 0;
    ddbMock.on(UpdateCommand).callsFake(async () => {
      const i = updateCallIndex++;
      if (i === 1) throw conditionFailed();
      return {};
    });
    ddbMock.on(GetCommand).resolves({
      Item: {
        status: "live",
        currentJobId: "99999999-9999-4999-8999-999999999999",
        liveUrl: LIVE_URL,
      },
    });
    const handler = buildHandler({ now: () => PROVISIONED_AT_MS });

    await expect(handler(VALID_INPUT)).rejects.toMatchObject({
      name: "IronforgeFinalizeError",
      context: {
        serviceId: SERVICE_ID,
        jobId: JOB_ID,
        expectedStatus: "live",
        actualStatus: "live",
        actualCurrentJobId: "99999999-9999-4999-8999-999999999999",
      },
    });
  });

  it("Service conditional fails and liveUrl differs from ours → IronforgeFinalizeError with both URLs in context", async () => {
    const someoneElsesUrl = "https://other-site.ironforge.rickycaballero.com";
    let updateCallIndex = 0;
    ddbMock.on(UpdateCommand).callsFake(async () => {
      const i = updateCallIndex++;
      if (i === 1) throw conditionFailed();
      return {};
    });
    ddbMock.on(GetCommand).resolves({
      Item: {
        status: "live",
        currentJobId: null,
        liveUrl: someoneElsesUrl,
      },
    });
    const handler = buildHandler({ now: () => PROVISIONED_AT_MS });

    await expect(handler(VALID_INPUT)).rejects.toMatchObject({
      name: "IronforgeFinalizeError",
      context: {
        expectedLiveUrl: LIVE_URL,
        actualLiveUrl: someoneElsesUrl,
      },
    });
  });

  it("Service conditional fails and status is failed (cleanup ran first) → IronforgeFinalizeError with actualStatus=failed", async () => {
    let updateCallIndex = 0;
    ddbMock.on(UpdateCommand).callsFake(async () => {
      const i = updateCallIndex++;
      if (i === 1) throw conditionFailed();
      return {};
    });
    ddbMock.on(GetCommand).resolves({
      Item: {
        status: "failed",
        currentJobId: null,
        liveUrl: null,
      },
    });
    const handler = buildHandler({ now: () => PROVISIONED_AT_MS });

    await expect(handler(VALID_INPUT)).rejects.toMatchObject({
      name: "IronforgeFinalizeError",
      context: { actualStatus: "failed" },
    });
  });
});

describe("finalize — Job idempotent retry", () => {
  it("Job conditional fails but Job is already succeeded → success", async () => {
    // 1st (running), 2nd (Service) succeed. 3rd (Job) throws
    // conditional-failed. inspectJob shows status=succeeded.
    // 4th (JobStep succeeded) succeeds.
    let updateCallIndex = 0;
    ddbMock.on(UpdateCommand).callsFake(async () => {
      const i = updateCallIndex++;
      if (i === 2) throw conditionFailed();
      return {};
    });
    ddbMock.on(GetCommand).resolves({
      Item: { status: "succeeded" },
    });
    const handler = buildHandler({ now: () => PROVISIONED_AT_MS });

    const result = await handler(VALID_INPUT);

    expect(result.liveUrl).toBe(LIVE_URL);
  });

  it("Job conditional fails and Job is in cancelled state → IronforgeFinalizeError", async () => {
    let updateCallIndex = 0;
    ddbMock.on(UpdateCommand).callsFake(async () => {
      const i = updateCallIndex++;
      if (i === 2) throw conditionFailed();
      return {};
    });
    ddbMock.on(GetCommand).resolves({
      Item: { status: "cancelled" },
    });
    const handler = buildHandler({ now: () => PROVISIONED_AT_MS });

    await expect(handler(VALID_INPUT)).rejects.toMatchObject({
      name: "IronforgeFinalizeError",
      context: {
        expectedStatus: "succeeded",
        actualStatus: "cancelled",
      },
    });
  });
});

describe("finalize — error paths", () => {
  it("rejects malformed input WITHOUT writing to DDB", async () => {
    ddbMock.on(UpdateCommand).resolves({});
    const handler = buildHandler({ now: () => PROVISIONED_AT_MS });

    await expect(
      handler({ jobId: "not-a-uuid", serviceId: SERVICE_ID, liveUrl: LIVE_URL }),
    ).rejects.toThrow(/schema validation/);

    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
