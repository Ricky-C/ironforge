import { describe, expect, it } from "vitest";

import {
  buildServiceGSI1PK,
  buildServiceGSI1SK,
  buildServiceKeys,
  buildServicePK,
  ServiceArchivedSchema,
  ServiceFailedSchema,
  ServiceLiveSchema,
  ServiceNameSchema,
  ServicePendingSchema,
  ServiceProvisioningSchema,
  ServiceSchema,
  SERVICE_SK_META,
  SERVICE_STATUSES,
} from "./service.js";

const VALID_SUB = "11111111-1111-4111-8111-111111111111";
const VALID_ID = "22222222-2222-4222-8222-222222222222";
const VALID_JOB_ID = "33333333-3333-4333-8333-333333333333";
const VALID_TIMESTAMP = "2026-04-30T15:20:34.567Z";

const baseFields = {
  id: VALID_ID,
  name: "my-site",
  ownerId: VALID_SUB,
  templateId: "static-site",
  createdAt: VALID_TIMESTAMP,
  updatedAt: VALID_TIMESTAMP,
  inputs: {},
};

describe("ServiceNameSchema", () => {
  it.each([
    "abc",
    "a-b-c",
    "my-site",
    "service123",
    "a".repeat(63),
    "a1b2c3",
  ])("accepts %s", (name) => {
    expect(ServiceNameSchema.safeParse(name).success).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["ab", "below min length"],
    ["a".repeat(64), "above max length"],
    ["UPPER", "uppercase"],
    ["My-Site", "mixed case"],
    ["-leading-hyphen", "leading hyphen"],
    ["trailing-hyphen-", "trailing hyphen"],
    ["under_score", "underscore"],
    ["dot.in.name", "dot"],
    ["space in name", "space"],
  ])("rejects %s (%s)", (name) => {
    expect(ServiceNameSchema.safeParse(name).success).toBe(false);
  });
});

describe("ServiceSchema variants", () => {
  it("parses pending", () => {
    const result = ServicePendingSchema.safeParse({ ...baseFields, status: "pending" });
    expect(result.success).toBe(true);
  });

  it("parses provisioning with jobId", () => {
    const result = ServiceProvisioningSchema.safeParse({
      ...baseFields,
      status: "provisioning",
      jobId: VALID_JOB_ID,
    });
    expect(result.success).toBe(true);
  });

  it("rejects provisioning without jobId", () => {
    const result = ServiceProvisioningSchema.safeParse({
      ...baseFields,
      status: "provisioning",
    });
    expect(result.success).toBe(false);
  });

  it("parses live with liveUrl and provisionedAt", () => {
    const result = ServiceLiveSchema.safeParse({
      ...baseFields,
      status: "live",
      liveUrl: "https://my-site.ironforge.rickycaballero.com",
      provisionedAt: VALID_TIMESTAMP,
    });
    expect(result.success).toBe(true);
  });

  it("rejects live without liveUrl", () => {
    const result = ServiceLiveSchema.safeParse({
      ...baseFields,
      status: "live",
      provisionedAt: VALID_TIMESTAMP,
    });
    expect(result.success).toBe(false);
  });

  it("rejects live with malformed liveUrl", () => {
    const result = ServiceLiveSchema.safeParse({
      ...baseFields,
      status: "live",
      liveUrl: "not a url",
      provisionedAt: VALID_TIMESTAMP,
    });
    expect(result.success).toBe(false);
  });

  it("parses failed with failureReason and failedAt", () => {
    const result = ServiceFailedSchema.safeParse({
      ...baseFields,
      status: "failed",
      failureReason: "ACM cert validation timeout",
      failedAt: VALID_TIMESTAMP,
    });
    expect(result.success).toBe(true);
  });

  it("parses archived with archivedAt", () => {
    const result = ServiceArchivedSchema.safeParse({
      ...baseFields,
      status: "archived",
      archivedAt: VALID_TIMESTAMP,
    });
    expect(result.success).toBe(true);
  });

  it("discriminated union dispatches on status", () => {
    const result = ServiceSchema.safeParse({
      ...baseFields,
      status: "live",
      liveUrl: "https://my-site.example.com",
      provisionedAt: VALID_TIMESTAMP,
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown status", () => {
    const result = ServiceSchema.safeParse({ ...baseFields, status: "ghost" });
    expect(result.success).toBe(false);
  });

  it("rejects malformed timestamp (no millis)", () => {
    const result = ServicePendingSchema.safeParse({
      ...baseFields,
      createdAt: "2026-04-30T15:20:34Z",
      status: "pending",
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed ownerId (not uuid)", () => {
    const result = ServicePendingSchema.safeParse({
      ...baseFields,
      ownerId: "not-a-uuid",
      status: "pending",
    });
    expect(result.success).toBe(false);
  });

  it("SERVICE_STATUSES enumerates all variant statuses", () => {
    expect([...SERVICE_STATUSES].sort()).toEqual(
      ["archived", "failed", "live", "pending", "provisioning"].sort(),
    );
  });
});

describe("key construction helpers", () => {
  it("buildServicePK formats SERVICE#<id>", () => {
    expect(buildServicePK(VALID_ID)).toBe(`SERVICE#${VALID_ID}`);
  });

  it("buildServiceGSI1PK formats OWNER#<sub>", () => {
    expect(buildServiceGSI1PK(VALID_SUB)).toBe(`OWNER#${VALID_SUB}`);
  });

  it("buildServiceGSI1SK formats SERVICE#<timestamp>#<id>", () => {
    expect(buildServiceGSI1SK(VALID_TIMESTAMP, VALID_ID)).toBe(
      `SERVICE#${VALID_TIMESTAMP}#${VALID_ID}`,
    );
  });

  it("buildServiceKeys produces the full key set", () => {
    const keys = buildServiceKeys({
      id: VALID_ID,
      ownerId: VALID_SUB,
      createdAt: VALID_TIMESTAMP,
    });
    expect(keys).toEqual({
      PK: `SERVICE#${VALID_ID}`,
      SK: SERVICE_SK_META,
      GSI1PK: `OWNER#${VALID_SUB}`,
      GSI1SK: `SERVICE#${VALID_TIMESTAMP}#${VALID_ID}`,
    });
  });

  it("buildServiceKeys SK is the META literal", () => {
    const keys = buildServiceKeys({
      id: VALID_ID,
      ownerId: VALID_SUB,
      createdAt: VALID_TIMESTAMP,
    });
    expect(keys.SK).toBe("META");
  });
});
