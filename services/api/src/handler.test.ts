import { describe, expect, it } from "vitest";

import { createApp } from "./handler.js";
import type { AuthEnv } from "./middleware/auth.js";

const VALID_SUB = "11111111-1111-4111-8111-111111111111";

const eventWithClaims = (claims: unknown): AuthEnv["Bindings"]["event"] =>
  ({
    requestContext: { authorizer: { jwt: { claims } } },
  }) as unknown as AuthEnv["Bindings"]["event"];

const accessTokenClaims = (overrides: Record<string, unknown> = {}) => ({
  sub: VALID_SUB,
  token_use: "access",
  ...overrides,
});

const callPath = (path: string, claims: unknown) =>
  createApp().request(path, {}, {
    event: eventWithClaims(claims),
  } as AuthEnv["Bindings"]);

describe("GET /api/services — list", () => {
  it("returns 200 with empty list envelope under valid auth (PR-B.2 stub)", async () => {
    const res = await callPath("/api/services", accessTokenClaims());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      data: { items: [], cursor: null },
    });
  });

  it("rejects unauthenticated requests with 401", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/services",
      {},
      { event: {} } as AuthEnv["Bindings"],
    );
    expect(res.status).toBe(401);
  });

  it("rejects ID-token requests with 401 (BFF-misconfiguration defense)", async () => {
    const res = await callPath(
      "/api/services",
      accessTokenClaims({ token_use: "id" }),
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /api/services/:id — detail", () => {
  it("returns 404 with NOT_FOUND envelope under valid auth (PR-B.2 stub)", async () => {
    const res = await callPath(
      "/api/services/22222222-2222-4222-8222-222222222222",
      accessTokenClaims(),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "service not found" },
    });
  });

  it("returns the same NOT_FOUND envelope shape regardless of id", async () => {
    // PR-B.3 must keep this shape identical between "service does not
    // exist" and "service exists but not owned by the requesting user"
    // — do not leak existence. The PR-B.2 stub returns this shape for
    // ALL detail requests; the test pins the shape so PR-B.3 cannot
    // accidentally diverge.
    const ids = [
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
      "abc",
    ];
    for (const id of ids) {
      const res = await callPath(`/api/services/${id}`, accessTokenClaims());
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        ok: false,
        error: { code: "NOT_FOUND", message: "service not found" },
      });
    }
  });

  it("rejects unauthenticated detail requests with 401 (no path-leak via 404)", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/services/anything",
      {},
      { event: {} } as AuthEnv["Bindings"],
    );
    // Must be 401, not 404. Returning 404 for unauthenticated requests
    // would leak which paths exist via the 404/401 boundary.
    expect(res.status).toBe(401);
  });
});

describe("unknown /api/* routes", () => {
  it("authenticated request to an unregistered /api/ path returns 404", async () => {
    const res = await callPath("/api/nope", accessTokenClaims());
    expect(res.status).toBe(404);
  });

  it("unauthenticated request to an unregistered /api/ path returns 401, not 404", async () => {
    // Path-existence non-leak: the auth middleware fires before route
    // matching, so unauthenticated requests to unregistered paths see
    // the same 401 as unauthenticated requests to registered paths.
    const app = createApp();
    const res = await app.request(
      "/api/nope",
      {},
      { event: {} } as AuthEnv["Bindings"],
    );
    expect(res.status).toBe(401);
  });
});
