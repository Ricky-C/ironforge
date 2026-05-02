output "repository_url" {
  description = "ECR repository URL (registry/name). Used by build-image.sh as the docker push target. Lambda image_uri references this URL plus an image digest."
  value       = aws_ecr_repository.run_terraform.repository_url
}

output "repository_arn" {
  description = "ECR repository ARN. Build pipeline IAM grants for ecr:GetAuthorizationToken / PutImage / etc. scope to this ARN."
  value       = aws_ecr_repository.run_terraform.arn
}

output "repository_name" {
  description = "ECR repository name (without registry prefix). Used in lifecycle policies and IAM ARN construction."
  value       = aws_ecr_repository.run_terraform.name
}

output "terraform_version" {
  description = "Pinned Terraform binary version baked into the image. Useful for ops scripts and documentation."
  value       = var.terraform_version
}

output "aws_provider_version" {
  description = "Pinned AWS provider version baked into the image. Templates' required_providers constraints must accept this version."
  value       = var.aws_provider_version
}
