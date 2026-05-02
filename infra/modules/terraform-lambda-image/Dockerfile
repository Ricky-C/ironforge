# Container image for the run-terraform Lambda.
#
# Per ADR-009 § Amendments (PR-C.6 binary-footprint trigger): switched
# from Lambda zip+layer to container image because the AWS provider
# 5.83.0 binary alone is 585MB — far over Lambda's 250MB layer cap.
# Container Lambdas support up to 10GB images.
#
# Base image: AWS-provided Node.js 22 Lambda runtime base. Includes the
# Lambda Runtime Interface Client (RIC) and the Runtime Interface
# Emulator (RIE) for local testing.
#
# Build context (all files placed alongside the Dockerfile by build-image.sh):
#   - terraform               : extracted terraform 1.10.4 binary (linux_arm64)
#   - terraform-provider-aws  : extracted AWS provider 5.83.0 binary (linux_arm64)
#   - handler.js              : esbuild-bundled Lambda handler from
#                               services/workflow/run-terraform/dist/
#   - package.json            : ESM marker
#
# All version pinning lives in build-image.sh; this Dockerfile just
# stages whatever the script provides.

FROM public.ecr.aws/lambda/nodejs:22

# Terraform binary at /opt/bin (added to PATH by Lambda runtime).
COPY terraform /opt/bin/terraform
RUN chmod +x /opt/bin/terraform

# AWS provider binary at the conventional terraform plugin cache path.
# Lambda will run terraform with TF_PLUGIN_CACHE_DIR pointing here so
# `terraform init` finds the plugin without network access.
COPY terraform-provider-aws /opt/.terraform.d/plugins/registry.terraform.io/hashicorp/aws/5.83.0/linux_arm64/terraform-provider-aws_v5.83.0_x5
RUN chmod +x /opt/.terraform.d/plugins/registry.terraform.io/hashicorp/aws/5.83.0/linux_arm64/terraform-provider-aws_v5.83.0_x5

# Lambda task root holds the handler. The base image sets
# LAMBDA_TASK_ROOT=/var/task; copying here puts handler.js where the
# RIC expects it.
COPY handler.js ${LAMBDA_TASK_ROOT}/handler.js
COPY package.json ${LAMBDA_TASK_ROOT}/package.json

# RIC entrypoint expects "<module>.<exported-handler>" as CMD. handler.js
# exports `handler` per the workflow Lambda convention.
CMD ["handler.handler"]
