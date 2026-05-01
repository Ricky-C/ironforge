import { Hono } from "hono";
import { handle } from "hono/aws-lambda";

import type { AppEnv } from "./env.js";
import { cognitoAuth } from "./middleware/auth.js";
import { loggerMiddleware } from "./middleware/logger.js";
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

  // Cognito auth middleware applies to /api/*. The API Gateway HTTP
  // API JWT authorizer has already verified signature, iss, audience
  // (client_id), and exp before this Lambda is invoked. This
  // middleware enforces the one remaining check the authorizer cannot
  // — token_use === "access" — and shapes the verified claims onto
  // the Hono context. See infra/modules/cognito/main.tf SECURITY
  // NOTE for the verification split.
  //
  // Applied at the wildcard so unauthenticated requests to unknown
  // paths return 401, not 404 — paths are not leaked via the
  // 404/401 boundary.
  app.use("/api/*", cognitoAuth);

  app.route("/api/services", servicesRoutes);

  return app;
};

// hono/aws-lambda's handle() adapter accepts API Gateway HTTP API
// payload v2 events (along with v1 and ALB events) and exposes the raw
// event, requestContext, and lambdaContext on Hono's `c.env`. The auth
// middleware reads claims from c.env.event.requestContext.authorizer
// .jwt.claims; that path is documented and stable.
export const handler = handle(createApp());
