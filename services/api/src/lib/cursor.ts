import { ServiceListCursorSchema, type ServiceListCursor } from "@ironforge/shared-types";

// Cursor wire format: base64url-encoded JSON. base64url is URL-safe and
// pad-less — important because cursors travel as `?cursor=<value>` query
// params. Standard base64 would require additional URL encoding for `+`,
// `/`, and `=` and would be ugly in URLs.
//
// Decode pipeline (per docs/data-model.md § Cursor shape):
//   1. base64url → JSON string. Failure → null.
//   2. JSON.parse → unknown. Failure → null.
//   3. ServiceListCursorSchema.safeParse → typed cursor. Failure → null.
//
// Handler maps null → 400 INVALID_CURSOR. Never pass arbitrary client
// data into DynamoDB — only return a cursor that has matched the schema.

export const encodeServiceListCursor = (cursor: ServiceListCursor): string =>
  Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

export const decodeServiceListCursor = (encoded: string): ServiceListCursor | null => {
  let json: string;
  try {
    json = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  const result = ServiceListCursorSchema.safeParse(parsed);
  return result.success ? result.data : null;
};
