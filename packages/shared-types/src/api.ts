import { z } from "zod";

// Discriminated response envelope. Every API response takes this shape;
// no naked data, no naked errors. Client narrows on `ok`.
//
// Error codes are defined here as the cumulative known set so the
// frontend client can perform exhaustive handling (the discriminated-
// union exhaustiveness pattern — see CLAUDE.md / docs/data-model.md).
// Add new codes here as new failure modes land; never introduce ad-hoc
// codes in handlers.
export const API_ERROR_CODES = [
  "INVALID_TOKEN",
  "INVALID_CURSOR",
  "INVALID_LIMIT",
  "INVALID_REQUEST",
  // POST /api/services-specific codes (PR-C.2). Two-stage validation:
  //   - INVALID_REQUEST  : envelope schema fails (CreateServiceRequestSchema)
  //   - UNKNOWN_TEMPLATE : envelope passed, but templateId not in registry
  //   - INVALID_INPUTS   : envelope passed, template found, but template-
  //                        specific InputsSchema rejected the inputs
  //   - CONFLICT         : envelope passed, validation passed, but a
  //                        Service with the same name already exists
  //                        (createIfNotExists ConditionalCheckFailed)
  "UNKNOWN_TEMPLATE",
  "INVALID_INPUTS",
  "CONFLICT",
  // DELETE /api/services/:id-specific (Phase 1.5):
  //   - SERVICE_IN_FLIGHT : Service is in pending or provisioning. DELETE
  //                         is not available until terminal state. Phase 2
  //                         may add cancellation; for now the user waits.
  "SERVICE_IN_FLIGHT",
  "NOT_FOUND",
  "INTERNAL",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);

// Optional code-specific context fields. Currently only SERVICE_IN_FLIGHT
// populates currentState; other codes leave it absent. Adding code-specific
// fields here (rather than a generic `details: Record<string, unknown>`)
// keeps the API response shape discoverable from the schema — clients that
// switch on `code` can read the relevant fields with full type safety.
//
// Why no currentStep / estimatedRemainingMinutes on SERVICE_IN_FLIGHT yet:
// Job.currentStep is currently set once at kickoff (create-service.ts) and
// not updated by task Lambdas as the workflow progresses, so an in-flight
// rejection would always report `validate-inputs` regardless of actual
// progress. Adding meaningful currentStep tracking is tracked in tech-debt.
export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string(),
  // SERVICE_IN_FLIGHT: the Service's current status (pending | provisioning
  // | deprovisioning) so callers can distinguish "wait" from "already
  // deprovisioning" without re-reading the Service.
  currentState: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export type ApiSuccess<T> = { ok: true; data: T };
export type ApiFailure = { ok: false; error: ApiError };
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

// Schema-builder for the envelope. Use when validating a typed response
// at a boundary, e.g. ApiResponseSchema(ServiceSchema).safeParse(body).
export const ApiResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), data: dataSchema }),
    z.object({ ok: z.literal(false), error: ApiErrorSchema }),
  ]);
