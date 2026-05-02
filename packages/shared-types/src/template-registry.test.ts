import { describe, expect, it } from "vitest";

import { TEMPLATE_IDS } from "./service.js";
import {
  StaticSiteInputsSchema,
  StaticSiteOutputsSchema,
} from "./templates/static-site.js";
import {
  TEMPLATE_REGISTRY,
  getInputsSchema,
  getOutputsSchema,
} from "./template-registry.js";

describe("TEMPLATE_REGISTRY", () => {
  it("has an entry for every TemplateId", () => {
    // The `as const satisfies Record<TemplateId, TemplateMetadata>` clause
    // enforces this at compile time; the runtime check guards against a
    // future refactor that drops the satisfies constraint by accident.
    for (const id of TEMPLATE_IDS) {
      expect(TEMPLATE_REGISTRY[id]).toBeDefined();
      expect(TEMPLATE_REGISTRY[id].inputsSchema).toBeDefined();
      expect(TEMPLATE_REGISTRY[id].outputsSchema).toBeDefined();
    }
  });

  it("static-site entry references StaticSiteInputsSchema + StaticSiteOutputsSchema", () => {
    expect(TEMPLATE_REGISTRY["static-site"].inputsSchema).toBe(
      StaticSiteInputsSchema,
    );
    expect(TEMPLATE_REGISTRY["static-site"].outputsSchema).toBe(
      StaticSiteOutputsSchema,
    );
  });
});

describe("getInputsSchema", () => {
  it("returns the per-template inputs schema for a known templateId", () => {
    expect(getInputsSchema("static-site")).toBe(StaticSiteInputsSchema);
  });

  it("returned schema validates static-site inputs end-to-end", () => {
    const schema = getInputsSchema("static-site");
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ pageTitle: "x" }).success).toBe(false);
  });
});

describe("getOutputsSchema", () => {
  it("returns the per-template outputs schema for a known templateId", () => {
    expect(getOutputsSchema("static-site")).toBe(StaticSiteOutputsSchema);
  });

  it("returned schema validates a fully-formed static-site outputs payload", () => {
    const schema = getOutputsSchema("static-site");
    const valid = {
      bucket_name: "ironforge-svc-my-site-origin",
      distribution_id: "E1ABC123XYZ",
      distribution_domain_name: "d1234abcd.cloudfront.net",
      deploy_role_arn:
        "arn:aws:iam::123456789012:role/ironforge-svc-my-site-deploy",
      live_url: "https://my-site.ironforge.rickycaballero.com",
      fqdn: "my-site.ironforge.rickycaballero.com",
    };
    expect(schema.safeParse(valid).success).toBe(true);
  });

  it("rejects outputs payloads missing required fields", () => {
    const schema = getOutputsSchema("static-site");
    expect(schema.safeParse({ bucket_name: "x" }).success).toBe(false);
  });

  it("rejects outputs payloads with extra unexpected fields (.strict)", () => {
    const schema = getOutputsSchema("static-site");
    const extra = {
      bucket_name: "ironforge-svc-my-site-origin",
      distribution_id: "E1ABC123XYZ",
      distribution_domain_name: "d1234abcd.cloudfront.net",
      deploy_role_arn:
        "arn:aws:iam::123456789012:role/ironforge-svc-my-site-deploy",
      live_url: "https://my-site.ironforge.rickycaballero.com",
      fqdn: "my-site.ironforge.rickycaballero.com",
      surprise: "field",
    };
    expect(schema.safeParse(extra).success).toBe(false);
  });
});
