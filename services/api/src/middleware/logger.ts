import { Logger } from "@aws-lambda-powertools/logger";
import type { LogLevel } from "@aws-lambda-powertools/logger/types";
import type { MiddlewareHandler } from "hono";

import type { AppEnv } from "../env.js";

// Module-level base logger; child loggers per request inherit config.
// Service name + log level read from env (set by the Lambda function
// definition in infra/envs/<env>/main.tf).
const baseLogger = new Logger({
  serviceName: process.env["POWERTOOLS_SERVICE_NAME"] ?? "ironforge-api",
  logLevel: (process.env["LOG_LEVEL"] as LogLevel | undefined) ?? "INFO",
});

// Per-request middleware: creates a Logger child with the API Gateway
// request ID attached as a persistent log key. Subsequent log calls in
// downstream middleware/handlers get the requestId for free.
//
// Applied BEFORE cognitoAuth in createApp() so auth-failure logs still
// carry the requestId — operators tracing a 401 can correlate to the
// API Gateway access log entry by the same id.
export const loggerMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const requestId = c.env.event?.requestContext?.requestId;
  const logger = baseLogger.createChild();
  if (requestId) {
    logger.appendKeys({ requestId });
  }
  c.set("logger", logger);
  await next();
};
