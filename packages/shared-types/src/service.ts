import { z } from "zod";

// Service.name is the subdomain (e.g. <name>.ironforge.rickycaballero.com)
// and is baked into ACM cert SANs, Route53 records, the GitHub repo name,
// and CI/CD configs. It is IMMUTABLE post-creation. Renames go through
// deprovisioning + reprovisioning, not via PATCH. The API does not expose
// a name-mutation endpoint. See docs/data-model.md § Immutability.
//
// Validation: 3-63 chars, lowercase alphanumeric + hyphens, cannot start
// or end with hyphen. Matches DNS-label rules for the subdomain use.
const SERVICE_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export const ServiceNameSchema = z
  .string()
  .min(3, "service name must be at least 3 characters")
  .max(63, "service name must be at most 63 characters")
  .regex(
    SERVICE_NAME_PATTERN,
    "service name must be lowercase alphanumeric with optional hyphens, not starting or ending with hyphen",
  );

// Cognito sub is a UUID v4 string per Cognito User Pool defaults. Used as
// the canonical owner identifier; populated from
// event.requestContext.authorizer.jwt.claims.sub. See
// services/api/src/middleware/claims.ts.
const CognitoSubSchema = z.string().uuid();

// ISO 8601 UTC with milliseconds, e.g. "2026-04-30T15:20:34.567Z".
// Millisecond precision is the GSI1SK timestamp portion; combined with
// the UUID id suffix it is collision-safe at Phase 1 user-driven rates.
// Bulk-create paths should revisit (Snowflake-like IDs become useful).
const IsoTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    "must be ISO 8601 UTC with milliseconds (e.g. 2026-04-30T15:20:34.567Z)",
  );

// inputs is opaque at the Service level. Per-template input schemas
// (e.g. StaticSiteInputsSchema) live in src/templates/<template-name>.ts
// and are consumed by wizard forms, the validate-inputs Lambda, and
// the template-renderer. The Service entity stays stable as templates
// evolve. See docs/data-model.md § Inputs boundary.
const ServiceInputsSchema = z.record(z.string(), z.unknown());

// Common fields across all Service status variants. Variants extend this
// with the literal `status` discriminator and any state-specific fields.
const ServiceBaseSchema = z.object({
  id: z.string().uuid(),
  name: ServiceNameSchema,
  ownerId: CognitoSubSchema,
  templateId: z.string().min(1),
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  inputs: ServiceInputsSchema,
});

// State-specific fields are populated by the provisioning workflow;
// they appear in the schema so handlers and clients can render full
// state correctly. The schema describes the canonical shape; code paths
// populate it.
export const ServicePendingSchema = ServiceBaseSchema.extend({
  status: z.literal("pending"),
});

export const ServiceProvisioningSchema = ServiceBaseSchema.extend({
  status: z.literal("provisioning"),
  jobId: z.string().uuid(),
});

export const ServiceLiveSchema = ServiceBaseSchema.extend({
  status: z.literal("live"),
  liveUrl: z.string().url(),
  provisionedAt: IsoTimestampSchema,
});

export const ServiceFailedSchema = ServiceBaseSchema.extend({
  status: z.literal("failed"),
  failureReason: z.string().min(1),
  failedAt: IsoTimestampSchema,
});

export const ServiceArchivedSchema = ServiceBaseSchema.extend({
  status: z.literal("archived"),
  archivedAt: IsoTimestampSchema,
});

export const ServiceSchema = z.discriminatedUnion("status", [
  ServicePendingSchema,
  ServiceProvisioningSchema,
  ServiceLiveSchema,
  ServiceFailedSchema,
  ServiceArchivedSchema,
]);
export type Service = z.infer<typeof ServiceSchema>;

export const SERVICE_STATUSES = [
  "pending",
  "provisioning",
  "live",
  "failed",
  "archived",
] as const;
export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

// DynamoDB single-table key shape for Service items. The runtime parsing
// flow strips these keys and validates the remainder against
// ServiceSchema; this type documents the wire shape.
export type ServiceItemKeys = {
  PK: `SERVICE#${string}`;
  SK: "META";
  GSI1PK: `OWNER#${string}`;
  GSI1SK: `SERVICE#${string}`;
};
export type ServiceItem = Service & ServiceItemKeys;

// Key construction helpers. Do not construct keys ad-hoc in handlers —
// always go through these so the GSI1 sharing convention
// (docs/data-model.md § GSI1 sharing convention) is enforced in one
// place. Same applies to other entities once they land.
export const buildServicePK = (id: string): `SERVICE#${string}` => `SERVICE#${id}`;
export const SERVICE_SK_META = "META" as const;
export const buildServiceGSI1PK = (ownerId: string): `OWNER#${string}` => `OWNER#${ownerId}`;
export const buildServiceGSI1SK = (
  createdAt: string,
  id: string,
): `SERVICE#${string}` => `SERVICE#${createdAt}#${id}`;

export const buildServiceKeys = (service: {
  id: string;
  ownerId: string;
  createdAt: string;
}): ServiceItemKeys => ({
  PK: buildServicePK(service.id),
  SK: SERVICE_SK_META,
  GSI1PK: buildServiceGSI1PK(service.ownerId),
  GSI1SK: buildServiceGSI1SK(service.createdAt, service.id),
});
