locals {
  table_name = "ironforge-${var.environment}"
  kms_alias  = "alias/ironforge-dynamodb-${var.environment}"

  component_tags = {
    "ironforge-component" = "data"
  }
}

resource "aws_kms_key" "this" {
  description             = "Encryption key for the Ironforge DynamoDB table (${var.environment})"
  enable_key_rotation     = true
  deletion_window_in_days = 30

  tags = local.component_tags
}

resource "aws_kms_alias" "this" {
  name          = local.kms_alias
  target_key_id = aws_kms_key.this.key_id
}

resource "aws_dynamodb_table" "ironforge" {
  name         = local.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  attribute {
    name = "GSI1PK"
    type = "S"
  }

  attribute {
    name = "GSI1SK"
    type = "S"
  }

  global_secondary_index {
    name            = "GSI1"
    hash_key        = "GSI1PK"
    range_key       = "GSI1SK"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled     = true
    kms_key_arn = aws_kms_key.this.arn
  }

  deletion_protection_enabled = true

  tags = merge(local.component_tags, {
    Name = local.table_name
  })
}
