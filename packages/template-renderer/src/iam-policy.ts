// Template-derived IAM policy generation for run-terraform Lambda.
//
// Per ADR-009 § "Why template-derived IAM": the Lambda's IAM policy is
// generated at deploy time from the template manifest's
// `allowedResourceTypes` whitelist (PR-C.1) through the per-resource-
// type mapping in this file. Adding a resource type to a template
// requires updating both the manifest and this mapping; AWS API rejects
// (AccessDenied at apply time) surface the gap. The mapping is the
// load-bearing security artifact — drift is real but version-control-
// reviewable per the ADR's mitigations.
//
// Each entry records the IAM actions terraform invokes for that
// resource type's full lifecycle (Create / Read on plan refresh /
// Update / Delete) and the ARN scope AWS supports for those actions.
// Actions are grouped per resource type for reviewability; the
// generator emits one Statement per resource type.
//
// **Parent vs child resource division (S3-specific gotcha).** Since
// AWS provider v4, terraform's parent `aws_s3_bucket` Read does NOT
// invoke child-config GetBucket* APIs (versioning/encryption/lifecycle/
// PAB/policy). Each child resource type has its own Read calling its
// matching GetBucket* — so this mapping correctly delegates: the
// parent's mapping covers only bucket-level actions
// (CreateBucket/DeleteBucket/GetBucketLocation/GetBucketTagging/
// PutBucketTagging/ListBucket); each child mapping covers its own
// Get/Put pair. If terraform-aws-provider ever moves the child reads
// back into the parent, refresh starts failing with the relevant
// AccessDenied per child API — the recovery is moving the child
// action into the parent's action list.
//
// Future-template note: `iam:PassRole` is NOT in this mapping because
// the static-site template's IAM role is consumed by GitHub Actions
// OIDC (no PassRole semantics). Templates with services that take a
// role as input parameter (Lambda execution roles, ECS task roles,
// etc.) will need it added — at the resource type that triggers the
// pass (e.g., aws_lambda_function for the function's execution role).

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

export type ArnSpec =
  | {
      // Service-resource ARN where the resource name is known at
      // policy-generation time. Template uses `{prefix}` placeholder
      // for the per-service prefix (`ironforge-svc-<service-name>`).
      // Example: `arn:aws:s3:::{prefix}-origin`
      kind: "service-resource";
      arnTemplates: string[];
    }
  | {
      // Resource: "*" — used for AWS services that don't support
      // resource-level scoping for the actions listed (CloudFront's
      // ID-based ARNs, IAM list-style actions, route53:GetChange).
      // Each entry must be cross-referenced in docs/iam-exceptions.md
      // with the rationale.
      kind: "star";
    }
  | {
      // ARN supplied at policy-generation time via the scoping
      // context. Currently only used for route53:ChangeResourceRecordSets
      // / route53:ListResourceRecordSets which scope to the hosted
      // zone ARN (passed from the shared composition's outputs).
      kind: "context";
      contextKey: "hostedZoneArn";
    };

export type ResourceTypeMapping = {
  // Sid for the generated IAM statement. Stable across mapping edits
  // so policy-version diffs in CI plan output are readable.
  sid: string;
  actions: string[];
  arnSpec: ArnSpec;
};

export type ScopingContext = {
  // Service-name-prefix used in name-based ARNs. Constructed from
  // the service's name as `ironforge-svc-<service-name>`. The
  // generator substitutes this for `{prefix}` placeholders in
  // arnTemplates.
  resourcePrefix: string;
  account: string;
  // AWS partition (e.g., "aws", "aws-us-gov"). Standard partition is
  // "aws"; passed through for forward compatibility.
  partition: string;
  // Route53 hosted zone ARN for the platform's domain (e.g.,
  // arn:aws:route53:::hostedzone/Z03347273BU8YRR3DL6PF). Read from
  // the shared composition's dns_hosted_zone_arn output.
  hostedZoneArn: string;
};

export type IamStatement = {
  Sid: string;
  Effect: "Allow";
  Action: string[];
  Resource: string | string[];
};

export class IronforgeUnknownResourceTypeError extends Error {
  override readonly name = "IronforgeUnknownResourceTypeError";

  constructor(
    message: string,
    public readonly context: { resourceType: string; knownTypes: string[] },
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------
// The mapping. Source of truth for run-terraform's IAM policy.
// ---------------------------------------------------------------------

export const RESOURCE_TYPE_TO_IAM: Record<string, ResourceTypeMapping> = {
  // S3 bucket lifecycle. `s3:CreateBucket` is regional, ARN-scoped at
  // bucket name. `s3:ListBucket` is the bucket-existence read terraform
  // refresh issues. Tagging actions support `tags = { ... }` on the
  // bucket resource.
  aws_s3_bucket: {
    sid: "S3BucketCRUD",
    actions: [
      "s3:CreateBucket",
      "s3:DeleteBucket",
      "s3:GetBucketLocation",
      "s3:GetBucketTagging",
      "s3:PutBucketTagging",
      "s3:ListBucket",
    ],
    arnSpec: {
      kind: "service-resource",
      arnTemplates: ["arn:aws:s3:::{prefix}-origin"],
    },
  },

  aws_s3_bucket_versioning: {
    sid: "S3BucketVersioning",
    actions: ["s3:GetBucketVersioning", "s3:PutBucketVersioning"],
    arnSpec: {
      kind: "service-resource",
      arnTemplates: ["arn:aws:s3:::{prefix}-origin"],
    },
  },

  aws_s3_bucket_server_side_encryption_configuration: {
    sid: "S3BucketEncryption",
    actions: [
      "s3:GetEncryptionConfiguration",
      "s3:PutEncryptionConfiguration",
    ],
    arnSpec: {
      kind: "service-resource",
      arnTemplates: ["arn:aws:s3:::{prefix}-origin"],
    },
  },

  aws_s3_bucket_public_access_block: {
    sid: "S3BucketPublicAccessBlock",
    actions: [
      "s3:GetBucketPublicAccessBlock",
      "s3:PutBucketPublicAccessBlock",
    ],
    arnSpec: {
      kind: "service-resource",
      arnTemplates: ["arn:aws:s3:::{prefix}-origin"],
    },
  },

  aws_s3_bucket_lifecycle_configuration: {
    sid: "S3BucketLifecycle",
    actions: ["s3:GetLifecycleConfiguration", "s3:PutLifecycleConfiguration"],
    arnSpec: {
      kind: "service-resource",
      arnTemplates: ["arn:aws:s3:::{prefix}-origin"],
    },
  },

  aws_s3_bucket_policy: {
    sid: "S3BucketPolicy",
    actions: [
      "s3:GetBucketPolicy",
      "s3:PutBucketPolicy",
      "s3:DeleteBucketPolicy",
    ],
    arnSpec: {
      kind: "service-resource",
      arnTemplates: ["arn:aws:s3:::{prefix}-origin"],
    },
  },

  // CloudFront — ID-based ARNs. All distribution/OAC actions go on
  // Resource: "*". Documented in docs/iam-exceptions.md with the
  // rationale that CloudFront's API doesn't support ARN-scoped grants
  // at create-time (Resource: "*" is required by AWS for the action,
  // not a project choice).
  aws_cloudfront_origin_access_control: {
    sid: "CloudFrontOACManagement",
    actions: [
      "cloudfront:CreateOriginAccessControl",
      "cloudfront:GetOriginAccessControl",
      "cloudfront:UpdateOriginAccessControl",
      "cloudfront:DeleteOriginAccessControl",
      "cloudfront:ListOriginAccessControls",
    ],
    arnSpec: { kind: "star" },
  },

  aws_cloudfront_distribution: {
    sid: "CloudFrontDistributionManagement",
    actions: [
      "cloudfront:CreateDistribution",
      "cloudfront:GetDistribution",
      "cloudfront:GetDistributionConfig",
      "cloudfront:UpdateDistribution",
      "cloudfront:DeleteDistribution",
      "cloudfront:TagResource",
      "cloudfront:UntagResource",
      "cloudfront:ListTagsForResource",
      // cloudfront:ListDistributions deliberately NOT included.
      // terraform's aws_cloudfront_distribution Read uses
      // GetDistribution with the known ID, not List. List is only
      // needed for `data "aws_cloudfront_distribution"` data source
      // discovery — a future template that uses the data source
      // would add the action then.
      // cloudfront:CreateInvalidation also deliberately NOT included.
      // Invalidation is the user's deploy-time concern (the template
      // creates the deploy IAM role with cfn:CreateInvalidation in
      // its inline policy); run-terraform doesn't invalidate during
      // apply.
    ],
    arnSpec: { kind: "star" },
  },

  // Route53 — split: record-set actions scope to the hosted zone ARN;
  // GetChange has no resource-level support and goes on "*". Both
  // captured in docs/iam-exceptions.md.
  aws_route53_record: {
    sid: "Route53RecordManagement",
    actions: [
      "route53:ChangeResourceRecordSets",
      "route53:ListResourceRecordSets",
    ],
    arnSpec: { kind: "context", contextKey: "hostedZoneArn" },
  },

  // IAM role — name-scoped. The deploy role's name is
  // `<prefix>-deploy` per the static-site template. Actions span the
  // role's full lifecycle plus refresh-time list/get actions.
  //
  // PutRolePermissionsBoundary is required at create time because the
  // template attaches IronforgePermissionBoundary to the deploy role.
  // DeleteRolePermissionsBoundary is NOT required for role deletion
  // (DeleteRole succeeds with the boundary still attached; the
  // boundary GCs with the role). Kept for forward compatibility: if
  // a future template author changes their mind and removes the
  // boundary declaration mid-life, terraform would call Delete to
  // detach without deleting the role. Trivial cost to include;
  // future amendment cost to omit.
  //
  // ListInstanceProfilesForRole is defensive — the deploy role has
  // no instance profiles (OIDC role, not EC2), but IAM rejects
  // DeleteRole if instance profiles are attached, so terraform's
  // Read pre-flights with this list to surface the conflict.
  aws_iam_role: {
    sid: "IAMRoleManagement",
    actions: [
      "iam:CreateRole",
      "iam:GetRole",
      "iam:DeleteRole",
      "iam:UpdateRole",
      "iam:UpdateAssumeRolePolicy",
      "iam:TagRole",
      "iam:UntagRole",
      "iam:ListRoleTags",
      "iam:ListAttachedRolePolicies",
      "iam:ListRolePolicies",
      "iam:ListInstanceProfilesForRole",
      "iam:PutRolePermissionsBoundary",
      "iam:DeleteRolePermissionsBoundary",
    ],
    arnSpec: {
      kind: "service-resource",
      arnTemplates: ["arn:aws:iam::{account}:role/{prefix}-deploy"],
    },
  },

  aws_iam_role_policy: {
    sid: "IAMRolePolicyManagement",
    actions: [
      "iam:PutRolePolicy",
      "iam:GetRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:ListRolePolicies",
    ],
    // Policy ARNs in iam:RolePolicy actions reference the role itself,
    // not a separate policy ARN — inline policies aren't separately
    // ARNable. Scoping by role ARN.
    arnSpec: {
      kind: "service-resource",
      arnTemplates: ["arn:aws:iam::{account}:role/{prefix}-deploy"],
    },
  },
};

// route53:GetChange is a top-level action that AWS doesn't support
// resource-level for. Returned by ChangeResourceRecordSets to track
// propagation. Required by terraform regardless of which Route53
// resource type triggered the change. Emitted as a separate statement
// at policy-generation time.
const ROUTE53_GET_CHANGE_STATEMENT: IamStatement = {
  Sid: "Route53GetChangeStarRequired",
  Effect: "Allow",
  Action: ["route53:GetChange"],
  Resource: "*",
};

// ---------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------

const resolveArn = (
  template: string,
  context: ScopingContext,
): string =>
  template
    .replaceAll("{prefix}", context.resourcePrefix)
    .replaceAll("{account}", context.account);

const buildStatement = (
  mapping: ResourceTypeMapping,
  context: ScopingContext,
): IamStatement => {
  const { arnSpec } = mapping;
  let resource: string | string[];

  if (arnSpec.kind === "service-resource") {
    const resolved = arnSpec.arnTemplates.map((t) => resolveArn(t, context));
    resource = resolved.length === 1 ? resolved[0]! : resolved;
  } else if (arnSpec.kind === "star") {
    resource = "*";
  } else {
    // context-keyed
    if (arnSpec.contextKey === "hostedZoneArn") {
      resource = context.hostedZoneArn;
    } else {
      // Future-proofing: if a new context key is added to ArnSpec
      // without updating this branch, fail loud.
      throw new Error(
        `Unknown context key in ArnSpec: ${(arnSpec as { contextKey: string }).contextKey}`,
      );
    }
  }

  return {
    Sid: mapping.sid,
    Effect: "Allow",
    Action: mapping.actions,
    Resource: resource,
  };
};

// Generates the IAM policy statements for run-terraform's identity
// policy, given the manifest's allowedResourceTypes and a scoping
// context resolved at deploy time.
//
// Throws IronforgeUnknownResourceTypeError if the manifest references
// a type not in RESOURCE_TYPE_TO_IAM. Forces template authors to
// extend the mapping (and surfaces drift) rather than silently
// granting `Resource: "*"` everywhere on unknown types.
//
// Always emits the route53:GetChange star-required statement even if
// no Route53 resource is in the type list — terraform's S3 backend
// (used for state storage) doesn't need it; the static-site template
// does. Future templates without Route53 still pay this small surface;
// it's a single statement, scoped to a single read action with no
// real blast radius.
export const generateRunTerraformPolicy = (
  allowedResourceTypes: readonly string[],
  context: ScopingContext,
): IamStatement[] => {
  const statements: IamStatement[] = [];
  const knownTypes = Object.keys(RESOURCE_TYPE_TO_IAM);

  for (const resourceType of allowedResourceTypes) {
    const mapping = RESOURCE_TYPE_TO_IAM[resourceType];
    if (mapping === undefined) {
      throw new IronforgeUnknownResourceTypeError(
        `Resource type '${resourceType}' has no IAM mapping. Add to RESOURCE_TYPE_TO_IAM in packages/template-renderer/src/iam-policy.ts and document any Resource:"*" usage in docs/iam-exceptions.md.`,
        { resourceType, knownTypes },
      );
    }
    statements.push(buildStatement(mapping, context));
  }

  // Always include route53:GetChange. Static-site needs it for record
  // creation tracking; cost is negligible.
  statements.push(ROUTE53_GET_CHANGE_STATEMENT);

  return statements;
};
