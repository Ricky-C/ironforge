import type { ApiFailure, ApiResponse, Service } from "@ironforge/shared-types";
import { Hono } from "hono";

import type { AuthEnv } from "../middleware/auth.js";

// PR-B.2 stub. PR-B.3 replaces these with real DynamoDB-backed handlers
// that query GSI1 (list) and the base table (detail). The stub returns
// the canonical ApiResponse envelope so the API contract is exercised
// end-to-end (API Gateway authorizer → middleware claims extraction →
// Hono routing → response envelope) before real data wiring lands.
//
// Response shapes here are deliberately identical to PR-B.3's planned
// shapes — particularly the 404 envelope, which must be byte-for-byte
// identical between "service does not exist" and "service exists but
// is not owned by the requesting user" so existence is not leaked. PR-
// B.3 will distinguish only at the DynamoDB-query level, not at the
// response level.

export const servicesRoutes = new Hono<AuthEnv>();

servicesRoutes.get("/", (c) => {
  const body: ApiResponse<{ items: Service[]; cursor: string | null }> = {
    ok: true,
    data: { items: [], cursor: null },
  };
  return c.json(body, 200);
});

servicesRoutes.get("/:id", (c) => {
  const body: ApiFailure = {
    ok: false,
    error: { code: "NOT_FOUND", message: "service not found" },
  };
  return c.json(body, 404);
});
