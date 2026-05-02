import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import yaml from "js-yaml";
import { describe, expect, it } from "vitest";

import { IronforgeManifestSchema } from "./manifest.js";

const baseManifest = {
  id: "static-site",
  name: "Static Website",
  description: "Provision a globally distributed static website.",
  version: 1,
  compatibleIronforgeVersion: 1,
  inputsSchema: "packages/shared-types/src/templates/static-site.ts#StaticSiteInputsSchema",
  outputsSchema: "templates/static-site/terraform/outputs.tf",
  allowedResourceTypes: ["aws_s3_bucket", "aws_cloudfront_distribution"],
};

describe("IronforgeManifestSchema", () => {
  it("accepts a well-formed manifest", () => {
    expect(IronforgeManifestSchema.safeParse(baseManifest).success).toBe(true);
  });

  it.each([
    ["UPPER", "uppercase id"],
    ["-leading", "leading hyphen"],
    ["trailing-", "trailing hyphen"],
    ["under_score", "underscore"],
    ["", "empty"],
  ])("rejects id %s (%s)", (id) => {
    expect(
      IronforgeManifestSchema.safeParse({ ...baseManifest, id }).success,
    ).toBe(false);
  });

  it("rejects empty name", () => {
    expect(
      IronforgeManifestSchema.safeParse({ ...baseManifest, name: "" }).success,
    ).toBe(false);
  });

  it("rejects empty description", () => {
    expect(
      IronforgeManifestSchema.safeParse({ ...baseManifest, description: "" }).success,
    ).toBe(false);
  });

  it("rejects non-positive version", () => {
    expect(
      IronforgeManifestSchema.safeParse({ ...baseManifest, version: 0 }).success,
    ).toBe(false);
  });

  it("rejects non-integer version", () => {
    expect(
      IronforgeManifestSchema.safeParse({ ...baseManifest, version: 1.5 }).success,
    ).toBe(false);
  });

  it("rejects non-positive compatibleIronforgeVersion", () => {
    expect(
      IronforgeManifestSchema.safeParse({
        ...baseManifest,
        compatibleIronforgeVersion: -1,
      }).success,
    ).toBe(false);
  });

  it("rejects empty allowedResourceTypes", () => {
    expect(
      IronforgeManifestSchema.safeParse({
        ...baseManifest,
        allowedResourceTypes: [],
      }).success,
    ).toBe(false);
  });

  it.each([
    "AWS_s3_bucket", // uppercase
    "s3_bucket", // missing aws_ prefix
    "aws-s3-bucket", // hyphens not underscores
    "aws_S3_bucket", // uppercase mid-string
    "", // empty
  ])("rejects malformed resource type %s", (rt) => {
    expect(
      IronforgeManifestSchema.safeParse({
        ...baseManifest,
        allowedResourceTypes: [rt],
      }).success,
    ).toBe(false);
  });

  it("rejects when inputsSchema is empty", () => {
    expect(
      IronforgeManifestSchema.safeParse({ ...baseManifest, inputsSchema: "" }).success,
    ).toBe(false);
  });
});

// -----------------------------------------------------------------------
// Fixture test — the actual templates/static-site/ironforge.yaml file
// must round-trip through IronforgeManifestSchema cleanly. Catches
// drift between schema and manifest at PR-merge time, not at PR-C.3
// validate-inputs runtime.
// -----------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_SITE_MANIFEST_PATH = resolve(
  __dirname,
  "../../../templates/static-site/ironforge.yaml",
);

describe("templates/static-site/ironforge.yaml fixture", () => {
  it("parses as YAML and matches IronforgeManifestSchema", () => {
    const raw = readFileSync(STATIC_SITE_MANIFEST_PATH, "utf-8");
    const parsed = yaml.load(raw);
    const result = IronforgeManifestSchema.safeParse(parsed);
    if (!result.success) {
      // Surface the Zod errors in test output so a manifest typo is
      // immediately readable rather than buried in a generic safeParse
      // false.
      throw new Error(
        `static-site manifest failed schema: ${JSON.stringify(result.error.issues, null, 2)}`,
      );
    }
    expect(result.success).toBe(true);
  });

  it("declares static-site as the template id", () => {
    const raw = readFileSync(STATIC_SITE_MANIFEST_PATH, "utf-8");
    const parsed = yaml.load(raw) as { id: string };
    expect(parsed.id).toBe("static-site");
  });
});
