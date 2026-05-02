import { z } from "zod";

import { StaticSiteInputsSchema } from "./templates/static-site.js";
import { type TemplateId } from "./service.js";

// Single source of truth for per-template runtime metadata.
//
// Both the API handler (POST /api/services first-pass inputs validation)
// and the validate-inputs Lambda (workflow-time inputs validation) consume
// this registry. Adding a new template:
//
//   1. Extend TEMPLATE_IDS in service.ts (drives TemplateIdSchema).
//   2. Land the per-template inputs schema under src/templates/<id>.ts.
//   3. Add an entry here.
//   4. Land the templates/<id>/ironforge.yaml manifest + terraform module
//      + starter code under the templates/ directory.
//
// Future fields land here as PR-C.5 (renderer) and PR-C.6 (terraform path)
// arrive — keeping consumers on a single registry instead of parallel
// per-Lambda maps.

export type TemplateMetadata = {
  inputsSchema: z.ZodTypeAny;
};

export const TEMPLATE_REGISTRY = {
  "static-site": { inputsSchema: StaticSiteInputsSchema },
} as const satisfies Record<TemplateId, TemplateMetadata>;

// Resolve a templateId to its inputs schema. The caller passes a
// validated TemplateId (from TemplateIdSchema), so a missing entry is a
// wiring bug — TS catches it at compile time via the `satisfies` clause
// above. Keeping a runtime guard is unnecessary.
export const getInputsSchema = (templateId: TemplateId): z.ZodTypeAny =>
  TEMPLATE_REGISTRY[templateId].inputsSchema;
