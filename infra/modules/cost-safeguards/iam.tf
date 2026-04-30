# IronforgeBudgetActionDeny — Tier-2 circuit breaker IAM policy.
#
# Created here as a managed policy and referenced by aws_budgets_budget_action.
# AWS Budgets attaches it to designated principals when actual spend hits $50;
# AWS Budgets does NOT auto-detach on recovery — manual reversal required via
# `aws budgets execute-budget-action --execution-type REVERSE_BUDGET_ACTION`
# (REVERSE undoes the policy attachment; RESET only returns the action to
# standby and does NOT detach — see docs/cost-safeguards.md § 4).
# Full rationale per statement: see docs/cost-safeguards.md § "The deny policy".

resource "aws_iam_policy" "deny_resource_creation" {
  name        = "IronforgeBudgetActionDeny"
  description = "Tier-2 circuit breaker: deny new resource creation when monthly spend exceeds $50. Attached by AWS Budgets action; manually reversed via `aws budgets execute-budget-action --execution-type REVERSE_BUDGET_ACTION`."
  policy      = data.aws_iam_policy_document.deny_resource_creation.json

  tags = local.component_tags
}

data "aws_iam_policy_document" "deny_resource_creation" {
  # Statement 1 — Block creation of expensive services Ironforge never uses.
  # Rationale: Ironforge is purely serverless. None of these should ever fire.
  statement {
    sid    = "DenyExpensiveServicesIronforgeNeverUses"
    effect = "Deny"
    actions = [
      "ec2:RunInstances",
      "ec2:StartInstances",
      "rds:CreateDBInstance",
      "rds:CreateDBCluster",
      "rds:RestoreDBInstanceFromSnapshot",
      "rds:RestoreDBClusterFromSnapshot",
      "redshift:CreateCluster",
      "redshift:RestoreFromClusterSnapshot",
      "elasticache:CreateCacheCluster",
      "elasticache:CreateReplicationGroup",
      "es:CreateDomain",
      "opensearch:CreateDomain",
      "sagemaker:CreateNotebookInstance",
      "sagemaker:CreateEndpoint",
      "sagemaker:CreateTrainingJob",
      "sagemaker:CreateProcessingJob",
      "sagemaker:CreateTransformJob",
      "emr:RunJobFlow",
      "eks:CreateCluster",
      "eks:CreateNodegroup",
      "ecs:CreateCluster",
      "ecs:RunTask",
      "ecs:CreateService",
      "kafka:CreateClusterV2",
      "kafka:CreateCluster",
      "memorydb:CreateCluster",
      "qldb:CreateLedger",
      "documentdb:CreateDBCluster",
    ]
    resources = ["*"]
  }

  # Statement 2 — Block creation of new Ironforge-style infrastructure.
  # Rationale: stops new provisioning while we investigate. Existing services
  # keep serving; existing Lambdas keep invoking; the portal stays up.
  statement {
    sid    = "DenyCreationOfNewIronforgeInfrastructure"
    effect = "Deny"
    actions = [
      "s3:CreateBucket",
      "cloudfront:CreateDistribution",
      "lambda:CreateFunction",
      "dynamodb:CreateTable",
      "states:CreateStateMachine",
      "apigateway:POST",
      "secretsmanager:CreateSecret",
      "kms:CreateKey",
      "route53:CreateHostedZone",
      "logs:CreateLogGroup",
      "events:PutRule",
    ]
    resources = ["*"]
  }

  # Statement 3 — Block IAM privilege escalation.
  # Rationale: if the runaway is IAM-driven, stop it from making more IAM.
  # iam:UpdateRole stays allowed for response and recovery.
  statement {
    sid    = "DenyIAMPrivilegeEscalation"
    effect = "Deny"
    actions = [
      "iam:CreateUser",
      "iam:CreateRole",
      "iam:CreatePolicy",
      "iam:CreatePolicyVersion",
      "iam:AttachRolePolicy",
      "iam:AttachUserPolicy",
      "iam:PutRolePolicy",
      "iam:PutUserPolicy",
      "iam:CreateLoginProfile",
      "iam:CreateAccessKey",
    ]
    resources = ["*"]
  }
}
