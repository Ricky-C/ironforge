import { Logger } from "@aws-lambda-powertools/logger";
import { describe, expect, it } from "vitest";

import { createLogger } from "./logger.js";

// Powertools' output mechanism (which console.* method or stdout writer
// it uses, plus how it serializes payloads) is implementation detail
// that has churned across minor versions. The factory's contract is
// thinner than that: take params, return a configured Logger. We
// verify (1) the return type, (2) that all documented param shapes
// construct without error — including the env-var passthrough (logLevel
// undefined) that callers rely on with exactOptionalPropertyTypes on.
// Output-shape verification belongs to integration tests of the
// consumers (services/api/src/handler.test.ts already exercises real
// log output through the middleware).

describe("createLogger", () => {
  it("returns a Powertools Logger instance", () => {
    const logger = createLogger({ serviceName: "test-service" });
    expect(logger).toBeInstanceOf(Logger);
  });

  it("constructs without error when logLevel is omitted", () => {
    expect(() => createLogger({ serviceName: "any" })).not.toThrow();
  });

  it("constructs without error when logLevel is undefined (env passthrough)", () => {
    expect(() =>
      createLogger({ serviceName: "any", logLevel: undefined }),
    ).not.toThrow();
  });

  it("constructs without error for each supported logLevel", () => {
    for (const level of ["DEBUG", "INFO", "WARN", "ERROR"] as const) {
      expect(() =>
        createLogger({ serviceName: "any", logLevel: level }),
      ).not.toThrow();
    }
  });
});
