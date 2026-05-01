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
  "NOT_FOUND",
  "INTERNAL",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);

export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string(),
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
