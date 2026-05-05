variable "image_retention_count" {
  description = "Number of most recent ECR images to retain. Older images are expired by the lifecycle policy. Default 10 gives ~10 days of rollback at 1 deploy/day."
  type        = number
  default     = 10

  validation {
    condition     = var.image_retention_count >= 1 && var.image_retention_count <= 100
    error_message = "image_retention_count must be between 1 and 100."
  }
}

variable "permissions_boundary_arn" {
  description = "ARN of the IAM permissions boundary attached to the portal Lambda execution role. Required by lambda-baseline's enforcement: every Ironforge Lambda role carries this boundary as a hard cap on identity-policy widening."
  type        = string
}
