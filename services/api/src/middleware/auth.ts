import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import type { MiddlewareHandler } from "hono";

import { IronforgeUserSchema, type IronforgeUser } from "./claims.js";

// Hono bindings populated by @hono/aws-lambda. The production handler
// (PR-B) wires the adapter; tests pass `{ event }` via the third arg
// to app.request(...).
export type AuthEnv = {
  Bindings: {
    event: APIGatewayProxyEventV2WithJWTAuthorizer;
  };
  Variables: {
    user: IronforgeUser;
  };
};

const unauthorized = () => ({
  ok: false as const,
  error: { code: "INVALID_TOKEN" as const, message: "Invalid token" },
});

// Claims-extraction middleware. The API Gateway HTTP API JWT authorizer
// has already verified signature, iss, audience (aud or client_id), and
// exp before this Lambda is invoked — see infra/modules/cognito/main.tf
// SECURITY NOTE for the split. This middleware enforces the single
// remaining check (token_use === "access", which the authorizer does
// NOT cover) and shapes the verified claims into a typed user on the
// Hono context.
export const cognitoAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const claims = c.env.event?.requestContext?.authorizer?.jwt?.claims;
  if (!claims || typeof claims !== "object") {
    // Reaching the Lambda without an authorizer-injected claims object
    // means the route bypassed the JWT authorizer entirely (Terraform
    // misconfiguration). Fail closed.
    return c.json(unauthorized(), 401);
  }

  // The HTTP API JWT authorizer accepts ID tokens with matching `aud`
  // alongside access tokens with matching `client_id` — see SECURITY
  // NOTE. This is the one place ID tokens get rejected.
  if ((claims as Record<string, unknown>)["token_use"] !== "access") {
    return c.json(unauthorized(), 401);
  }

  const parsed = IronforgeUserSchema.safeParse(claims);
  if (!parsed.success) {
    // Defense in depth against an authorizer payload whose shape we
    // don't recognize. If this fires, either AWS changed the claim-
    // injection format or IronforgeUserSchema drifted from reality.
    return c.json(unauthorized(), 401);
  }

  c.set("user", parsed.data);
  await next();
  return;
};
