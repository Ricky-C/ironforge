import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { createCognitoAuth, type AuthEnv, type TokenVerifier } from "./auth.js";

const validPayload = { sub: "user-123" };

const okVerifier: TokenVerifier = {
  verify: async () => validPayload,
};

const throwingVerifier = (message: string): TokenVerifier => ({
  verify: async () => {
    throw new Error(message);
  },
});

const buildApp = (verifier: TokenVerifier) => {
  const app = new Hono<AuthEnv>();
  app.use("/protected", createCognitoAuth(verifier));
  app.get("/protected", (c) => c.json({ ok: true, user: c.get("user") }));
  return app;
};

const callProtected = (verifier: TokenVerifier, headers: Record<string, string> = {}) =>
  buildApp(verifier).request("/protected", { headers });

describe("createCognitoAuth — request gating", () => {
  it("rejects requests with no Authorization header", async () => {
    const res = await callProtected(okVerifier);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: "MISSING_TOKEN", message: "Authentication required" },
    });
  });

  it("rejects non-Bearer schemes", async () => {
    const res = await callProtected(okVerifier, { Authorization: "Basic dXNlcjpwYXNz" });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "MISSING_TOKEN" } });
  });

  it("rejects empty bearer (header present, token missing)", async () => {
    const res = await callProtected(okVerifier, { Authorization: "Bearer " });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "MISSING_TOKEN" } });
  });

  it("accepts the Bearer scheme case-insensitively (RFC 6750)", async () => {
    const res = await callProtected(okVerifier, { Authorization: "bearer abc.def.ghi" });
    expect(res.status).toBe(200);
  });
});

describe("createCognitoAuth — verifier failure modes", () => {
  it("returns INVALID_TOKEN when the verifier rejects the signature", async () => {
    const res = await callProtected(throwingVerifier("JwtInvalidSignatureError"), {
      Authorization: "Bearer tampered.token.value",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: "INVALID_TOKEN", message: "Invalid token" },
    });
  });

  it("returns INVALID_TOKEN when client_id mismatches (env-isolation check)", async () => {
    const res = await callProtected(
      throwingVerifier("JwtInvalidClaimError: client_id does not match expected"),
      { Authorization: "Bearer dev.token.sent.to.prod" },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "INVALID_TOKEN" } });
  });

  it("returns INVALID_TOKEN when token_use mismatches (BFF sent ID instead of access)", async () => {
    const res = await callProtected(
      throwingVerifier("JwtInvalidClaimError: token_use must equal access"),
      { Authorization: "Bearer id.token.value" },
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "INVALID_TOKEN" } });
  });

  it("returns INVALID_TOKEN when the token is expired", async () => {
    const res = await callProtected(throwingVerifier("JwtExpiredError"), {
      Authorization: "Bearer expired.token.value",
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "INVALID_TOKEN" } });
  });
});

describe("createCognitoAuth — claim-shape validation (defense in depth)", () => {
  const callWithPayload = (payload: unknown) =>
    callProtected(
      { verify: async () => payload },
      { Authorization: "Bearer some.valid.token" },
    );

  it("rejects payloads missing sub", async () => {
    const res = await callWithPayload({ token_use: "access", client_id: "abc" });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "INVALID_TOKEN" } });
  });

  it("rejects payloads where sub is a number", async () => {
    const res = await callWithPayload({ sub: 12345 });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "INVALID_TOKEN" } });
  });

  it("rejects payloads where sub is null", async () => {
    const res = await callWithPayload({ sub: null });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "INVALID_TOKEN" } });
  });

  it("rejects payloads where sub is the empty string", async () => {
    const res = await callWithPayload({ sub: "" });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: "INVALID_TOKEN" } });
  });
});

describe("createCognitoAuth — happy path", () => {
  it("attaches verified claims to the Hono context and proceeds to the handler", async () => {
    const res = await callProtected(okVerifier, { Authorization: "Bearer good.token.value" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, user: { sub: "user-123" } });
  });

  it("strips extra claims not in the schema (only sub propagates to handlers)", async () => {
    const verifier: TokenVerifier = {
      verify: async () => ({
        sub: "user-456",
        client_id: "abc",
        token_use: "access",
        scope: "openid email profile",
      }),
    };
    const res = await callProtected(verifier, { Authorization: "Bearer good.token.value" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, user: { sub: "user-456" } });
  });
});
