variable "terraform_version" {
  description = "Pinned Terraform version baked into the image. MUST match build-image.sh's constant — the variable is for documentation/output; the build script's constant is the truth."
  type        = string
  default     = "1.10.4"
}

variable "aws_provider_version" {
  description = "Pinned AWS provider version baked into the image. MUST match build-image.sh AND fall within every consuming template's required_providers AWS constraint."
  type        = string
  default     = "5.83.0"
}

variable "image_retention_count" {
  description = "Number of recent images to retain in ECR. Older images expire via the lifecycle policy. Lower bound for rollback (need at least N-1 prior images to roll back to). Higher bound for storage cost (negligible at 200MB/image at low N)."
  type        = number
  default     = 10

  validation {
    condition     = var.image_retention_count >= 3
    error_message = "image_retention_count must be at least 3 — single-image retention prevents rollback entirely; 2 prevents rolling back further than the immediately-prior version."
  }
}
