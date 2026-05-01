import type { Logger } from "@aws-lambda-powertools/logger";
import type { Context } from "aws-lambda";

import type { AuthEnv } from "./middleware/auth.js";

// Combined Hono env for the API. Extends AuthEnv (event Binding + user
// Variable) with the additions PR-B.3 wires in:
//   - lambdaContext Binding: passed by hono/aws-lambda's handle() adapter
//     as the second arg to app.fetch() on every invocation.
//   - logger Variable: per-request Powertools Logger child set by the
//     loggerMiddleware before any auth checks, so auth failures still
//     get the requestId-tagged log entry.
//
// Middleware can be typed against the narrowest env they need
// (cognitoAuth uses AuthEnv since it doesn't touch logger or
// lambdaContext); routes type against AppEnv to access everything.
export type AppEnv = {
  Bindings: AuthEnv["Bindings"] & {
    lambdaContext: Context;
  };
  Variables: AuthEnv["Variables"] & {
    logger: Logger;
  };
};
