Ironforge — Project Overview
What Ironforge Is

Ironforge is a self-service Internal Developer Platform (IDP) on AWS. Authenticated users provision pre-configured static websites through a web portal: they fill out a wizard, click Provision, and within ~5 minutes get a fully deployed static site with a custom subdomain, TLS certificate, GitHub repository with starter code, and CI/CD pipeline.

The MVP is deliberately scoped to a single template (Static Website). The architecture is designed so adding additional templates (API services, scheduled jobs) is incremental work, not a rewrite.

This is a portfolio project demonstrating senior platform engineering capability: abstraction design, serverless architecture, infrastructure-as-code orchestration, multi-stage workflow management, and developer experience.
Strategic Goals

Primary: Build a portfolio-grade cloud engineering project that signals capability for Senior Cloud Engineer, Platform Engineer, and DevOps Engineer roles.

Secondary: Demonstrate fluency with TypeScript-end-to-end fullstack architecture. Provide substantial, senior-quality interview talking points around abstraction design, IaC orchestration patterns, and serverless architecture decisions.

Non-goals: This is not a production multi-tenant SaaS. It will not actually be sold or run at scale. It does not need to compete with Backstage, Heroku, Vercel, or commercial IDP tooling. Multiple templates are explicitly post-MVP.
Strategic Positioning

The MVP scoping decision (one template) is itself a senior signal. The README and interview narrative should emphasize: "I deliberately scoped to a single template to validate the platform pattern end-to-end before adding breadth. The architecture is designed to make adding the next templates incremental work."

Position Ironforge as inspired by Backstage, Heroku, and Vercel — a curated, opinionated, AWS-native developer platform that hides cloud complexity behind a clean interface.
High-Level Architecture
Three Logical Components

Web Portal — Next.js application where users browse, provision, and manage services. Includes a wizard for creating new services, a service catalog showing all provisioned services with health and cost data, and a demo mode for unauthenticated visitors.

API and Orchestration Layer — Serverless backend handling auth, persisting service catalog state, kicking off provisioning workflows, and tracking job state. Uses Step Functions to orchestrate the multi-stage provisioning workflow.

Provisioning Engine — Lambda workers that execute Terraform against pre-defined templates, create GitHub repositories with starter code, configure CI/CD, and report progress back through the system.
Detailed Component Architecture

User Browser
   │
   ▼
CloudFront → S3 (Next.js static export or SSR via Lambda@Edge)
   │
   ▼ (API calls)
API Gateway HTTP API
   │
   ▼
Lambda: API Service (TypeScript)
   │
   ├──► DynamoDB (service catalog, jobs, audit log)
   │
   ├──► S3 (Terraform state, generated code artifacts)
   │
   └──► Step Functions (kicks off provisioning workflow)
                │
                ▼
         Step Functions State Machine
                │
                ├──► Lambda: Validate Inputs
                ├──► Lambda: GitHub Repo Creator
                ├──► Lambda: Code Generator
                ├──► Lambda: Terraform Executor
                ├──► Lambda: Wait For Cert
                ├──► Lambda: Wait For CloudFront
                ├──► Lambda: Trigger Initial Deploy
                └──► Lambda: Finalizer

Why This Architecture

The Step Functions approach is deliberate. Provisioning is a multi-stage workflow with potential failures at each stage. Step Functions provides durable execution, automatic retries, observable state, and clean error handling. This is itself a strong portfolio signal — it demonstrates AWS-native workflow orchestration thinking, not just "I called Lambda from Lambda."

DynamoDB single-table design demonstrates AWS-native data modeling patterns. Avoid the temptation to use RDS for "ease" — single-table DynamoDB is the senior signal here.

Pure serverless architecture (no ECS, no RDS, no ElastiCache) keeps costs low and demonstrates serverless-first thinking. In interviews, defend this as "the right architecture for bursty platform tooling — scales to zero between provisioning runs."
Technology Stack
Frontend

    Next.js 14+ (App Router) with TypeScript
    Tailwind CSS with shadcn/ui components
    Lucide React for icons
    React Hook Form + Zod for form validation
    TanStack Query for data fetching and polling
    Deployed as static export to S3 + CloudFront where possible

Backend

    TypeScript end-to-end (same language as frontend, enables type sharing)
    Hono as the Lambda HTTP framework
    AWS SDK for JavaScript v3 (modular SDK)
    Zod for runtime validation of API inputs and template configs
    AWS Lambda Powertools for TypeScript for structured logging, tracing, and metrics

Workflow Orchestration

    AWS Step Functions (Standard Workflows) for the provisioning state machine
    Each step is a Lambda function with focused responsibility
    Built-in retry, error handling, and execution history

Data Layer

    DynamoDB with single-table design for service catalog, job state, and audit log
    S3 for Terraform state files (with DynamoDB locking) and generated code artifacts
    No relational database — DynamoDB suffices for all access patterns

Auth

    AWS Cognito User Pool for portal authentication
    Standard email/password sign-in for MVP
    Demo mode (no auth) for unauthenticated visitors via separate API endpoints with mock data

Infrastructure as Code

    Terraform for provisioning Ironforge's own infrastructure AND for the templates Ironforge uses to provision user services
    Modules organized for clarity and reuse
    Terraform binary bundled in a Lambda layer for the executor to invoke

CI/CD for Ironforge Itself

    GitHub Actions with separate workflows for: Terraform plan on PR, Terraform apply on merge, Application build/deploy, Lambda layer build
    Branch protection on main
    Secrets managed via GitHub Environments + AWS OIDC (no long-lived credentials)

CI/CD Ironforge Generates For User Services

    GitHub Actions workflow auto-generated and committed to user's new repo
    Triggers: build on push to main, deploy to S3, invalidate CloudFront

Observability

    CloudWatch Logs with structured JSON logging via Powertools
    CloudWatch Metrics for custom business metrics (services provisioned, provisioning duration, failure rates)
    AWS X-Ray tracing across Lambda and Step Functions
    A dedicated CloudWatch Dashboard for Ironforge's own health

Domain Strategy

Ironforge runs as a subdomain on the existing personal portfolio domain:

    ironforge.rickycaballero.com — The portal itself
    *.ironforge.rickycaballero.com — Provisioned user sites
    rickycaballero.com — Personal portfolio (existing)

A wildcard ACM certificate covering *.ironforge.rickycaballero.com is issued during initial setup and shared across all provisioned CloudFront distributions, eliminating per-provisioning certificate validation delays.
Data Model (DynamoDB Single-Table)

Single table named ironforge with these access patterns:

Items stored:

    Service entities — One per provisioned service. PK: SERVICE#<service-id>, SK: META. Attributes: name, owner, template, status, AWS resource ARNs, created date, GitHub repo URL, live URL.
    Job entities — One per provisioning attempt. PK: JOB#<job-id>, SK: META. Attributes: service-id, status, current step, started date, completed date, error details if failed, Step Functions execution ARN.
    Job step entities — One per Step Functions stage. PK: JOB#<job-id>, SK: STEP#<step-name>. Attributes: status, started, completed, output/error.
    User-to-services index — GSI on owner attribute for "all services owned by user" queries.
    Audit log entries — PK: AUDIT#<date>, SK: <timestamp>#<event-id>. Captures all state changes for compliance.

Why single-table: Demonstrates AWS-native data modeling. Avoids over-engineering with RDS. Easy to query for the access patterns this app needs. Cheap.
The Static Site Template

The MVP template provisions:

AWS Resources (via Terraform):

    S3 bucket for site content
    CloudFront distribution with custom origin
    Origin Access Control between CloudFront and S3
    Route53 record (<service-name>.ironforge.rickycaballero.com)
    Reference to the shared wildcard ACM certificate
    CloudFront response headers policy with security headers (CSP, HSTS, etc.)
    S3 bucket policy denying direct access (CloudFront only)

GitHub Repository Contents:

    Astro static site starter (recommended for static site simplicity)
    README with deployment instructions
    GitHub Actions workflow for build + deploy + invalidation
    Sensible .gitignore, package.json, basic styling

The Terraform module is the artifact developers pre-approve. Ironforge maintainers (Ricky) curate the module. Users only supply inputs (service name, etc.). This abstraction — opinionated module + user inputs — is the platform engineering pattern.
Provisioning Workflow (Step Functions)

State machine stages, executed in order with proper error handling:

    Validate Inputs — Service name uniqueness check, naming conventions, user permissions
    Create GitHub Repository — Use GitHub App credentials to create repo in configured org/account
    Generate Starter Code — Render template files with user inputs, commit to new repo
    Provision AWS Infrastructure — Run terraform init/plan/apply against the static-site template with user-supplied variables
    Wait for Certificate Validation — Confirm shared wildcard cert is ready (should already be valid)
    Wait for CloudFront Distribution Deployment — Poll until status is "Deployed" (this is the long pole, often 3-5 minutes)
    Trigger Initial Deployment — Run the GitHub Actions workflow to do first deploy
    Finalize — Write service entry to DynamoDB catalog, send completion notification, update job status

Each step is a separate Lambda function. Step Functions handles retries, timeouts, and error propagation. Failed runs leave detailed state for debugging. A compensation step cleans up partial state if the workflow fails after stage 4.
Demo Mode

Unauthenticated visitors get a "Try the Demo" experience that walks through the wizard with mocked progress. The demo:

    Shows the same UI as the real wizard
    Walks through each provisioning step with simulated timing
    Ends on a "service ready" page showing what would have been provisioned
    Does NOT actually provision anything in AWS

Implementation: separate API endpoints under /api/demo/* that return canned responses with realistic timing. Frontend uses the same components but a different API client.

This is critical for the portfolio. Hiring managers will not authenticate. They need to see the experience without friction.
Repository Structure

ironforge/
├── apps/
│   └── web/                          # Next.js portal
│       ├── app/
│       ├── components/
│       ├── lib/
│       └── package.json
├── services/
│   ├── api/                          # Main API Lambda (Hono)
│   ├── workflow/                     # Step Functions task Lambdas
│   │   ├── validate-inputs/
│   │   ├── create-repo/
│   │   ├── generate-code/
│   │   ├── run-terraform/
│   │   ├── wait-for-cert/
│   │   ├── wait-for-cloudfront/
│   │   ├── trigger-deploy/
│   │   └── finalize/
│   └── drift-detector/               # Scheduled Lambda (post-MVP)
├── packages/
│   ├── shared-types/                 # Zod schemas + TypeScript types shared across apps and services
│   ├── shared-utils/                 # AWS SDK clients, logger config, common helpers
│   └── template-renderer/            # Code generation utilities
├── templates/
│   └── static-site/
│       ├── terraform/                # Terraform module for the AWS resources
│       │   ├── main.tf
│       │   ├── variables.tf
│       │   └── outputs.tf
│       ├── starter-code/             # Files copied into user's GitHub repo
│       └── ironforge.yaml            # Template metadata (inputs, description, etc.)
├── infra/
│   ├── modules/
│   │   ├── cognito/
│   │   ├── api-gateway/
│   │   ├── step-functions/
│   │   ├── lambda-functions/
│   │   ├── dynamodb/
│   │   └── cloudfront-frontend/
│   ├── envs/
│   │   ├── dev/
│   │   └── prod/
│   └── README.md
├── .github/
│   └── workflows/
│       ├── infra-plan.yml
│       ├── infra-apply.yml
│       ├── app-deploy.yml
│       └── lambda-layer-build.yml
├── docs/
│   ├── PROJECT_OVERVIEW.md           # This file
│   ├── architecture.md
│   ├── threat-model.md
│   ├── data-model.md
│   ├── adrs/                         # Architecture Decision Records
│   └── runbook.md
├── package.json                      # Root workspace
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── CLAUDE.md                         # Project conventions for Claude Code
└── README.md

Use pnpm workspaces for monorepo management.
Implementation Phases
Phase 0 — Foundations (Days 1-3)

    Initialize monorepo, package manager, TypeScript config
    Set up Terraform for Ironforge's own infrastructure: Cognito, API Gateway, Lambda baselines, DynamoDB, S3, CloudFront for the portal
    GitHub Actions: infra-plan and infra-apply workflows with AWS OIDC
    Hard budget action at $50/month with auto-disable
    Deploy a placeholder Next.js portal to CloudFront — proves end-to-end deploy works
    Create GitHub App for repo provisioning, store credentials in Secrets Manager
    Issue wildcard ACM certificate for *.ironforge.rickycaballero.com

Definition of done: Empty Next.js site visible at ironforge.rickycaballero.com, infrastructure deployed via Terraform from CI.
Phase 1 — End-to-End Provisioning Without UI (Days 4-9)

This is the most important phase. Goal: prove the entire backend pipeline works before building any UI.

    Build the static-site Terraform module
    Build each Lambda for each Step Functions stage
    Wire up the Step Functions state machine
    Build the API endpoints for: kick off job, get job status
    Test by calling the API directly via curl/Postman — submit a job, watch Step Functions execute, verify a real S3+CloudFront site gets provisioned with a working URL

Definition of done: A real static site is provisioned end-to-end via API call. A real GitHub repo gets created with starter code. The site URL works.
Phase 2 — Wizard UI and Service Catalog (Days 10-14)

    Build the multi-step wizard for service creation
    Real-time progress polling (poll /jobs/{id} every 2 seconds)
    "Service ready" page with all the relevant links
    Service catalog list view with status indicators
    Service detail page

Definition of done: A user can sign in via Cognito, fill out the wizard, watch real-time progress, and see their new service in the catalog.
Phase 3 — Demo Mode and Polish (Days 15-18)

    Demo mode endpoints with simulated provisioning flow
    Landing page explaining what Ironforge is, with "Try the Demo" CTA
    Service detail page improvements (links, metrics, etc.)
    Service deletion flow (Terraform destroy + GitHub repo archive)
    README with architecture diagram (excalidraw or draw.io)
    ADRs for: serverless choice, Step Functions choice, single-table DynamoDB choice, Terraform-via-Lambda decision

Definition of done: A hiring manager can visit ironforge.rickycaballero.com, click "Try the Demo," walk through the wizard, see realistic provisioning, end on a "service ready" page. README explains the architecture clearly.
Phase 4 — Drift Detection and Audit (Days 19-21)

    Scheduled Lambda that compares deployed AWS resources to expected state
    Drift surfaced on service detail page
    Audit log view (recent activity across all services)
    Final pass on observability (CloudWatch dashboard)

Definition of done: Drift detection running on schedule, visible in UI. Audit log captures all provisioning events.
Stretch Goals (Post-MVP, Use For Continued Building While Job-Searching)

    Second template: API service (Node.js Lambda + DynamoDB)
    Third template: scheduled job (cron Lambda)
    Cost data per service via Cost Explorer with tags
    CLI companion: ironforge create my-site --template static-site
    Custom template authoring UI
    GitOps mode: Ironforge generates Terraform but opens PR instead of applying directly
    Slack notification integration
    Multi-environment promotion (dev → staging → prod)

These are the things to talk about as "currently building" in interviews. They keep the project alive during continued applications.
Cost Breakdown

Realistic monthly costs at portfolio traffic:

    API Gateway HTTP API: $1-3
    Lambda: free tier covers most of it; $1-2 over
    DynamoDB on-demand: $1-3
    S3: $1-2
    CloudFront + Route53: $1-2
    Cognito: free tier
    Step Functions Standard: $1-2
    ACM: free
    CloudWatch Logs: $2-4
    Secrets Manager (for GitHub App creds): $0.40

Ironforge itself: ~$10-20/month.

Plus per-provisioned-demo-site: ~$2-3/month each (S3 + CloudFront).

Realistic total with 2-3 demo sites running: $15-30/month.

Hard budget action at $50/month auto-disables non-essential resources. Worst-case under unexpected usage: $50.
Security and Safety Posture

This is a portfolio piece but the security posture matters because Ironforge has powerful AWS permissions. Document this in the threat model.

Ironforge's IAM permissions:

    Worker Lambdas have permissions scoped to specific resource patterns (only ironforge-* prefixed resources, only specific regions)
    Permission boundary enforcing the deny-pattern even if the role is misconfigured
    No iam:CreateUser or other IAM-modifying permissions

Auth boundaries:

    Cognito-protected operator routes use API Gateway authorizers
    Demo routes are explicitly under /api/demo/* and serve only mocked data
    Tenant isolation is implicit — single-tenant for portfolio, but document how multi-tenant would work

Cost guardrails:

    AWS Budgets with budget action that triggers a Lambda to disable non-essential resources at $50/month
    Daily cost report via SNS

Provisioning guardrails:

    Templates can only deploy specific resource types
    Hard limit on simultaneous provisioning jobs (5 max, prevents accidental fanout)
    All provisioned resources tagged with ironforge-managed=true for cost attribution and bulk cleanup

Repository safety:

    GitHub App with minimum scopes (only repo creation, not org admin)
    All generated code is reviewed for committed secrets pre-commit (no actual secrets in starter code)

WAF:

    AWS WAF on CloudFront with managed rule groups
    Rate-limited at API Gateway

Critical Decisions Locked In

These are committed and should not be re-litigated without strong reason:

Domain. ironforge.rickycaballero.com for the portal. *.ironforge.rickycaballero.com for provisioned sites. Wildcard ACM certificate shared across all provisioned distributions.

GitHub Account For Generated Repos. Dedicated GitHub organization (ironforge-managed or similar) created during Phase 0 setup.

Static Site Starter Framework. Astro. Lightweight, modern, builds to plain static files cleanly.

AWS Account Structure. Single AWS account for MVP. Multi-account is post-MVP if pursued.

Region. us-east-1 for everything. CloudFront wildcard certs must be in us-east-1.

Backend Language. TypeScript end-to-end. Not Go. Decided based on ship-speed priority and type-sharing benefits.

Frontend Framework. Next.js. Aligned with Orthanc and broader portfolio.
Things To Get Right In The README

The README is what hiring managers actually read. Invest time here.

Required sections:

    Hero section with one-sentence pitch and screenshot
    "Try the Demo" prominent link
    Architecture diagram (excalidraw or draw.io, not text)
    Why I built this — the "I deliberately scoped to validate the platform pattern" narrative
    Architecture decisions — link to ADRs
    Tech stack with rationale, not just a list
    Local development setup
    Roadmap — explicit list of post-MVP improvements showing this is an ongoing project, not abandoned
    Things I'd do differently — senior signal of self-reflection

Avoid:

    Empty "Contributing" section
    Generic "Built with React, AWS, etc." without context
    Tutorial-following vibe ("first I did X, then Y...")

Interview Preparation Built Into The Project

As the project develops, capture interview-ready stories. Suggested ADRs to write:

    Why Step Functions instead of chained Lambdas?
    Why single-table DynamoDB instead of RDS?
    Why TypeScript end-to-end instead of Go for the backend?
    Why pure serverless instead of ECS for the API?
    How does the template metadata format support extensibility?
    How do you safely run Terraform from within a Lambda?
    What's the failure mode if Step Functions partially completes? How do you handle cleanup?
    How would multi-tenancy work? What changes architecturally?

Each ADR is an interview talking point. Write them as decisions are made, not at the end.
Resume Bullets

    Built Ironforge, an internal developer platform on AWS that enables self-service provisioning of pre-configured static websites with custom subdomains, TLS certificates, GitHub repositories, and CI/CD pipelines.
    Architected fully serverless backend using AWS Step Functions, Lambda, DynamoDB single-table design, and API Gateway, scaling to zero between provisioning runs.
    Designed pluggable template system enabling clean extension to additional service types (API services, scheduled jobs).
    Implemented end-to-end TypeScript stack with shared validation schemas across web frontend, API, and worker services.
    Engineered drift detection comparing deployed AWS state against Terraform-declared state with automated alerting.

Risks To Manage

Scope creep. The hardest risk. The project will tempt expansion. Resist. Ship the MVP, then add stretch features in public.

Terraform-in-Lambda complexity. Bundling Terraform binary in a Lambda layer and running subprocess calls has gotchas: cold start time, output streaming, error handling. Budget a full day of Phase 1 just for this.

GitHub App authentication. GitHub Apps use a JWT + installation token flow that's more complex than simple PAT auth. Get this working in Phase 0, not Phase 1.

ACM certificate validation timing. DNS validation can take 1-5 minutes unpredictably. The shared wildcard cert approach minimizes this — it's validated once during setup, not per provisioning.

CloudFront distribution propagation. 3-5 minute wait on every provisioning run. This is unavoidable AWS infrastructure timing. Surface it clearly in the UI ("Waiting for CloudFront — this takes a few minutes").

Recursion confusion. Ironforge provisions AWS resources. Ironforge runs on AWS. The templates Ironforge uses are themselves Terraform, and Ironforge's own infrastructure is also Terraform. Keep these clearly separated in the docs and repo structure.
Success Criteria

The project is done when:

    A hiring manager can visit ironforge.rickycaballero.com, click "Try the Demo," and complete the full simulated wizard flow
    A logged-in user can complete the real provisioning flow and end up with a working static site at a custom subdomain in under 10 minutes
    The service catalog correctly shows all provisioned services
    Drift detection runs on schedule
    README clearly explains the architecture and decisions
    Code is clean enough to point an interviewer at any file
