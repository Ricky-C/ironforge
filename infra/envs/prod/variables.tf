variable "environment" {
  description = "Deployment environment. Locked to dev or prod."
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be one of: dev, prod."
  }
}

variable "aws_region" {
  description = "AWS region. CloudFront wildcard certs require us-east-1, so we lock everything there."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = var.aws_region == "us-east-1"
    error_message = "Ironforge runs in us-east-1 only."
  }
}
