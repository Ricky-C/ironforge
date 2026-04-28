variable "environment" {
  description = "Deployment environment (dev or prod). Used in resource names and tags."
  type        = string

  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "environment must be one of: dev, prod."
  }
}
