# One-shot import to recover from PR #35's botched apply.
#
# What happened: PR #35's terraform refresh received a transient false-positive
# "deleted" response for the artifacts bucket and removed it from state. The
# apply then destroyed the 5 sub-resources (versioning, encryption, public
# access block, lifecycle, bucket policy) before failing on bucket recreate
# with BucketAlreadyExists (the bucket was never actually deleted in AWS).
# PRs #36 and the dependent applies hit the same wall.
#
# Current divergence: bucket exists in AWS but is missing from state; the 5
# sub-resources are gone from both AWS and state. The bucket is empty (Phase 0
# has no Lambda consumers writing to it), so no data risk.
#
# This import re-attaches the bucket to state. The same apply that processes
# this import will re-create the 5 sub-resources from config, restoring the
# security posture: TLS-only deny, cross-env scope, AES256 encryption, public
# access block, versioning, lifecycle.
#
# This file is intentionally one-shot. After the import applies cleanly,
# remove this entire file in a follow-up PR — the bucket will be tracked in
# state going forward and the import block has no further purpose. Per
# Terraform 1.5+ import-block convention, leaving the block in place after
# apply is harmless but creates noise on future plans.

data "aws_caller_identity" "imports" {}

import {
  to = module.artifacts.aws_s3_bucket.artifacts
  id = "ironforge-artifacts-${data.aws_caller_identity.imports.account_id}"
}
