locals {
  table_name = "ironforge-${var.environment}"

  component_tags = {
    "ironforge-component" = "data"
  }
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

  # AWS-managed encryption (alias/aws/dynamodb). Per ADR-003, CMK is reserved
  # for content with specific access-control or compliance needs. Single-tenant
  # operational data accessed only by Ironforge IAM principals doesn't qualify.
  server_side_encryption {
    enabled = true
  }

  deletion_protection_enabled = true

  tags = merge(local.component_tags, {
    Name = local.table_name
  })
}
