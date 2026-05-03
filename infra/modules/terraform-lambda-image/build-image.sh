#!/usr/bin/env bash
# Builds and pushes the run-terraform Lambda container image to ECR.
#
# Per ADR-009 § Amendments (PR-C.6): container image Lambda chosen over
# zip+layer because AWS provider 5.83.0 (~585MB) blows the Lambda layer
# 250MB cap. Container images allow up to 10GB.
#
# Pipeline:
#   1. Download + SHA256-verify terraform binary and AWS provider
#      (same supply-chain hygiene as the rejected build-layer.sh).
#   2. esbuild-bundle the run-terraform handler into a single .js file.
#   3. Stage all artifacts in a build context directory.
#   4. docker build → tag with image digest (computed by docker).
#   5. ECR login (via AWS CLI), docker push.
#   6. Write image URI + digest to a file terraform plan reads.
#
# Output: writes infra/modules/terraform-lambda-image/.image-uri with
# the pushed image's full URI (registry/repo@sha256:digest). Terraform
# reads this file at plan time to set the Lambda function's image_uri.
#
# CI must run this script BEFORE terraform plan against the shared
# composition. Local development without docker can't run this script;
# operators planning locally without docker need to skip the
# run-terraform Lambda's plan via -target on other resources.

set -euo pipefail

readonly TERRAFORM_VERSION="1.10.4"
readonly AWS_PROVIDER_VERSION="5.83.0"
readonly ARCH="linux_arm64"
readonly DOCKER_PLATFORM="linux/arm64"

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
readonly HANDLER_DIST_DIR="${REPO_ROOT}/services/workflow/run-terraform/dist"
readonly STAGING_DIR="${SCRIPT_DIR}/.build-context"
readonly IMAGE_URI_FILE="${SCRIPT_DIR}/.image-uri"

readonly TERRAFORM_URL_BASE="https://releases.hashicorp.com/terraform/${TERRAFORM_VERSION}"
readonly TERRAFORM_ZIP="terraform_${TERRAFORM_VERSION}_${ARCH}.zip"
readonly TERRAFORM_SHA256SUMS="terraform_${TERRAFORM_VERSION}_SHA256SUMS"

readonly PROVIDER_URL_BASE="https://releases.hashicorp.com/terraform-provider-aws/${AWS_PROVIDER_VERSION}"
readonly PROVIDER_ZIP="terraform-provider-aws_${AWS_PROVIDER_VERSION}_${ARCH}.zip"
readonly PROVIDER_SHA256SUMS="terraform-provider-aws_${AWS_PROVIDER_VERSION}_SHA256SUMS"

readonly REPOSITORY_NAME="ironforge-run-terraform"

log() {
  echo "[build-image] $*" >&2
}

verify_sha256() {
  local file="$1"
  local sums_file="$2"
  local filename
  filename="$(basename "$file")"
  local expected actual

  expected=$(awk -v f="$filename" '$2 == f { print $1 }' "$sums_file")
  if [[ -z "$expected" ]]; then
    log "ERROR: $filename not found in $(basename "$sums_file")"
    return 1
  fi

  actual=$(sha256sum "$file" | awk '{ print $1 }')
  if [[ "$expected" != "$actual" ]]; then
    log "ERROR: SHA256 mismatch for $filename"
    log "  expected: $expected"
    log "  actual:   $actual"
    return 1
  fi

  log "  ✓ SHA256 verified for $filename"
}

main() {
  log "Building run-terraform container image (terraform=${TERRAFORM_VERSION}, aws-provider=${AWS_PROVIDER_VERSION}, arch=${ARCH})"

  if ! command -v docker >/dev/null 2>&1; then
    log "ERROR: docker not found. This script requires Docker to build the Lambda container image."
    exit 1
  fi

  if [[ ! -d "$HANDLER_DIST_DIR" ]]; then
    log "ERROR: handler dist not found at $HANDLER_DIST_DIR"
    log "Run: pnpm --filter @ironforge/workflow-run-terraform build"
    exit 1
  fi

  rm -rf "$STAGING_DIR" "$IMAGE_URI_FILE"
  mkdir -p "$STAGING_DIR"

  local download_dir="${STAGING_DIR}/.downloads"
  mkdir -p "$download_dir"

  log "Downloading + verifying terraform binary"
  curl -fsSL --output "${download_dir}/${TERRAFORM_ZIP}" "${TERRAFORM_URL_BASE}/${TERRAFORM_ZIP}"
  curl -fsSL --output "${download_dir}/${TERRAFORM_SHA256SUMS}" "${TERRAFORM_URL_BASE}/${TERRAFORM_SHA256SUMS}"
  verify_sha256 "${download_dir}/${TERRAFORM_ZIP}" "${download_dir}/${TERRAFORM_SHA256SUMS}"

  log "Downloading + verifying AWS provider plugin"
  curl -fsSL --output "${download_dir}/${PROVIDER_ZIP}" "${PROVIDER_URL_BASE}/${PROVIDER_ZIP}"
  curl -fsSL --output "${download_dir}/${PROVIDER_SHA256SUMS}" "${PROVIDER_URL_BASE}/${PROVIDER_SHA256SUMS}"
  verify_sha256 "${download_dir}/${PROVIDER_ZIP}" "${download_dir}/${PROVIDER_SHA256SUMS}"

  log "Extracting terraform binary"
  unzip -q -o "${download_dir}/${TERRAFORM_ZIP}" -d "$STAGING_DIR" terraform
  log "Extracting AWS provider"
  unzip -q -o "${download_dir}/${PROVIDER_ZIP}" -d "$STAGING_DIR" "terraform-provider-aws_v${AWS_PROVIDER_VERSION}_x5"
  mv "${STAGING_DIR}/terraform-provider-aws_v${AWS_PROVIDER_VERSION}_x5" "${STAGING_DIR}/terraform-provider-aws"

  log "Copying handler bundle"
  cp "${HANDLER_DIST_DIR}/handler.js" "${STAGING_DIR}/handler.js"
  cp "${HANDLER_DIST_DIR}/package.json" "${STAGING_DIR}/package.json"

  log "Copying templates into build context"
  # Per PR-C.6 path convention, templates land at /opt/templates/<id>/
  # in the image. Stage with the same shape so the Dockerfile's
  # `COPY templates /opt/templates` is a straight directory copy.
  cp -r "${REPO_ROOT}/templates" "${STAGING_DIR}/templates"

  log "Copying Dockerfile to build context"
  cp "${SCRIPT_DIR}/Dockerfile" "${STAGING_DIR}/Dockerfile"

  rm -rf "$download_dir"

  # ECR login + repository URI resolution. ECR repository must exist
  # before this script runs (created by terraform apply against the
  # shared composition's terraform_lambda_image module). On first
  # apply, the repo doesn't exist yet — we need a way to bootstrap.
  # See § "First-apply bootstrap" in the module's main.tf.
  local account_id region repo_uri
  account_id=$(aws sts get-caller-identity --query Account --output text)
  region=$(aws configure get region 2>/dev/null || echo "us-east-1")
  repo_uri="${account_id}.dkr.ecr.${region}.amazonaws.com/${REPOSITORY_NAME}"

  log "Logging into ECR (${region})"
  aws ecr get-login-password --region "$region" \
    | docker login --username AWS --password-stdin "${account_id}.dkr.ecr.${region}.amazonaws.com" >/dev/null 2>&1

  log "Building image (platform: ${DOCKER_PLATFORM})"
  docker buildx build \
    --platform "$DOCKER_PLATFORM" \
    --provenance=false \
    --tag "${repo_uri}:latest" \
    --load \
    "$STAGING_DIR"

  log "Pushing image to ECR"
  docker push "${repo_uri}:latest" >/dev/null

  # Capture the immutable image digest from the push response.
  # docker manifest inspect returns the manifest digest reliably
  # post-push; using digest (not tag) for the Lambda image_uri makes
  # the deploy reproducible.
  local digest
  digest=$(aws ecr describe-images \
    --repository-name "$REPOSITORY_NAME" \
    --image-ids imageTag=latest \
    --query 'imageDetails[0].imageDigest' \
    --output text \
    --region "$region")

  if [[ -z "$digest" || "$digest" == "None" ]]; then
    log "ERROR: failed to read image digest from ECR after push"
    exit 1
  fi

  echo "${repo_uri}@${digest}" > "$IMAGE_URI_FILE"
  log "Image pushed: ${repo_uri}@${digest}"
  log "Wrote URI to: ${IMAGE_URI_FILE}"

  rm -rf "$STAGING_DIR"
}

main "$@"
