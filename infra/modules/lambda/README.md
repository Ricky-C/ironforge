# `infra/modules/lambda` — generic Ironforge Lambda module

Provisions an Ironforge Lambda function with:

- Purpose-specific IAM execution role (per CLAUDE.md "no shared
  `ironforge-lambda-role`").
- `IronforgePermissionBoundary` attached (see ADR-006).
- Inline IAM policy assembled from a structured `iam_grants` input.
- CloudWatch log group with explicit retention (Lambda's auto-created
  group has indefinite retention).
- X-Ray tracing enabled by default (`tracing_mode = "Active"`).
- Source bundle zipped from a build directory at plan time via
  `archive_file`. The source MUST be built before `terraform plan` —
  CI's apply pipeline runs `pnpm -F @ironforge/<service> build` before
  `terraform plan`.

The module does **not** wire upstream invoke triggers (API Gateway
integrations, EventBridge rules, Step Functions tasks). Those live in
the consumer module or the env composition root and reference the
function via `function_invoke_arn` / `function_arn`.

## `iam_grants` conventions

Categories cover common patterns; `extra_statements` is the load-bearing
escape hatch for one-offs. **The rule:** the same shape hitting
`extra_statements` from 3+ Lambdas signals that the shape should be
promoted to a new category. Add the category here, refactor the call
sites in the same PR.

### Currently-implemented categories

| Category          | Actions                                                                                        | Resource shape                                |
| ----------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `dynamodb_read`   | `GetItem`, `Query`, `BatchGetItem`, `DescribeTable`                                            | List of table or `<table>/index/*` ARNs       |
| `dynamodb_write`  | `PutItem`, `UpdateItem`, `DeleteItem`, `BatchWriteItem`                                        | List of table ARNs                            |
| `extra_statements`| Anything not yet promoted to a category                                                        | Raw IAM statement objects                     |

### Adding a new category

When a new category is needed:

1. Add the field to `variable "iam_grants"` in `variables.tf`, with an
   empty default.
2. Add the corresponding `dynamic "statement"` block to
   `data.aws_iam_policy_document.execution_inline` in `main.tf`.
3. Update this README's table.
4. Refactor the call sites that were using `extra_statements` for the
   same shape, in the same PR.

### Example — read-only API Lambda (PR-B.2)

```hcl
module "api_lambda" {
  source = "../../modules/lambda"

  function_name = "ironforge-dev-api"
  environment   = "dev"

  permission_boundary_arn = data.terraform_remote_state.shared.outputs.permission_boundary_arn

  source_dir = "${path.root}/../../../services/api/dist"
  handler    = "handler.handler"

  environment_variables = {
    DYNAMODB_TABLE_NAME    = module.dynamodb.table_name
    IRONFORGE_ENV          = var.environment
    POWERTOOLS_SERVICE_NAME = "ironforge-api"
    LOG_LEVEL              = "INFO"
  }

  iam_grants = {
    dynamodb_read = [
      module.dynamodb.table_arn,
      "${module.dynamodb.table_arn}/index/*",
    ]
  }
}
```

### Example — escape hatch via `extra_statements`

When a Lambda needs a grant shape not yet covered by a category, use
`extra_statements`. Document **why** the shape isn't a category yet —
it's a future refactor signal.

```hcl
iam_grants = {
  extra_statements = [
    {
      sid       = "AllowSecretsManagerGetForGithubApp"
      actions   = ["secretsmanager:GetSecretValue"]
      resources = [data.terraform_remote_state.shared.outputs.github_app_secret_arn]
    },
    {
      sid       = "AllowKMSDecryptForGithubAppEncryptionContext"
      actions   = ["kms:Decrypt"]
      resources = [data.terraform_remote_state.shared.outputs.github_app_kms_key_arn]
      conditions = [
        {
          test     = "StringEquals"
          variable = "kms:EncryptionContext:SecretARN"
          values   = [data.terraform_remote_state.shared.outputs.github_app_secret_arn]
        }
      ]
    },
  ]
}
```

If the same `secretsmanager:GetSecretValue` + `kms:Decrypt + EncryptionContext`
pattern appears in 3+ Lambdas, promote it to a `secrets_read_with_kms`
category.

## Naming conventions

- `function_name` MUST start with `ironforge-` (validated). Per-env
  Lambdas should follow `ironforge-<env>-<purpose>` (e.g.,
  `ironforge-dev-api`).
- Execution role name is derived: `<function_name>-execution`.
- Inline policy name is derived: `<function_name>-inline`.
- Log group name is derived: `/aws/lambda/<function_name>`.

## Sizing defaults

- `runtime = "nodejs22.x"` (matches root `engines.node: ">=22.0.0"`).
- `architecture = "arm64"` (Graviton; cheaper, slightly faster cold
  starts on Node).
- `memory_mb = 256` (enough for Hono + AWS SDK v3 read handlers; bump
  only when measured cold-start latency justifies it).
- `timeout_seconds = 10` (API Gateway HTTP API integration timeout is
  30s; Lambda fails first).
- `log_retention_days = 14` (cost-leaning; bump for compliance or
  active investigation).
- `tracing_mode = "Active"` (X-Ray sampling on every invocation).
- `reserved_concurrent_executions = null` (per CLAUDE.md anti-pattern
  guard against premature optimization).

Override only with measured justification.

## Source bundle expectations

The module zips `var.source_dir` via `archive_file` at plan time. The
directory must contain the bundled handler in a form Lambda's runtime
can load — for Node.js ESM, that means at minimum:

- `<source_dir>/handler.js` — bundled handler exporting the symbol
  named in `var.handler` (default `handler`).
- `<source_dir>/package.json` with `"type": "module"` (so Node treats
  `.js` as ESM).

esbuild's `bundle: true, format: "esm", platform: "node"` produces this
shape. The `services/api/build.mjs` script is the reference
implementation.

## Related

- ADR-006 — IronforgePermissionBoundary design rationale.
- `infra/modules/lambda-baseline` — provides the boundary policy that
  this module's roles attach.
- CLAUDE.md § AWS Resource Conventions, § TypeScript Conventions.
