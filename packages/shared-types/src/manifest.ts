import { z } from "zod";

// Template manifest schema. Each `templates/<id>/ironforge.yaml` is
// validated against this at provisioning time by the validate-inputs
// Lambda (PR-C.3). Template-agnostic — every template uses the same
// manifest shape. Per-template input validation lives elsewhere
// (per-template schemas under `templates/` directories in this package).

const TemplateIdSchema = z
  .string()
  .min(1)
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    "id must be kebab-case lowercase alphanumeric, not starting or ending with hyphen",
  );

// Terraform AWS resource type — `aws_<service>_<resource>` shape per
// hashicorp/aws provider conventions. The whitelist is a security
// guardrail: PR-C.6 (run-terraform) will reject any plan diff that
// declares a type not on this list. New types must be added
// deliberately — same audit trail as a Terraform module change.
const AwsResourceTypeSchema = z
  .string()
  .regex(
    /^aws_[a-z0-9_]+$/,
    "must be a hashicorp/aws Terraform resource type, e.g. aws_s3_bucket",
  );

export const IronforgeManifestSchema = z.object({
  id: TemplateIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),

  // Template version. Bumped on any change to terraform/ or starter-code/
  // that materially changes what newly-provisioned services receive.
  // Persisted onto Service.templateVersion at provisioning time
  // (future field — not on Service yet) so operators can identify which
  // version a given service was provisioned against.
  version: z.number().int().positive(),

  // Platform-version compatibility. If the platform makes a breaking
  // contract change (new required manifest field, etc.), bump the
  // platform version and gate templates behind the new minimum.
  compatibleIronforgeVersion: z.number().int().positive(),

  // Path-with-fragment reference to the per-template inputs schema, e.g.
  // "packages/shared-types/src/templates/static-site.ts#StaticSiteInputsSchema".
  // The validate-inputs Lambda resolves and applies this against the
  // user's wizard submission.
  inputsSchema: z.string().min(1),

  // Path to the terraform outputs file. Consumers (finalize, generate-
  // code) treat the outputs declared there as the ground-truth shape
  // of what the template produces.
  outputsSchema: z.string().min(1),

  // Whitelist of AWS resource types the template is permitted to create.
  // Empty list disallowed — every template creates SOMETHING. Enforcement
  // is run-terraform's job (PR-C.6); the manifest only declares.
  allowedResourceTypes: z.array(AwsResourceTypeSchema).min(1),
});
export type IronforgeManifest = z.infer<typeof IronforgeManifestSchema>;
