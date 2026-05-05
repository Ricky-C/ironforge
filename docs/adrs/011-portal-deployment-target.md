# ADR 011 — Portal deployment target: Lambda Web Adapter (LWA) + container image

**Status:** Accepted

**Date:** 2026-05-04

## Context

Phase 0 deployed the portal as a static Next.js export (`apps/web` with `output: "export"` in next.config.mjs) served from S3 + CloudFront at `ironforge.rickycaballero.com`. The setup was right for a placeholder roadmap page with no server-side concerns.

Phase 2 introduces architectural patterns that REQUIRE a Next.js server runtime — patterns that are mutually exclusive with `output: "export"`:

1. **Subphase 2.2 — dev BFF proxy.** ADR-010's Q2 redirect resolved that the dev bearer token must stay server-side, implemented as a Next.js Route Handler at `app/api/dev/proxy/[...path]/route.ts`. Static export does not support route handlers; `next build` fails on the catch-all proxy file.

2. **Subphase 2.5 — OIDC callback handler.** ADR-010 specifies Cognito Hosted UI + `oidc-client-ts`. The callback at `/auth/callback` exchanges the auth code server-side for tokens. That requires a server route, which static export precludes.

3. **Future: any per-user server-side rendering or edge function.** Not on the current roadmap, but the static-only constraint forecloses on it pre-emptively.

`output: "export"` was a Phase 0 simplification that does not survive Phase 2's auth + dev-BFF design. ADR-011 picks the new deployment target. The conflict surfaced during subphase 2.2 minimal implementation rather than at design-time pre-flight; the lesson is captured in `feedback_preflight_deployment_target.md`.

### Empirical input — current state, 2026-05-04

- `apps/web/next.config.mjs`: `output: "export"`, `images.unoptimized: true`. Build artifact: `apps/web/out/` (static HTML + JS chunks + assets).
- `infra/modules/cloudfront-frontend/`: S3 bucket `ironforge-portal-<account-id>` + CloudFront distribution + WAF + Route53 records. Single shared resource (no per-env portal — dev runs locally on `localhost`; prod is the only deployed env).
- `.github/workflows/app-deploy.yml`: builds `apps/web/`, runs `aws s3 sync apps/web/out/ s3://${BUCKET}/ --delete`, invalidates CloudFront `/*`. Production environment with manual approval gate.
- `infra/modules/terraform-lambda-image/`: existing ADR-009-PR-C.6 container Lambda pattern. Dockerfile based on `public.ecr.aws/lambda/nodejs:22`, copies binary + handler, pushed to ECR via `build-image.sh`. Reusable shape for the portal Lambda.
- AWS Lambda Web Adapter: v1.0.0 (March 2026 release per the awslabs/aws-lambda-web-adapter repo), AWS Labs project, ~2.7k GitHub stars, supports container-image and Lambda-layer install paths, supports Lambda Function URL / API Gateway / ALB invocation, includes Next.js examples (Docker and zip) in the repo.

## Decision

**Lambda Web Adapter (LWA) + container image. Single Lambda hosting the Next.js standalone server, fronted by a Lambda Function URL, surfaced through the existing CloudFront distribution as a new origin.**

- Build mode: `output: "standalone"` in next.config.mjs (replaces `"export"`).
- Lambda runtime: container image overlaying the AWS LWA layer onto the Node.js Lambda runtime base. Specific LWA version pinned at implementation time.
- Invocation: Lambda Function URL (no API Gateway). CloudFront treats it as a custom origin.
- Static asset path: full-Lambda for the first migration (Lambda serves both dynamic and static); hybrid (S3 for `.next/static/`, Lambda for dynamic) reserved as a reconsider trigger if cold-start cost on assets becomes user-visible.
- ECR repo: `ironforge-portal`, name-prefix scoped, mirroring the `terraform-lambda-image` ECR naming pattern.
- Deploy path: container build in CI → ECR push → Lambda function image update → CloudFront invalidation.

## Why LWA + container image

### Architectural consistency with the rest of the project

CLAUDE.md § Architectural Philosophy mandates "Serverless-first. Every Ironforge component scales to zero. No always-on compute." LWA preserves this — the portal Lambda scales to zero and pays per-request like every other Ironforge component. App Runner (always-on minimums) and ECS would violate the principle directly; Amplify Hosting hides the runtime behind a managed product but isn't serverless in the cost-shape sense for low-traffic apps.

CLAUDE.md § Anti-Patterns reinforces: "Using ECS or EKS for 'production feel.' No. Pure serverless." LWA is the AWS-native way to run a web framework on Lambda without becoming a Lambda-shaped API. The portal stays a Next.js app; LWA is the bridge.

### CloudFront preservation

The existing CloudFront distribution carries the wildcard ACM cert + WAF + cache behaviors + Route53 alias for `ironforge.rickycaballero.com`. Replacing it with Amplify-managed CloudFront or App Runner's load balancer would discard work that's already done correctly. LWA + Lambda Function URL plugs into the existing distribution as a new origin with minimal terraform churn.

### Function URL over API Gateway

The portal Lambda is reached through a Lambda Function URL — Lambda's built-in HTTPS endpoint per function — rather than fronted by API Gateway. The portal needs none of API Gateway's value-adds: auth lives inside Next.js (per ADR-010), per-request throttling lives at CloudFront / WAF (per Phase 0), request / response transformation isn't required, and there are no usage plans or API keys. What remains is "give Lambda an HTTPS URL," which Function URL does directly.

Costs of API Gateway over Function URL at this scope: per-request HTTP API billing (~$1 per million invocations), additional terraform surface (HTTP API + integrations + routes + stage), and one extra hop of latency. Benefits: none, given the constraints above. API Gateway becomes appropriate only later if portal-specific rate limiting, request transformation, or per-route IAM authentication lands.

### Container pattern reuse from ADR-009

The PR-C.6 amendment to ADR-009 established the container-image Lambda pattern when the run-terraform binary footprint exceeded the layer cap. `infra/modules/terraform-lambda-image/` ships the build script + Dockerfile + ECR repo + Lambda config wiring. The portal Lambda extends the same pattern: different binary stack (Node.js + Next.js standalone instead of terraform), same plumbing (Dockerfile based on AWS Lambda base image, ECR push, image-mode Lambda).

Same container-Lambda pattern, two different workloads — the abstraction earned its space. Picking a different mechanism for the portal would split the pattern surface for no architectural gain.

### Cost: scales to zero at idle

- **Idle:** $0. Lambda doesn't bill for invocations or compute when there's no traffic. ECR storage adds ~$0.03-0.05/mo for the ~300-500 MB image regardless of traffic.
- **Free tier:** 1M invocations + 400K GB-seconds compute per month. Portfolio-scale invocation patterns sit inside this band.
- **Beyond free tier:** $0.20 per 1M additional invocations; $0.0000166667 per additional GB-second of compute.
- **CloudFront + Route53:** unchanged from current static deploy.

**Reconsider trigger (cost-shape):** sustained traffic exceeds ~5M invocations/month (5× free tier). At that volume per-request Lambda pricing approaches App Runner's provisioned baseline; evaluate App Runner or Amplify Hosting for predictable per-instance billing.

At idle, this is a cost wash with the current static deploy. Migration is not a cost regression at portfolio scale.

### Solves the same constraint subphase 2.5 will hit

ADR-010 introduces an OIDC callback at `/auth/callback`. Same constraint as the dev proxy — needs a server runtime. Migrating now (Phase 2 entry) and not deferring to subphase 2.5 means we litigate this once. Subphase 2.5 lands on a deployment target that already supports it.

## Static assets — full-Lambda first, hybrid as escape hatch

Next.js standalone produces three artifact groups: `.next/standalone/server.js` (the runtime entry), `.next/static/` (hashed chunks, fonts, optimized images), `public/` (verbatim static files). Two valid serving shapes:

**(a) All-through-Lambda.** Lambda serves both dynamic routes and static assets. Simpler. Cold start adds latency to every static asset on a cold invocation; CloudFront caches mitigate at scale. At portfolio scale, cold-start static is fine.

**(b) Hybrid: S3 for static + Lambda for dynamic.** Sync `.next/static/` and `public/` to the existing portal bucket; CloudFront cache behaviors split traffic — `/_next/static/*` and known static paths route to S3 origin, everything else to Lambda Function URL origin. More CI / infra surface; better cold-start UX for asset loads.

ADR-011 picks (a) for the first migration. Portfolio scale absorbs cold-start static cost; the hybrid escape hatch is a documented reconsider trigger if measured cost demands it.

## Alternatives considered

### AWS Amplify Hosting

The managed Next.js hosting product. **Rejected** for three reasons:

1. **Vendor-managed compute.** Amplify wraps Lambda@Edge / Lambda under its own deploy abstraction. The portfolio signal of explicit Terraform + IaC ownership disappears behind a managed UI.
2. **Discards CloudFront.** Amplify Hosting brings its own CloudFront distribution; the existing distribution with cert + WAF + Route53 wiring becomes vestigial. Migration tax for nothing.
3. **Less aligned with project's "boring infrastructure choices" + IaC mandate.** CLAUDE.md picks Terraform over CDK and explicit infra over managed products; Amplify Hosting moves in the opposite direction.

Cost is comparable. Not the deciding factor.

### AWS App Runner

Container service with manual `pause` for cost control. **Rejected** for two reasons:

1. **No automatic scale-to-zero.** Verified 2026-05-04 against `aws.amazon.com/apprunner/pricing`: idle memory is billed continuously at $0.007/GB-hour (default minimum 1 instance). At minimum config (1 vCPU / 2 GB) the idle baseline is ~$10/mo+, growing per-request when active. The console / CLI `pause` action stops the service entirely — manual, not automatic, and not a zero-availability path. Lambda + LWA pays $0 at idle and accumulates per request thereafter, which matches the Ironforge cost shape elsewhere.
2. **Serverless-first principle.** CLAUDE.md § Anti-Patterns specifically calls out ECS/EKS. App Runner is a separate service but lives in the same architectural family — managed container service with provisioned compute. The principle applies in spirit.

### Static + API Gateway BFF (separate frontend / backend infra)

Keep `output: "export"` on the portal; deploy server-side route handlers (dev proxy, OIDC callback) as separate Lambdas behind API Gateway. **Rejected** for three reasons:

1. **Two-deployment model.** Portal deploys to S3, BFF deploys to Lambda + API Gateway. CI surface doubles; the boundary between portal and BFF becomes its own coordination problem.
2. **Loses the Next.js cohesion.** The dev proxy and the OIDC callback want to live alongside the rest of the app — co-deploying and sharing the codebase. Splitting them out is enterprise-shape architecture for a single-tenant portfolio app.
3. **Subphase 2.5 still has to solve session storage / route protection.** That cross-substrate boundary is exactly the problem ADR-010's client-side architecture was supposed to avoid. Splitting the BFF re-introduces it asymmetrically.

### Vercel

Hosted Next.js platform. **Rejected** because the project is AWS-native (CLAUDE.md). Vercel would split infra ownership across two clouds for a single component. Not architecturally consistent.

## When to reconsider

**First-load latency exceeds 3 seconds (median of 5 cold-start measurements):**

- Threshold: median `time_total` from 5 cold-start curls > 3 seconds. "First-load latency" rather than "cold-start time" because what matters is the user-perceived cost, not Lambda's contribution in isolation.
- Measurement procedure (copy-paste against the live distribution):

  ```bash
  for i in 1 2 3 4 5; do
    sleep 600  # 10 min idle to force cold
    curl -w '%{time_total}\n' -o /dev/null -s https://ironforge.rickycaballero.com/
  done | sort -n | awk 'NR==3'  # median of 5
  ```

- Mitigation order: (a) hybrid static-asset split — move `.next/static/` and `public/` to the existing S3 portal bucket, route `/_next/static/*` and known asset paths to that origin from CloudFront, leave Lambda for dynamic; (b) App Runner accepting the always-on cost (~$10/mo+ baseline; see § AWS App Runner); (c) provisioned concurrency for the portal Lambda (~$50/mo per provisioned instance — non-trivial at portfolio scale, accept only if (a) and (b) don't fit).

**Cost grows beyond Lambda free tier:**
- Sustained traffic exceeds ~5M invocations/month (5× the 1M-invocation free tier; see § Cost). Per-request Lambda pricing approaches App Runner's provisioned baseline at that volume; evaluate App Runner or Amplify Hosting for predictable per-instance billing.

**Multi-region requirement:**
- LWA is per-region. Multi-region portal would need either CloudFront with multi-origin failover (complex but doable) or a deployment-target swap to something inherently multi-region.

**Image size approaches Lambda's 10GB cap:**
- Same constraint shape as ADR-009 amendment 1 hit for run-terraform. Current Next.js standalone container is ~300-500 MB; runway is ~20× before this fires. If it does, evaluate trimming deps + slim base image before considering migration.

## Pre-implementation tasks

These constitute the migration PR (separate from any feature work; subphase 2.2 minimal resumes after migration lands):

1. **`apps/web/next.config.mjs`:** swap `output: "export"` → `output: "standalone"`. Remove `images.unoptimized: true` — server runtime now supports the Next.js image optimization API. If portal content adds cross-origin image sources later, declare them via `images.remotePatterns` rather than re-disabling optimization.
2. **`apps/web/Dockerfile`:** new file. Base on `public.ecr.aws/lambda/nodejs:22` + LWA layer overlay. Copies `.next/standalone/`, `.next/static/`, `public/`. Sets `AWS_LAMBDA_EXEC_WRAPPER` and `PORT` env. CMD invokes the standalone `server.js`.
3. **`infra/modules/portal-lambda/`:** new module wrapping ECR repo + image-mode Lambda function + Lambda Function URL + IAM execution role (least-privilege; no AWS API access by default — the portal calls the Ironforge API as a Bearer-authenticated client, not via IAM). Pattern-match against `infra/modules/terraform-lambda-image/` + `infra/modules/lambda/`.
4. **`infra/modules/cloudfront-frontend/`:** add a Lambda Function URL origin and switch the default cache behavior to it. Decide whether to keep the S3 origin reachable for the hybrid-static escape hatch (lean: remove S3 origin entirely on first migration; re-add if (a) → (b) reconsider triggers).
5. **`.github/workflows/app-deploy.yml`:** replace the build → S3 sync → invalidate sequence with build → Docker build → ECR push → Lambda function image update → CloudFront invalidation. Mirror the ECR / Lambda update auth pattern from existing CI.
6. **CI OIDC apply role:** add `ecr:*` (against the new `ironforge-portal` ECR repo only — name-prefix scope) and `lambda:UpdateFunctionCode` (against the portal Lambda only) to the apply role. Update `infra/OIDC_BOOTSTRAP.md` per the documented two-step pattern (`feedback_oidc_resource_enumeration.md` discipline; `feedback_oidc_doc_drift.md` orphan-branch check).
7. **Verify first-load latency meets UX expectations.** Run the measurement procedure under § When to reconsider's first-load-latency trigger (5 cold curls × 10-minute idle, take median). If median > 3 seconds, halt subphase 2.5 entry and apply the documented mitigation order (hybrid static-asset split first; App Runner or provisioned concurrency only if the cost case is closed).

## Related

- **ADR-009** — `run-terraform` execution model. Specifically the PR-C.6 amendment (binary-footprint trigger; container-image Lambda chosen). ADR-011 reuses the container Lambda pattern that landed there. `infra/modules/terraform-lambda-image/`'s Dockerfile and `build-image.sh` are the closest reference implementations.
- **ADR-010** — Cognito Hosted UI + `oidc-client-ts`. ADR-011's deployment target is what makes ADR-010's `/auth/callback` route handler deployable. Subphase 2.5 (auth) implementation lands on the foundation ADR-011 provides.
- **ADR-007** — CI boundary asymmetry. The OIDC apply role expansion for ECR + Lambda update permissions follows the documented two-step process.
- **`feedback_preflight_deployment_target.md`** — the lesson captured during ADR-011's discovery. ADR-011 exists because that pre-flight didn't happen at ADR-010's drafting.
- **`feedback_oidc_resource_enumeration.md`** + **`feedback_oidc_doc_drift.md`** — apply role expansion discipline.
- **`infra/modules/cloudfront-frontend/`** — current portal infrastructure to migrate.
- **`.github/workflows/app-deploy.yml`** — current portal deploy workflow to rewrite.
