import { z } from "zod";

// Cursor wire format: base64url-encoded JSON. The encode/decode pipeline
// is server-side only (clients pass cursors through opaquely):
//
//   1. base64url decode → JSON string
//   2. JSON.parse → unknown
//   3. ServiceListCursorSchema.safeParse → ServiceListCursor
//
// Stages 1 and 2 live with the API handler (services/api/src/lib/cursor.ts);
// the Zod schema below is stage 3. Any failure across the three stages
// returns 400 INVALID_CURSOR. Never pass arbitrary client data into
// DynamoDB — only return a cursor that has matched the schema.
//
// Other lists (jobs by service, etc.) will get their own cursor schemas
// matching their GSI's LastEvaluatedKey shape — do not generalize this
// schema; let each access pattern document its own cursor.
export const ServiceListCursorSchema = z.object({
  PK: z.string().regex(/^SERVICE#/, "PK must start with SERVICE#"),
  SK: z.literal("META"),
  GSI1PK: z.string().regex(/^OWNER#/, "GSI1PK must start with OWNER#"),
  GSI1SK: z.string().regex(/^SERVICE#/, "GSI1SK must start with SERVICE#"),
});
export type ServiceListCursor = z.infer<typeof ServiceListCursorSchema>;
