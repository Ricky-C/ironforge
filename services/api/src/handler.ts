import { Hono, type MiddlewareHandler } from "hono";
import { handle } from "hono/aws-lambda";

import type { AppEnv } from "./env.js";
import { cognitoAuth } from "./middleware/auth.js";
import { loggerMiddleware } from "./middleware/logger.js";
import { demoRoutes } from "./routes/demo.js";
import { servicesRoutes } from "./routes/services.js";

// Factored out for testability — tests construct a fresh app and use
// Hono's app.request() to drive routes without going through Lambda's
// handle() adapter. Production code uses the exported `handler`.
export const createApp = (): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();

  // Logger middleware applied first — across all paths, before auth —
  // so 401s and unmatched-route 404s also carry the requestId for log
  // correlation against the API Gateway access log.
  app.use("*", loggerMiddleware);

  // CORS preflight short-circuit. Browsers send OPTIONS without auth
  // headers; if Hono returns 404 (no registered OPTIONS handler) or
  // we let auth middleware run, the preflight gets a 4xx, browsers
  // reject it, and the actual request never fires. API Gateway's
  // cors_configuration adds the Access-Control-* response headers
  // automatically; we just need to return a 2xx status with no body.
  // Registered before auth + route handlers so auth middleware never
  // gates preflights.
  app.options("*", (c) => c.body(null, 204));

  // Cognito auth middleware applies to /api/* EXCEPT /api/demo/*.
  //
  // The API Gateway HTTP API JWT authorizer has already verified
  // signature, iss, audience (client_id), and exp before this Lambda
  // is invoked for /api/* — except for /api/demo/{proxy+} where the
  // gateway-level route specifies authorization_type=NONE (subphase
  // 2.6 demo surface). The middleware below enforces the one
  // remaining check the authorizer cannot — token_use === "access" —
  // and shapes the verified claims onto the Hono context. See
  // infra/modules/cognito/main.tf SECURITY NOTE for the verification
  // split.
  //
  // Applied at the /api/* wildcard so unauthenticated requests to
  // unknown auth-required paths still return 401 (not 404) — paths
  // are not leaked via the 401/404 boundary. The demo skip uses a
  // trailing slash (`/api/demo/`) so a hypothetical future path like
  // `/api/demonstrate` doesn't accidentally bypass auth.
  // The cast is structural: cognitoAuth declares MiddlewareHandler
  // <AuthEnv>, but AppEnv extends AuthEnv. At runtime the Context the
  // middleware receives has all of AuthEnv's bindings/variables; the
  // additional AppEnv ones (lambdaContext, logger) are simply unused
  // there. Hono's generic doesn't model env covariance, so we narrow
  // cognitoAuth's declared type at the call site.
  const cognitoAuthAppEnv = cognitoAuth as unknown as MiddlewareHandler<AppEnv>;
  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/demo/")) {
      return next();
    }
    return cognitoAuthAppEnv(c, next);
  });

  app.route("/api/services", servicesRoutes);
  app.route("/api/demo", demoRoutes);

  return app;
};

// hono/aws-lambda's handle() adapter accepts API Gateway HTTP API
// payload v2 events (along with v1 and ALB events) and exposes the raw
// event, requestContext, and lambdaContext on Hono's `c.env`. The auth
// middleware reads claims from c.env.event.requestContext.authorizer
// .jwt.claims; that path is documented and stable.
export const handler = handle(createApp());
