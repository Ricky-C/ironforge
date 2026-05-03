variable "function_name" {
  description = "Lambda function name. MUST start with `ironforge-` per the AWS resource naming convention (CLAUDE.md § AWS Resource Conventions). Per-env Lambdas should follow the `ironforge-<env>-<purpose>` pattern (e.g., `ironforge-dev-api`)."
  type        = string

  validation {
    condition     = startswith(var.function_name, "ironforge-")
    error_message = "function_name must start with `ironforge-` per the AWS resource naming convention."
  }
}

variable "environment" {
  description = "Deployment environment (`dev`, `prod`, or `shared`). Drives the `ironforge-environment` tag and is referenced by inline policy comments and downstream debugging."
  type        = string

  validation {
    condition     = contains(["dev", "prod", "shared"], var.environment)
    error_message = "environment must be one of: dev, prod, shared."
  }
}

variable "permission_boundary_arn" {
  description = "ARN of the IronforgePermissionBoundary. Pulled from the shared composition's remote state by the env composition (see ADR-006)."
  type        = string
}

variable "source_dir" {
  description = "Absolute path to the directory containing the Lambda source bundle (e.g., $${path.root}/../../../services/api/dist). The directory is zipped via the archive_file data source at plan time. The source MUST be built before `terraform plan` runs (CI: `pnpm -F @ironforge/<service> build` precedes `terraform plan`). Required when package_type = \"Zip\"; ignored when package_type = \"Image\"."
  type        = string
  default     = null
}

variable "package_type" {
  description = "Lambda deployment package type. \"Zip\" (default) bundles source via archive_file; \"Image\" deploys a container image referenced by image_uri. Image deployment is required when bundled binary tooling exceeds Lambda layer limits (per ADR-009 § Amendments — run-terraform Lambda)."
  type        = string
  default     = "Zip"

  validation {
    condition     = contains(["Zip", "Image"], var.package_type)
    error_message = "package_type must be one of: Zip, Image."
  }
}

variable "image_uri" {
  description = "Container image URI (registry/repo@sha256:digest). Required when package_type = \"Image\"; ignored when Zip. Use immutable digest references — mutable tags break deploy reproducibility."
  type        = string
  default     = null
}

variable "handler" {
  description = "Lambda handler entrypoint, formatted as `<file>.<exported-symbol>`. For ESM bundles, the file name is the bundle output filename without extension, and the symbol is the exported handler. Example: `handler.handler` for `dist/handler.js` exporting `handler`."
  type        = string
  default     = "handler.handler"
}

variable "runtime" {
  description = "Lambda runtime. Defaults to nodejs22.x to match the repo root's engines.node `>=22.0.0` constraint."
  type        = string
  default     = "nodejs22.x"
}

variable "architecture" {
  description = "Lambda architecture. Defaults to arm64 (Graviton) — cheaper and slightly faster cold starts than x86_64 for Node.js workloads at this scale."
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["arm64", "x86_64"], var.architecture)
    error_message = "architecture must be one of: arm64, x86_64."
  }
}

variable "memory_mb" {
  description = "Lambda memory allocation in MB. Lambda CPU scales with memory; tune based on measured cold-start and execution latency, not vibes."
  type        = number
  default     = 256
}

variable "timeout_seconds" {
  description = "Lambda execution timeout. Should be strictly less than the upstream API Gateway integration timeout (HTTP API max is 30s) so the function fails before the API."
  type        = number
  default     = 10
}

variable "log_retention_days" {
  description = "CloudWatch log group retention for the Lambda's execution logs. 14 days is the cost-leaning default; bump for compliance or investigation needs."
  type        = number
  default     = 14
}

variable "environment_variables" {
  description = "Map of environment variables to set on the function. Never put secrets here — use Secrets Manager + a runtime fetch with kms:Decrypt scoped via EncryptionContext."
  type        = map(string)
  default     = {}
}

variable "iam_grants" {
  description = <<-EOT
    Structured grants applied to the Lambda's execution role's inline policy. Categories cover common patterns; `extra_statements` is the escape hatch for one-offs. See README.md § "iam_grants conventions" for the rule that 3+ Lambdas hitting `extra_statements` for the same shape should promote to a new category.

    Currently-implemented categories:
      - dynamodb_read:    list of table or index ARNs to grant GetItem/Query/BatchGetItem/DescribeTable on.
      - dynamodb_write:   list of table or index ARNs to grant PutItem/UpdateItem/DeleteItem/BatchWriteItem on.
      - extra_statements: list of raw IAM statement objects, each with `sid`, `actions`, `resources`, optional `effect` (default Allow), optional `conditions` (list of `{test, variable, values}`).

    Every category default is empty; passing nothing produces a Lambda role with only the AWSLambdaBasicExecutionRole-equivalent CloudWatch perms (covered by the boundary's `AllowLogsForIronforgeLambdas` statement).
  EOT
  type = object({
    dynamodb_read  = optional(list(string), [])
    dynamodb_write = optional(list(string), [])
    extra_statements = optional(list(object({
      sid       = string
      effect    = optional(string, "Allow")
      actions   = list(string)
      resources = list(string)
      conditions = optional(list(object({
        test     = string
        variable = string
        values   = list(string)
      })), [])
    })), [])
  })
  default = {}
}

variable "tracing_mode" {
  description = "X-Ray tracing mode. `Active` enables sampling on every invocation; `PassThrough` honors upstream trace decisions only. Boundary already permits xray:PutTraceSegments/PutTelemetryRecords account-wide."
  type        = string
  default     = "Active"

  validation {
    condition     = contains(["Active", "PassThrough"], var.tracing_mode)
    error_message = "tracing_mode must be one of: Active, PassThrough."
  }
}

variable "reserved_concurrent_executions" {
  description = "Reserved concurrent executions, or null for unreserved. Per CLAUDE.md anti-patterns: do not set provisioned concurrency without measured cold-start data justifying it."
  type        = number
  default     = null
}
