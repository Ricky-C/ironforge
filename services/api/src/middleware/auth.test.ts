import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { cognitoAuth, type AuthEnv } from "./auth.js";

const buildApp = () => {
  const app = new Hono<AuthEnv>();
  app.use("/protected", cognitoAuth);
  app.get("/protected", (c) => c.json({ ok: true, user: c.get("user") }));
  return app;
};

const eventWithClaims = (claims: unknown): AuthEnv["Bindings"]["event"] =>
  ({
    requestContext: { authorizer: { jwt: { claims } } },
  }) as unknown as AuthEnv["Bindings"]["event"];

const callWithEvent = (event: unknown) =>
  buildApp().request("/protected", {}, { event } as AuthEnv["Bindings"]);

const callWithClaims = (claims: unknown) => callWithEvent(eventWithClaims(claims));

const expectRejected = async (res: Response) => {
  expect(res.status).toBe(401);
  expect(await res.json()).toEqual({
    ok: false,
    error: { code: "INVALID_TOKEN", message: "Invalid token" },
  });
};

describe("cognitoAuth — authorizer-misconfiguration defense", () => {
  it("rejects requests with no authorizer event (route bypassed JWT authorizer)", async () => {
    await expectRejected(await callWithEvent({}));
  });

  it("rejects requests with no claims object on the authorizer payload", async () => {
    await expectRejected(
      await callWithEvent({ requestContext: { authorizer: { jwt: {} } } }),
    );
  });

  it("rejects requests where claims is null", async () => {
    await expectRejected(await callWithClaims(null));
  });
});

describe("cognitoAuth — token_use enforcement (the BFF-misconfiguration check)", () => {
  it("rejects ID tokens (token_use === 'id') even with otherwise-valid claims", async () => {
    await expectRejected(await callWithClaims({ sub: "user-123", token_use: "id" }));
  });

  it("rejects payloads with no token_use claim at all", async () => {
    await expectRejected(await callWithClaims({ sub: "user-123" }));
  });

  it("rejects unknown token_use values (e.g. 'refresh')", async () => {
    await expectRejected(
      await callWithClaims({ sub: "user-123", token_use: "refresh" }),
    );
  });
});

describe("cognitoAuth — claim-shape validation (defense in depth)", () => {
  it("rejects payloads missing sub", async () => {
    await expectRejected(await callWithClaims({ token_use: "access" }));
  });

  it("rejects payloads where sub is a number", async () => {
    await expectRejected(await callWithClaims({ sub: 12345, token_use: "access" }));
  });

  it("rejects payloads where sub is null", async () => {
    await expectRejected(await callWithClaims({ sub: null, token_use: "access" }));
  });

  it("rejects payloads where sub is the empty string", async () => {
    await expectRejected(await callWithClaims({ sub: "", token_use: "access" }));
  });
});

describe("cognitoAuth — happy path", () => {
  it("attaches the verified user to context and proceeds to the handler", async () => {
    const res = await callWithClaims({ sub: "user-123", token_use: "access" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, user: { sub: "user-123" } });
  });

  it("strips claims not in the schema (only sub propagates to handlers)", async () => {
    const res = await callWithClaims({
      sub: "user-456",
      token_use: "access",
      client_id: "abc",
      iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_xxx",
      scope: "openid email profile",
      auth_time: "1735689600",
      exp: "1735693200",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, user: { sub: "user-456" } });
  });
});
