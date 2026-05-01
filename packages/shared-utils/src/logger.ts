import { Logger } from "@aws-lambda-powertools/logger";
import type { LogLevel } from "@aws-lambda-powertools/logger/types";

// Thin factory over Powertools Logger. Centralizes the LogLevel cast
// (Powertools' constructor takes a typed enum; env vars come in as
// `string | undefined`) so each consumer doesn't repeat it. Per-request
// child loggers (with appendKeys for requestId / jobId / etc.) are the
// caller's responsibility — see services/api/src/middleware/logger.ts
// for the API's requestId-tagged child pattern.

type CreateLoggerParams = {
  serviceName: string;
  // exactOptionalPropertyTypes is on workspace-wide; allowing `undefined`
  // explicitly lets callers pass an env-var value through without
  // narrowing first.
  logLevel?: LogLevel | undefined;
};

export const createLogger = (params: CreateLoggerParams): Logger => {
  return new Logger({
    serviceName: params.serviceName,
    logLevel: params.logLevel ?? "INFO",
  });
};
