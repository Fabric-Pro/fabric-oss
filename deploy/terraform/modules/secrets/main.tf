terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.50" }
  }
}

resource "aws_secretsmanager_secret" "this" {
  for_each = toset(var.secret_groups)

  name                    = "fabric/${var.environment}/${each.value}"
  kms_key_id              = var.kms_key_arn
  recovery_window_in_days = var.recovery_window_in_days

  tags = merge(var.tags, {
    Environment = var.environment
    Group       = each.value
  })
}

# Initial empty JSON content. User populates via:
#   aws secretsmanager put-secret-value --secret-id fabric/dev/<group> --secret-string '{...}'
# (Except database — that's populated automatically by env/dev wiring from RDS outputs.)
resource "aws_secretsmanager_secret_version" "initial" {
  for_each = aws_secretsmanager_secret.this

  secret_id     = each.value.id
  secret_string = "{}"

  lifecycle {
    # Future updates to the secret value (via CLI / console) should NOT be overwritten
    # by terraform apply. The initial empty {} is set once, then ignored.
    ignore_changes = [secret_string]
  }
}
