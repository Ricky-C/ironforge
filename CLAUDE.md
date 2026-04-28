CLAUDE.md — Ironforge Project Context
This is the permanent context anchor for Claude Code sessions on the Ironforge project. Read this fully at the start of every session.

What Ironforge Is
Ironforge is a self-service Internal Developer Platform (IDP) on AWS. Authenticated users provision pre-configured static websites through a web portal — they fill out a wizard, click Provision, and within ~5 minutes get a fully deployed static site with custom subdomain, TLS certificate, GitHub repository with starter code, and CI/CD pipeline.
The MVP is deliberately scoped to a single template (Static Website). The architecture is designed so adding additional templates (API services, scheduled jobs) is incremental work, not a rewrite.
This is a portfolio project demonstrating senior platform engineering capability: abstraction design, serverless architecture, IaC orchestration, multi-stage workflow management, and developer experience.
Architectural Philosophy
Ironforge is opinionated. It is not a general-purpose platform. The opinions are:

Serverless-first. Every Ironforge component scales to zero. No always-on compute. This is the right architecture for bursty platform tooling.
Single-tenant by design. Multi-tenancy is a hypothetical future concern, not a current requirement. Don't over-engineer for it.
Templates are curated. The maintainer (Ricky) curates templates. Users supply inputs only. This abstraction — opinionated module + user inputs — is the platform engineering pattern.
Boring infrastructure choices. Use AWS-native services over third-party tools. Use proven patterns over clever ones.
Type-safe end-to-end. TypeScript everywhere. Shared Zod schemas. Compile-time guarantees over runtime checks.
Step Functions for workflows. Multi-stage processes use Step Functions. Don't chain Lambdas manually.
DynamoDB single-table design. No RDS. Single-table over multi-table. Fight the temptation to use RDS for "ease."
Shared resources with prefix separation. Default to one shared AWS resource (S3 bucket, Cognito user pool, SNS topic) with prefix-, key-, or audience-claim separation per environment, not multiple physical resources per env. DynamoDB is the principal known exception due to weak IAM partition-key matching — see ADR-005. Other exceptions require similar threat-model justification.

When making architectural decisions, prefer choices that demonstrate senior-level thinking over choices that are easier to implement. The portfolio signal is the architecture, not just the working code.
Core Stack

Language: TypeScript everywhere (frontend, backend, workers)
Frontend: Next.js 14+ (App Router), Tailwind CSS, shadcn/ui, TanStack Query, React Hook Form, Zod
Backend: Hono on Lambda (NOT Express, NOT Fastify), AWS SDK for JavaScript v3 (modular)
Workflow: AWS Step Functions Standard Workflows
Data: DynamoDB single-table, S3 for state and artifacts
Auth: AWS Cognito User Pools
IaC: Terraform (NOT CDK, NOT Pulumi)
Package manager: pnpm with workspaces
Observability: AWS Lambda Powertools for TypeScript, CloudWatch, X-Ray
CI/CD: GitHub Actions with AWS OIDC (no long-lived credentials)
Domain: ironforge.rickycaballero.com for the portal, *.ironforge.rickycaballero.com for provisioned sites

Repository Structure
ironforge/
├── apps/
│   └── web/                          # Next.js portal
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
│   └── drift-detector/               # Scheduled (post-MVP)
├── packages/
│   ├── shared-types/                 # Zod schemas + TS types
│   ├── shared-utils/                 # AWS clients, logger, helpers
│   └── template-renderer/            # Code generation
├── templates/
│   └── static-site/
│       ├── terraform/
│       ├── starter-code/
│       └── ironforge.yaml
├── infra/
│   ├── modules/
│   ├── envs/
│   └── README.md
├── .github/workflows/
├── docs/
│   ├── architecture.md
│   ├── threat-model.md
│   ├── adrs/
│   └── runbook.md
└── CLAUDE.md                         # This file
When adding new code, place it in the correct location. Do not create top-level files that don't fit the structure. If something genuinely doesn't fit, propose a structural addition rather than placing it ad-hoc.
TypeScript Conventions
Strictness. tsconfig.base.json enforces strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true. Never disable these. If a strict-mode error feels wrong, the type model is wrong, not the strictness.
No any. Ever. If a third-party library has bad types, write a typed wrapper or use unknown and narrow.
No type assertions (as) without justification. Prefer type guards and narrowing. When as is genuinely needed (DynamoDB unmarshalling, e.g.), add a comment explaining why.
Zod for runtime validation. Every API input is validated with Zod. Every external data boundary (DynamoDB read, GitHub API response) gets a Zod schema. Types are inferred from schemas via z.infer<typeof schema>, not duplicated.
Shared types live in packages/shared-types. Anything used by both frontend and backend goes here. Don't duplicate types across packages.
Discriminated unions over optional fields. When state has multiple shapes, model them as discriminated unions. Don't use a single type with many optional fields.
Function signatures are intentional. Prefer named arguments via objects for functions with 3+ parameters. Accept narrow types, return narrow types.
Errors are typed. Use Result<T, E> patterns or custom error classes. Don't throw generic Error. Don't swallow errors silently.
File and Naming Conventions
File names: kebab-case for files (service-catalog.ts), PascalCase for React components (ServiceCatalog.tsx).
Function names: camelCase, descriptive verbs (provisionStaticSite, not doStuff).
Constants: SCREAMING_SNAKE_CASE for true constants, camelCase for configuration values.
Types and interfaces: PascalCase. Prefer types over interfaces unless extending is needed.
Acronyms in names: Treated as single word in camelCase (getAwsClient, not getAWSClient). Treated as fully capitalized in PascalCase (AWSClient, not AwsClient). Yes, this is inconsistent — it matches dominant TypeScript community convention.
Booleans: Prefix with is, has, should, can. (isProvisioning, hasErrors, shouldRetry).
Async functions: No Async suffix. The Promise<T> return type is enough.
Test files: *.test.ts colocated with the file under test.
AWS Resource Conventions
Resource naming: All Ironforge-managed AWS resources are prefixed ironforge-. Provisioned user resources are prefixed ironforge-svc-<service-name>-.
Tagging: Every Ironforge-managed resource has these tags:

ironforge-managed = true
ironforge-component = <component-name> (e.g., api, workflow, template)
ironforge-environment = <env> (e.g., dev, prod)

Provisioned user resources additionally have:

ironforge-service-id = <id>
ironforge-service-name = <name>
ironforge-owner = <user-id>

Region: Everything in us-east-1. Don't add code that assumes other regions without explicit reason. CloudFront wildcard certs require us-east-1 anyway.
IAM: Lambdas have purpose-specific roles. No shared "ironforge-lambda-role." Each Lambda has minimum permissions for its job. Permission boundaries enforce hard limits even if a role is misconfigured.
Resource arns and identifiers: Always treat as opaque strings. Don't parse ARNs to extract account IDs or regions.
Security Guardrails
These are non-negotiable. Refuse requests that violate them.
Secrets:

No secrets in code, config files, environment variables in repos, or comments
All secrets via AWS Secrets Manager or Parameter Store (SecureString)
Never log secrets, even in debug mode
Never include secrets in error messages or stack traces

IAM:

No Resource: "*" on iam:*, sts:AssumeRole, or anything granting elevation
No Action: "*" ever
All cross-service access via specific IAM roles, not shared keys
Permission boundaries on all Ironforge IAM roles

Provisioning safety:

Templates can only deploy specific resource types (whitelist, not blacklist)
Hard limit: 5 concurrent provisioning jobs across the system
All provisioned resources tagged for cleanup
No provisioning of resources outside us-east-1 without explicit code change

Authentication:

Cognito-protected routes use API Gateway authorizers, not in-Lambda checks
Demo routes are explicitly under /api/demo/* and serve only mocked data
No backdoors, no admin override, no "skip auth in dev" flags

Cost protection:

AWS Budgets with budget action triggering Lambda to disable non-essential resources at $50/month
Daily cost report via SNS
Hard limits on resource sizes (no instances larger than t3.micro for templates, no RDS larger than db.t4g.micro)

Data:

All DynamoDB tables encrypted (AWS-managed encryption by default; CMK only when ADR-003 criteria apply)
All S3 buckets have encryption-at-rest, block-public-access, and TLS-only bucket policies (CMK choice per ADR-003)
CloudWatch Logs use AWS-managed encryption by default; CMK only when log content is sensitive or compliance requires it (per ADR-003)

WAF:

AWS WAF on the portal CloudFront with managed rule groups
Rate limiting at API Gateway

Refusal cases:

Do not generate code that hardcodes AWS credentials, even in tests
Do not generate code with Resource: "*" IAM policies
Do not generate code that disables encryption
Do not generate code that bypasses Cognito on protected routes
Do not generate code that runs Terraform with admin-equivalent permissions
Do not commit .env files, *.pem, *.key, or any credential-bearing files
If a generated .gitignore doesn't exclude these, fix it

Error Handling Philosophy
Errors are values. Use Result types or sum types where it improves clarity. When throwing, throw typed errors with context.
Custom error classes: Each service has a base error class. Specific errors extend it. Examples:
typescriptexport class IronforgeError extends Error {
  constructor(message: string, public code: string, public context?: Record<string, unknown>) {
    super(message);
    this.name = 'IronforgeError';
  }
}

export class ProvisioningError extends IronforgeError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, 'PROVISIONING_FAILED', context);
    this.name = 'ProvisioningError';
  }
}
Logging: Use Powertools logger. Structured JSON. Include correlation IDs (job ID, service ID) on every log line related to a workflow.
Retries: Step Functions handles workflow-level retries. Don't add manual retry loops in task Lambdas unless there's a specific reason. Document the reason as a comment.
User-facing errors: Sanitized. Never include internal IDs, stack traces, or AWS resource identifiers in errors returned to the API client. Log details internally; show generic codes to users.
Step Functions Workflow Conventions
Each task Lambda is a single responsibility. Don't combine "create repo and generate code" into one task. Separate Lambdas, separate states.
Tasks are idempotent. A task that runs twice should not corrupt state. Use deterministic IDs based on workflow execution name.
Tasks accept and return JSON. No binary payloads. Outputs are inputs to the next stage.
Errors propagate via Step Functions error handling. Throw typed errors; let Step Functions catch them. Don't catch errors and convert them to "successful" responses.
State is in DynamoDB, not Step Functions execution data. Use Step Functions to orchestrate, DynamoDB for the source of truth.
Compensation: If a workflow fails partway, compensating actions clean up resources created earlier. Add a cleanup-on-failure state to the state machine, not in individual tasks.
Terraform Conventions
Modules: Self-contained, reusable, with clear variables.tf and outputs.tf. No hidden dependencies on parent state.
State: S3 backend with DynamoDB locking. Per-environment state files. Never edit state files manually.
Variables: Typed, with descriptions. Required vs. optional clearly marked.
Versions: required_version and required_providers blocks pinned. Don't accept "latest" for anything in production paths.
Naming inside Terraform: Use the AWS convention (aws_s3_bucket, aws_cloudfront_distribution). Local resource names use snake_case (resource "aws_s3_bucket" "site_content").
Comments: Explain why, not what. Especially for non-obvious decisions ("This bucket policy denies non-CloudFront access — see ADR-007").
Templates have their own Terraform. The static-site template's Terraform is in templates/static-site/terraform/, not in infra/. The infra/ directory is for Ironforge's own infrastructure only.
DynamoDB Single-Table Conventions
Table: One table named ironforge. Single-table design.
Keys:

PK (partition key): String
SK (sort key): String
GSI1PK / GSI1SK: For inverted access patterns (e.g., user-to-services)

Entity types and their keys:

Service: PK = SERVICE#<id>, SK = META
Job: PK = JOB#<id>, SK = META
Job step: PK = JOB#<id>, SK = STEP#<step-name>
Audit: PK = AUDIT#<yyyy-mm-dd>, SK = <iso-timestamp>#<event-id>

Attribute naming: camelCase. No prefixes. Use serviceName, not service_name or s_name.
Marshalling: Use AWS SDK v3's @aws-sdk/util-dynamodb for marshall/unmarshall. Validate unmarshalled data with Zod before using.
Access patterns are documented. Before adding a new query pattern, document it in docs/data-model.md and confirm it fits the existing key design or requires a new GSI.
API Conventions
Hono routing. Routes organized by resource. Each route file is small and focused.
Route files structure:
services/api/
├── routes/
│   ├── services.ts
│   ├── jobs.ts
│   ├── auth.ts
│   └── demo/
│       ├── services.ts
│       └── jobs.ts
├── middleware/
├── lib/
└── handler.ts
Validation: Every request body, query param, and path param validated with Zod. Use Hono's Zod integration.
Response shape: Consistent envelope:
typescripttype ApiResponse<T> = 
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };
Status codes: Use them properly. 200 for success, 201 for creation, 400 for validation, 401 for auth missing, 403 for auth insufficient, 404 for not found, 409 for conflict, 500 for server error.
No PUT for partial updates. Use PATCH for partial updates, PUT for full replacement.
Idempotency: POST endpoints that create resources accept an Idempotency-Key header. Store it in DynamoDB with TTL.
Pagination: Cursor-based. No offset pagination. Cursor is opaque to the client.
Frontend Conventions
Component structure:
apps/web/
├── app/                              # Next.js App Router
├── components/
│   ├── ui/                           # shadcn primitives
│   ├── features/                     # Feature-specific components
│   └── layout/
├── lib/
│   ├── api-client/
│   ├── hooks/
│   └── utils/
└── styles/
Server vs. client components: Default to server components. Mark "use client" only when needed (interactivity, hooks, browser APIs).
Data fetching: TanStack Query for client-side. Server components fetch directly. Don't mix patterns.
Forms: React Hook Form + Zod resolver. Share schemas with backend via packages/shared-types.
Styling: Tailwind utility classes. No CSS modules. No inline styles. Use cn() utility for conditional classes.
State management: TanStack Query for server state. React state for local UI state. No Redux, no Zustand, no Jotai unless specifically needed (it shouldn't be).
Loading and error states: Every data-fetching component has explicit loading, error, and empty states. No flashing of empty content.
Accessibility: Semantic HTML. ARIA only when semantic HTML doesn't suffice. Keyboard navigation works everywhere. Screen-reader text for icon-only buttons.
Testing Expectations
Unit tests: For business logic, validation, formatters. Use Vitest. Co-located with the code.
Integration tests: For Lambda handlers and API routes. Use AWS SDK mocks (aws-sdk-client-mock). Test against the actual handler entry point.
End-to-end tests: Post-MVP. Playwright for the web flow. One smoke test that walks through the demo wizard.
Test naming: Descriptive. it("rejects service names with uppercase characters"), not it("validates input").
No snapshot tests for non-trivial output. They become noise. Test specific assertions instead.
Coverage: Don't chase a coverage number. Test the things that matter.
Code Generation Patterns
When generating code that will be committed to a user's GitHub repo (the static site starter):

Generated .gitignore must exclude .env, node_modules, build outputs, and credential files
Generated package.json must have pinned dependencies (no ^ or ~ for first commit)
Generated README.md must explain how to deploy, how to run locally, and link back to the Ironforge service detail page
Generated GitHub Actions workflows must use OIDC, never long-lived credentials
No Ironforge internal references leaked into generated code (no internal URLs, no internal user IDs, no API keys)

When To Write An ADR
Architecture Decision Records live in docs/adrs/ and are numbered (001-serverless-first.md, 002-step-functions-orchestration.md).
Write an ADR when:

A non-obvious architectural choice is made
A reasonable alternative was rejected
Future-Ricky might wonder "why did I do it this way?"
The decision is interview-worthy

Don't write ADRs for trivial choices.
Anti-Patterns To Avoid
Things that are tempting but wrong for this project:

Adding RDS "for ease." No. DynamoDB single-table is the right choice. Do not negotiate.
Using ECS or EKS for "production feel." No. Pure serverless. Defend it as the right choice for bursty platform tooling.
Building a generic plugin system before the second template exists. No. YAGNI. Build for the static-site template. When the second template arrives, refactor.
Adding feature flags. No. Single-tenant, single-environment, single-deploy. No flag system needed.
Using CDK instead of Terraform. No. Terraform is the platform engineering standard. CDK signals the wrong thing for this project.
Wrapping everything in a try/catch. No. Let errors propagate. Handle them where you have context to handle them well.
Adding GraphQL. No. REST is fine. GraphQL adds complexity without benefit for this app's access patterns.
Premature optimization. No. Cold starts are fine at portfolio scale. Don't add provisioned concurrency until measured.
Adding a job queue (SQS) for things Step Functions handles. No. Step Functions is the workflow primitive. SQS is for things Step Functions can't do.
Custom logging frameworks. No. Powertools.
Custom auth. No. Cognito.
Server actions vs. API routes religious wars. Use Next.js route handlers (app/api/.../route.ts) where they call Ironforge's API. Server actions for trivial form submissions in pages. Don't agonize.

Anti-Patterns Specific To AI-Assisted Coding
When working with Claude Code, watch for:

Generated code that uses old AWS SDK v2 syntax. This project uses v3 modular SDK exclusively. Reject v2 patterns.
Generated code that imports from aws-sdk (the v2 package). Reject. Use @aws-sdk/client-* packages.
Generated code that uses callbacks for AWS calls. Reject. Use async/await.
Generated code with console.log. Replace with Powertools logger.
Generated code that catches and rethrows errors without adding context. Add context or remove the catch.
Generated code with as any or as unknown as T. Reject. Find the actual type or define one.
Generated code that creates new top-level files. Verify they fit the repository structure. If not, push back.
Generated code that adds dependencies without justification. Each new dependency is a maintenance liability. Justify it.

Documentation Expectations
README.md (root): Project overview, what it is, what it isn't, link to live demo, architecture diagram, tech stack with rationale, local development setup, roadmap, "things I'd do differently."
docs/architecture.md: Detailed architecture with diagrams. Component-by-component breakdown.
docs/threat-model.md: Security posture, attack surface, mitigations, residual risks.
docs/runbook.md: Operational procedures: how to deploy, how to roll back, how to debug a failed provisioning, how to investigate drift.
docs/data-model.md: DynamoDB single-table design, all access patterns, all GSIs.
docs/adrs/: Architecture decision records.
Inline comments: Sparse but meaningful. Explain why, not what. The code shows what.
Working With Claude Code Effectively
When starting a new Claude Code session on Ironforge:

Confirm Claude has read this CLAUDE.md
State what phase the project is in
State what specific task is being worked on
Reference relevant ADRs or docs

When Claude proposes code:

Verify it matches the conventions in this file
Verify it doesn't introduce anti-patterns
Verify imports use the right packages (AWS SDK v3, Hono, etc.)
Verify file placement matches the repo structure
Verify TypeScript strictness is respected

When Claude proposes architectural changes:

Push back if they violate the architectural philosophy
Require ADR-level justification for departures
Don't accept "this is easier" as a reason to violate conventions

What This Project Is Optimizing For
The order of priorities, when they conflict:

Security correctness. Always.
Architectural integrity. The portfolio signal depends on it.
Type safety. Compile-time guarantees.
Operational maturity. Observability, error handling, idempotency.
Code clarity. Future-Ricky should understand it.
Ship velocity. Important but not at the cost of the above.

When Claude Code suggests something that trades off the above for velocity, push back.
Final Note
This document represents the standards Ricky wants to maintain. It's not aspirational — it's required. Code that violates these standards is incorrect, even if it works.
When in doubt, ask. Don't guess.