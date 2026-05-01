import type { MiddlewareHandler } from "hono";

import { IronforgeUserSchema, type IronforgeUser } from "./claims.js";

// Hono context env added by this middleware. Downstream handlers do
// `new Hono<AuthEnv>()` to get a typed `c.get("user")`.
export type AuthEnv = {
  Variables: {
    user: IronforgeUser;
  };
};

// Structural interface so tests can pass a fake without instantiating
// CognitoJwtVerifier (which would require a real user pool / JWKS endpoint).
// The signature matches CognitoJwtVerifier#verify.
export type TokenVerifier = {
  verify(token: string): Promise<unknown>;
};

// Case-insensitive `Bearer` scheme (RFC 6750 §2.1), single non-empty token,
// optional trailing whitespace. JWTs never contain spaces, so a single
// `\S+` capture is sufficient.
const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;

const unauthorized = (code: "MISSING_TOKEN" | "INVALID_TOKEN", message: string) => ({
  ok: false as const,
  error: { code, message },
});

// Factory returning a Hono middleware bound to a specific verifier.
// PR #2's handler scaffolding constructs the production verifier from
// env-validated config and assigns the result to a module-scope singleton.
export const createCognitoAuth = (verifier: TokenVerifier): MiddlewareHandler<AuthEnv> => {
  return async (c, next) => {
    const authHeader = c.req.header("authorization") ?? c.req.header("Authorization");
    if (!authHeader) {
      return c.json(unauthorized("MISSING_TOKEN", "Authentication required"), 401);
    }

    const match = BEARER_RE.exec(authHeader);
    if (!match) {
      return c.json(unauthorized("MISSING_TOKEN", "Authentication required"), 401);
    }
    const token = match[1] as string;

    let payload: unknown;
    try {
      payload = await verifier.verify(token);
    } catch {
      // aws-jwt-verify throws on signature mismatch, expired token, wrong
      // client_id, or wrong token_use. All collapse to one client-facing
      // code; structured logging of the cause belongs to the handler
      // scaffolding (PR #2).
      return c.json(unauthorized("INVALID_TOKEN", "Invalid token"), 401);
    }

    const parsed = IronforgeUserSchema.safeParse(payload);
    if (!parsed.success) {
      // Defense in depth: a verified token whose claim shape we don't
      // recognize must not reach handlers. If this fires in production,
      // either the verifier accepted an unexpected payload or the schema
      // drifted out of sync with reality.
      return c.json(unauthorized("INVALID_TOKEN", "Invalid token"), 401);
    }

    c.set("user", parsed.data);
    await next();
    return;
  };
};
