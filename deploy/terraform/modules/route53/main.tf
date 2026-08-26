terraform {
  required_version = ">= 1.7.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.50" }
  }
}

resource "aws_route53_zone" "this" {
  count = var.create_zone && var.domain_name != "" ? 1 : 0

  name = var.domain_name
  tags = var.tags
}
