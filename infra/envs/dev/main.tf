# Dev environment composition root.

module "dynamodb" {
  source = "../../modules/dynamodb"

  environment = var.environment
}
