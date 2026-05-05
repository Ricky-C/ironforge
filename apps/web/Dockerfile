# Multi-stage build for the Ironforge portal Lambda image
# (ADR-011: Lambda Web Adapter + container-image deployment).
#
# Builder stage: Node.js 22 + pnpm. Installs workspace dependencies,
# builds the Next.js standalone bundle at apps/web/.next/standalone/.
#
# Runtime stage: AWS Lambda Node.js 22 base + LWA extension. LWA
# forwards Lambda HTTP events to the standalone server's PORT.

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

FROM public.ecr.aws/lambda/nodejs:22

# AWS Lambda Web Adapter — installed in TWO modes for the Lambda
# Node.js base image:
#
#   1. EXTENSION at /opt/extensions/ — Lambda runtime auto-loads
#      extensions on init. The extension intercepts Lambda invocation
#      events and proxies them as HTTP to the local Next.js server on
#      PORT.
#
#   2. WRAPPER at /opt/bootstrap (referenced by AWS_LAMBDA_EXEC_WRAPPER
#      below) — replaces the standard Lambda Node.js runtime client.
#      Without this, the runtime tries to interpret CMD as a Lambda
#      handler spec (`<module>.<handler>`), tries to import module
#      'server' from CMD ["server.js"], fails with
#      Runtime.ImportModuleError. The wrapper bypasses handler loading
#      and runs CMD as a shell command (node server.js).
#
# The Lambda base image's /lambda-entrypoint.sh -> /var/runtime/bootstrap
# checks AWS_LAMBDA_EXEC_WRAPPER; if set, exec's the wrapper with the
# original args. LWA's wrapper interprets args as the command to run.
# Both files are the same binary in the LWA image; copying twice for
# semantic clarity (extension role vs wrapper role).
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/extensions/lambda-adapter
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.9.1 /lambda-adapter /opt/bootstrap

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
#  - AWS_LAMBDA_EXEC_WRAPPER: points at the LWA wrapper binary. Lambda
#    runtime exec's this instead of loading a handler. The wrapper
#    runs CMD as a shell command, starting the Next.js server.
#  - PORT: where the Next.js server listens. Standalone's default is
#    3000; LWA's default is 8080 — set explicitly so they agree.
#  - AWS_LWA_READINESS_CHECK_PATH: app/api/health/route.ts returns 200.
#    LWA waits for this before forwarding production requests; prevents
#    502s during cold start while Next.js initializes.
ENV AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap
ENV PORT=8080
ENV AWS_LWA_READINESS_CHECK_PATH=/api/health

# CMD as JSON-array exec form (no shell). With AWS_LAMBDA_EXEC_WRAPPER
# set, this isn't interpreted as a Lambda handler spec — LWA's wrapper
# exec's `node server.js` directly.
CMD ["node", "server.js"]
