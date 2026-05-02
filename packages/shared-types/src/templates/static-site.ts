import { z } from "zod";

// Per-template inputs for the static-site template.
//
// MVP intentionally has zero inputs: the service `name` lives on the
// Service entity itself and drives the subdomain, the bucket name, the
// GitHub repo name, and the deploy role name — there's nothing the
// wizard needs to ask the user beyond that. Cosmetic fields like
// pageTitle / defaultIndexFile would break the platform/code boundary
// (users edit those in their own HTML); substantive future inputs
// (custom domain mapping, privacy mode) are real platform features
// added when the platform supports them.
//
// `.strict()` rejects unknown keys so a typo in the wizard's payload
// surfaces as a 400 rather than silently flowing through.
export const StaticSiteInputsSchema = z.object({}).strict();
export type StaticSiteInputs = z.infer<typeof StaticSiteInputsSchema>;
