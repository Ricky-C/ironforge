output "boundary_policy_arn" {
  description = "ARN of the IronforgePermissionBoundary policy. Pass to Lambda-creating modules via their permissions_boundary_arn variable to apply the boundary."
  value       = aws_iam_policy.permission_boundary.arn
}

output "boundary_policy_name" {
  description = "Name of the IronforgePermissionBoundary policy."
  value       = aws_iam_policy.permission_boundary.name
}
