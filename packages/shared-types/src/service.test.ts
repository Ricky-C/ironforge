import { describe, expect, it } from "vitest";

import {
  buildServiceGSI1PK,
  buildServiceGSI1SK,
  buildServiceKeys,
  buildServicePK,
  CreateServiceRequestSchema,
  ServiceArchivedSchema,
  ServiceDeprovisioningSchema,
  ServiceFailedSchema,
  ServiceLiveSchema,
  ServiceNameSchema,
  ServicePendingSchema,
  ServiceProvisioningSchema,
  ServiceSchema,
  SERVICE_SK_META,
  SERVICE_STATUSES,
  TemplateIdSchema,
  TEMPLATE_IDS,
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
  currentJobId: null,
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

  it("parses provisioning-failed with failedWorkflow=provisioning", () => {
    const result = ServiceFailedSchema.safeParse({
      ...baseFields,
      status: "failed",
      failureReason: "ACM cert validation timeout",
      failedAt: VALID_TIMESTAMP,
      failedWorkflow: "provisioning",
    });
    expect(result.success).toBe(true);
  });

  it("parses deprovisioning-failed with failedWorkflow=deprovisioning", () => {
    const result = ServiceFailedSchema.safeParse({
      ...baseFields,
      status: "failed",
      failureReason: "terraform destroy timed out",
      failedAt: VALID_TIMESTAMP,
      failedWorkflow: "deprovisioning",
    });
    expect(result.success).toBe(true);
  });

  it("rejects failed without failedWorkflow", () => {
    const result = ServiceFailedSchema.safeParse({
      ...baseFields,
      status: "failed",
      failureReason: "anything",
      failedAt: VALID_TIMESTAMP,
    });
    expect(result.success).toBe(false);
  });

  it("rejects failed with unknown failedWorkflow value", () => {
    const result = ServiceFailedSchema.safeParse({
      ...baseFields,
      status: "failed",
      failureReason: "anything",
      failedAt: VALID_TIMESTAMP,
      failedWorkflow: "rollback",
    });
    expect(result.success).toBe(false);
  });

  it("parses deprovisioning with jobId", () => {
    const result = ServiceDeprovisioningSchema.safeParse({
      ...baseFields,
      status: "deprovisioning",
      jobId: VALID_JOB_ID,
    });
    expect(result.success).toBe(true);
  });

  it("rejects deprovisioning without jobId", () => {
    const result = ServiceDeprovisioningSchema.safeParse({
      ...baseFields,
      status: "deprovisioning",
    });
    expect(result.success).toBe(false);
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

  it("accepts currentJobId as a uuid (provisioning state)", () => {
    const result = ServiceProvisioningSchema.safeParse({
      ...baseFields,
      status: "provisioning",
      jobId: VALID_JOB_ID,
      currentJobId: VALID_JOB_ID,
    });
    expect(result.success).toBe(true);
  });

  it("rejects currentJobId when missing entirely (must be present + null in non-provisioning)", () => {
    const { currentJobId: _omitted, ...withoutCurrentJobId } = baseFields;
    const result = ServicePendingSchema.safeParse({
      ...withoutCurrentJobId,
      status: "pending",
    });
    expect(result.success).toBe(false);
  });

  it("rejects currentJobId when not a uuid", () => {
    const result = ServicePendingSchema.safeParse({
      ...baseFields,
      currentJobId: "not-a-uuid",
      status: "pending",
    });
    expect(result.success).toBe(false);
  });

  it("SERVICE_STATUSES enumerates all variant statuses", () => {
    expect([...SERVICE_STATUSES].sort()).toEqual(
      ["archived", "deprovisioning", "failed", "live", "pending", "provisioning"].sort(),
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

describe("TemplateIdSchema", () => {
  it.each(TEMPLATE_IDS)("accepts %s", (id) => {
    expect(TemplateIdSchema.safeParse(id).success).toBe(true);
  });

  it("rejects unknown template id", () => {
    expect(TemplateIdSchema.safeParse("static-site-nextjs").success).toBe(false);
  });
});

describe("CreateServiceRequestSchema", () => {
  const validRequest = {
    name: "my-site",
    templateId: "static-site",
    inputs: {},
  };

  it("accepts a well-formed request", () => {
    expect(CreateServiceRequestSchema.safeParse(validRequest).success).toBe(true);
  });

  it("accepts non-empty inputs (per-template schemas validate the shape)", () => {
    expect(
      CreateServiceRequestSchema.safeParse({
        ...validRequest,
        inputs: { framework: "next" },
      }).success,
    ).toBe(true);
  });

  it("rejects when name is invalid (uppercase)", () => {
    expect(
      CreateServiceRequestSchema.safeParse({ ...validRequest, name: "MySite" }).success,
    ).toBe(false);
  });

  it("rejects when name is too short", () => {
    expect(
      CreateServiceRequestSchema.safeParse({ ...validRequest, name: "ab" }).success,
    ).toBe(false);
  });

  it("rejects when templateId is unknown (UNKNOWN_TEMPLATE territory)", () => {
    expect(
      CreateServiceRequestSchema.safeParse({
        ...validRequest,
        templateId: "static-site-nextjs",
      }).success,
    ).toBe(false);
  });

  it("rejects when inputs is not an object", () => {
    expect(
      CreateServiceRequestSchema.safeParse({ ...validRequest, inputs: "string" }).success,
    ).toBe(false);
  });

  it("rejects when inputs is missing", () => {
    const { inputs: _omit, ...withoutInputs } = validRequest;
    expect(CreateServiceRequestSchema.safeParse(withoutInputs).success).toBe(false);
  });
});
