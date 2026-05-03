import { describe, expect, it } from "vitest";

import {
  IronforgeUnknownResourceTypeError,
  RESOURCE_TYPE_TO_IAM,
  generateRunTerraformPolicy,
  type ScopingContext,
} from "./iam-policy.js";

const TEST_CONTEXT: ScopingContext = {
  resourcePrefix: "ironforge-svc-test-blog",
  account: "010438464240",
  partition: "aws",
  hostedZoneArn:
    "arn:aws:route53:::hostedzone/Z03347273BU8YRR3DL6PF",
};

const STATIC_SITE_TYPES = [
  "aws_s3_bucket",
  "aws_s3_bucket_public_access_block",
  "aws_s3_bucket_server_side_encryption_configuration",
  "aws_s3_bucket_versioning",
  "aws_s3_bucket_lifecycle_configuration",
  "aws_s3_bucket_policy",
  "aws_cloudfront_origin_access_control",
  "aws_cloudfront_distribution",
  "aws_route53_record",
  "aws_iam_role",
  "aws_iam_role_policy",
];

describe("generateRunTerraformPolicy — coverage", () => {
  it("emits one statement per resource type plus the route53:GetChange star statement", () => {
    const statements = generateRunTerraformPolicy(STATIC_SITE_TYPES, TEST_CONTEXT);
    expect(statements).toHaveLength(STATIC_SITE_TYPES.length + 1);

    const sids = statements.map((s) => s.Sid);
    expect(sids).toContain("Route53GetChangeStarRequired");
    expect(sids).toContain("S3BucketCRUD");
    expect(sids).toContain("CloudFrontDistributionManagement");
    expect(sids).toContain("IAMRoleManagement");
    expect(sids).toContain("IAMRolePolicyManagement");
  });

  it("throws IronforgeUnknownResourceTypeError on an unrecognized resource type", () => {
    expect(() =>
      generateRunTerraformPolicy(["aws_glue_catalog"], TEST_CONTEXT),
    ).toThrow(IronforgeUnknownResourceTypeError);
  });

  it("error context includes the offending type and the known types list", () => {
    try {
      generateRunTerraformPolicy(["aws_glue_catalog"], TEST_CONTEXT);
      expect.fail("expected throw");
    } catch (err) {
      const e = err as IronforgeUnknownResourceTypeError;
      expect(e.context.resourceType).toBe("aws_glue_catalog");
      expect(e.context.knownTypes).toEqual(Object.keys(RESOURCE_TYPE_TO_IAM));
    }
  });
});

describe("generateRunTerraformPolicy — ARN substitution", () => {
  it("substitutes {prefix} into S3 bucket ARN", () => {
    const [s3] = generateRunTerraformPolicy(["aws_s3_bucket"], TEST_CONTEXT);
    expect(s3!.Resource).toBe("arn:aws:s3:::ironforge-svc-test-blog-origin");
  });

  it("substitutes {account} and {prefix} into IAM role ARN", () => {
    const [role] = generateRunTerraformPolicy(["aws_iam_role"], TEST_CONTEXT);
    expect(role!.Resource).toBe(
      "arn:aws:iam::010438464240:role/ironforge-svc-test-blog-deploy",
    );
  });

  it("emits Resource: '*' for CloudFront resource types", () => {
    const [oac] = generateRunTerraformPolicy(
      ["aws_cloudfront_origin_access_control"],
      TEST_CONTEXT,
    );
    expect(oac!.Resource).toBe("*");

    const [dist] = generateRunTerraformPolicy(
      ["aws_cloudfront_distribution"],
      TEST_CONTEXT,
    );
    expect(dist!.Resource).toBe("*");
  });

  it("uses the hosted-zone ARN from context for Route53 record actions", () => {
    const [r53] = generateRunTerraformPolicy(["aws_route53_record"], TEST_CONTEXT);
    expect(r53!.Resource).toBe(
      "arn:aws:route53:::hostedzone/Z03347273BU8YRR3DL6PF",
    );
  });

  it("emits Resource: '*' for the route53:GetChange auxiliary statement", () => {
    const statements = generateRunTerraformPolicy(["aws_s3_bucket"], TEST_CONTEXT);
    const getChange = statements.find(
      (s) => s.Sid === "Route53GetChangeStarRequired",
    );
    expect(getChange?.Resource).toBe("*");
    expect(getChange?.Action).toEqual(["route53:GetChange"]);
  });
});

describe("generateRunTerraformPolicy — IAM action coverage", () => {
  it("aws_s3_bucket includes Create + Delete + ListBucket", () => {
    const stmt = RESOURCE_TYPE_TO_IAM["aws_s3_bucket"]!;
    expect(stmt.actions).toContain("s3:CreateBucket");
    expect(stmt.actions).toContain("s3:DeleteBucket");
    expect(stmt.actions).toContain("s3:ListBucket");
  });

  it("aws_iam_role includes PutRolePermissionsBoundary (template attaches the boundary)", () => {
    const stmt = RESOURCE_TYPE_TO_IAM["aws_iam_role"]!;
    expect(stmt.actions).toContain("iam:PutRolePermissionsBoundary");
    expect(stmt.actions).toContain("iam:DeleteRolePermissionsBoundary");
  });

  it("aws_iam_role includes UpdateAssumeRolePolicy (terraform updates trust policies in place)", () => {
    const stmt = RESOURCE_TYPE_TO_IAM["aws_iam_role"]!;
    expect(stmt.actions).toContain("iam:UpdateAssumeRolePolicy");
  });

  it("aws_cloudfront_distribution includes Tag actions (template tags resources)", () => {
    const stmt = RESOURCE_TYPE_TO_IAM["aws_cloudfront_distribution"]!;
    expect(stmt.actions).toContain("cloudfront:TagResource");
    expect(stmt.actions).toContain("cloudfront:UntagResource");
    expect(stmt.actions).toContain("cloudfront:ListTagsForResource");
  });

  it("aws_route53_record does NOT directly include route53:GetChange (it lives in the auxiliary statement)", () => {
    const stmt = RESOURCE_TYPE_TO_IAM["aws_route53_record"]!;
    expect(stmt.actions).not.toContain("route53:GetChange");
  });

  it("no resource type's mapping includes iam:PassRole (static-site doesn't need it; future templates with execution-role passing will add explicitly)", () => {
    for (const [type, mapping] of Object.entries(RESOURCE_TYPE_TO_IAM)) {
      expect(
        mapping.actions,
        `${type} should not include iam:PassRole — static-site has no PassRole semantics`,
      ).not.toContain("iam:PassRole");
    }
  });
});

describe("generateRunTerraformPolicy — Sid stability", () => {
  it("Sids are stable across mapping reads (review-friendly diffs)", () => {
    const expected = [
      "S3BucketCRUD",
      "S3BucketPublicAccessBlock",
      "S3BucketEncryption",
      "S3BucketVersioning",
      "S3BucketLifecycle",
      "S3BucketPolicy",
      "CloudFrontOACManagement",
      "CloudFrontDistributionManagement",
      "Route53RecordManagement",
      "IAMRoleManagement",
      "IAMRolePolicyManagement",
    ];
    const statements = generateRunTerraformPolicy(STATIC_SITE_TYPES, TEST_CONTEXT);
    const sids = statements.map((s) => s.Sid);
    for (const sid of expected) {
      expect(sids).toContain(sid);
    }
  });
});
