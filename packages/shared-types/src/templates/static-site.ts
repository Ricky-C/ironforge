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

// Per-template terraform outputs for the static-site template.
//
// The run-terraform Lambda parses `terraform output -json` and validates
// the result against this schema before treating any value as the
// template's output. Schema mismatch is treated as a template-runtime
// fault — a template author shipped outputs that don't match the
// declared shape — and surfaces as IronforgeTerraformOutputError.
//
// Keys mirror templates/static-site/terraform/outputs.tf verbatim. The
// manifest's outputsSchema field documents the path for humans; runtime
// resolution looks the schema up via TEMPLATE_REGISTRY in
// template-registry.ts.
//
// `.strict()` rejects unexpected output names — surfaces template-author
// drift the same way `.strict()` on inputs surfaces wizard-payload typos.
export const StaticSiteOutputsSchema = z
  .object({
    bucket_name: z.string().min(1),
    distribution_id: z.string().min(1),
    distribution_domain_name: z.string().min(1),
    deploy_role_arn: z.string().min(1),
    live_url: z.string().url(),
    fqdn: z.string().min(1),
  })
  .strict();
export type StaticSiteOutputs = z.infer<typeof StaticSiteOutputsSchema>;
