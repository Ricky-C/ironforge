# One-shot import to recover the artifacts bucket from state divergence after
# PR #38's apply hit the same refresh-cascade incident first seen in PR #35.
# See docs/postmortems/2026-04-bucket-policy-refresh-cascade.md for the full
# diagnostic record.
#
# Bucket exists in AWS, missing from state. The 5 sub-resources (versioning,
# encryption, public-access-block, lifecycle, bucket policy) were destroyed
# during PR #38's apply before bucket recreate failed with BucketAlreadyExists.
#
# This import re-attaches the bucket to state. The same apply re-creates the
# 5 sub-resources from config — and since this PR also disables the cross-env
# bucket-policy statements that correlate with the refresh cascade (see
# infra/modules/artifacts/main.tf), future applies should not re-trigger the
# incident.
#
# Remove this file in a follow-up PR after the import lands cleanly. Per
# Terraform 1.5+ convention, import blocks are one-shot.

data "aws_caller_identity" "imports" {}

import {
  to = module.artifacts.aws_s3_bucket.artifacts
  id = "ironforge-artifacts-${data.aws_caller_identity.imports.account_id}"
}
