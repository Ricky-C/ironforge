# Multi-stage build for the Ironforge portal Lambda image
# (ADR-011: Lambda Web Adapter + container-image deployment;
# see ADR-011 amendment 2026-05-05 for the runtime base image
# correction below).
#
# Builder stage: Node.js 22 + pnpm. Installs workspace dependencies,
# builds the Next.js standalone bundle at apps/web/.next/standalone/.
#
# Runtime stage: plain Debian Node 22 + LWA extension. LWA forwards
# Lambda HTTP invocation events to the standalone server's PORT.

# ============================================================================
# Builder
# ============================================================================

FROM node:22-bookworm-slim AS builder

# pnpm via corepack (bundled with Node 22).
RUN corepack enable

WORKDIR /repo

# Workspace metadata first so Docker can cache the pnpm install layer
# across source-only changes. tsconfig.base.json is part of metadata —
# apps/web/tsconfig.json extends it; without it next build fails to
# parse the tsconfig.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./

# Per-package metadata for workspace dependency resolution. Listing
# only the packages @ironforge/web actually depends on (transitively)
# keeps the install footprint bounded; if a new workspace dep lands,
# add its package.json here.
COPY apps/web/package.json apps/web/
COPY packages/shared-types/package.json packages/shared-types/

# Install only what @ironforge/web needs. The "..." suffix includes
# workspace dependencies. --frozen-lockfile fails if pnpm-lock.yaml
# is out of sync with package.json files.
RUN pnpm install --frozen-lockfile --filter "@ironforge/web..."

# Source.
COPY apps/web apps/web
COPY packages/shared-types packages/shared-types

# Build the Next.js standalone bundle. With outputFileTracingRoot
# pointing at the monorepo root (next.config.mjs), the standalone
# tree contains the workspace layout under apps/web/.
RUN pnpm --filter @ironforge/web build

# ============================================================================
# Runtime
# ============================================================================

# Plain Debian Node base, NOT public.ecr.aws/lambda/nodejs:22 — see
# ADR-011 amendment 2026-05-05 (PR-107). The Lambda Node.js base image's
# /lambda-entrypoint.sh enforces $# -eq 1 (exactly one handler-spec arg)
# before /var/runtime/bootstrap is reached, so AWS_LAMBDA_EXEC_WRAPPER
# never takes effect with multi-arg CMD. The deeper issue is pattern-fit:
# a web-server Lambda doesn't use the handler model and has no need for
# the Lambda runtime client. Plain Node is the LWA-blessed default for
# container-image LWA Lambdas (https://aws.github.io/aws-lambda-web-adapter/);
# only the LWA extension at /opt/extensions/ needs to be installed for
# Lambda's runtime to load it during init.
#
# ECR public mirror (not Docker Hub directly) to avoid anonymous-pull
# rate limits in CI and to stay AWS-native for image distribution.
FROM public.ecr.aws/docker/library/node:22-bookworm-slim

# AWS Lambda Web Adapter — extension only. Lambda's init phase loads
# binaries from /opt/extensions/ regardless of base image. The extension
# intercepts Lambda invocation events and proxies them as HTTP to the
# local Next.js server on PORT.
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter

# Standalone bundle from builder. With outputFileTracingRoot pointing
# at the monorepo root, .next/standalone/ contains the workspace
# layout: ./apps/web/server.js with deps in ./node_modules/. Copy the
# whole standalone tree to /var/task.
COPY --from=builder /repo/apps/web/.next/standalone /var/task

# Static assets (.next/static and public/) are not included in the
# standalone bundle by Next.js — copy them into their expected paths
# alongside the server.
COPY --from=builder /repo/apps/web/.next/static /var/task/apps/web/.next/static
COPY --from=builder /repo/apps/web/public /var/task/apps/web/public

# Working directory matches where Next.js standalone places server.js.
WORKDIR /var/task/apps/web

# LWA configuration:
#  - PORT: where the Next.js server listens. Standalone's default is
#    3000; LWA's default is 8080 — set explicitly so they agree.
#  - AWS_LWA_READINESS_CHECK_PATH: app/api/health/route.ts returns 200.
#    LWA waits for this before forwarding production requests; prevents
#    502s during cold start while Next.js initializes.
ENV PORT=8080
ENV AWS_LWA_READINESS_CHECK_PATH=/api/health

# Plain Node base image: no /lambda-entrypoint.sh; CMD runs as the
# container's command directly. LWA's extension forwards Lambda
# invocation events as HTTP to the Next.js server.
CMD ["node", "server.js"]
