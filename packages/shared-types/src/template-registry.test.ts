import { describe, expect, it } from "vitest";

import { TEMPLATE_IDS } from "./service.js";
import { StaticSiteInputsSchema } from "./templates/static-site.js";
import {
  TEMPLATE_REGISTRY,
  getInputsSchema,
} from "./template-registry.js";

describe("TEMPLATE_REGISTRY", () => {
  it("has an entry for every TemplateId", () => {
    // The `as const satisfies Record<TemplateId, TemplateMetadata>` clause
    // enforces this at compile time; the runtime check guards against a
    // future refactor that drops the satisfies constraint by accident.
    for (const id of TEMPLATE_IDS) {
      expect(TEMPLATE_REGISTRY[id]).toBeDefined();
      expect(TEMPLATE_REGISTRY[id].inputsSchema).toBeDefined();
    }
  });

  it("static-site entry references StaticSiteInputsSchema", () => {
    expect(TEMPLATE_REGISTRY["static-site"].inputsSchema).toBe(
      StaticSiteInputsSchema,
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
