import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getTableName } from "./clients.js";

describe("getTableName", () => {
  const ORIGINAL = process.env["DYNAMODB_TABLE_NAME"];

  beforeEach(() => {
    delete process.env["DYNAMODB_TABLE_NAME"];
  });

  afterEach(() => {
    if (ORIGINAL === undefined) {
      delete process.env["DYNAMODB_TABLE_NAME"];
    } else {
      process.env["DYNAMODB_TABLE_NAME"] = ORIGINAL;
    }
  });

  it("returns the env var value when set", () => {
    process.env["DYNAMODB_TABLE_NAME"] = "ironforge-test";
    expect(getTableName()).toBe("ironforge-test");
  });

  it("throws when DYNAMODB_TABLE_NAME is unset", () => {
    expect(() => getTableName()).toThrowError(/DYNAMODB_TABLE_NAME/);
  });
});
