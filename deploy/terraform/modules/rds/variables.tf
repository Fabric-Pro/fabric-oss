variable "identifier" {
  description = "RDS instance identifier (DNS-safe)"
  type        = string
}

variable "instance_class" {
  description = "DB instance class"
  type        = string
  default     = "db.t4g.micro"
}

variable "allocated_storage" {
  description = "Allocated storage in GiB"
  type        = number
  default     = 20
}

variable "engine_version" {
  description = "Postgres engine version"
  type        = string
  default     = "16.3"
}

variable "vpc_id" {
  description = "VPC ID"
  type        = string
}

variable "subnet_ids" {
  description = "Subnet IDs for the DB subnet group (private subnets)"
  type        = list(string)
}

variable "eks_security_group_id" {
  description = "EKS cluster SG — allowed to connect to Postgres on 5432"
  type        = string
}

variable "kms_key_arn" {
  description = "KMS CMK ARN for storage encryption"
  type        = string
}

variable "skip_final_snapshot" {
  description = "Skip the final snapshot on destroy (true for dev, false for prod)"
  type        = bool
  default     = true
}

variable "multi_az" {
  description = "Deploy the instance across multiple Availability Zones with an automatic standby failover (SOC 2 A1.2 availability). Recommended true for production; default false keeps dev single-AZ and cheaper."
  type        = bool
  default     = false
}

variable "backup_retention_period" {
  description = "Days of automated backups to retain. Production should keep at least 14-30 days (SOC 2 A1.2 / backup policy). RDS caps this at 35."
  type        = number
  default     = 7
}

variable "apply_immediately" {
  description = "Apply instance modifications immediately rather than during the next maintenance window. Keep false in production so changes don't trigger an unplanned restart."
  type        = bool
  default     = true
}

variable "db_name" {
  description = "Initial database name created on the instance"
  type        = string
  default     = "fabric"
}

variable "username" {
  description = "Master username"
  type        = string
  default     = "fabric"
}

variable "tags" {
  description = "Common tags"
  type        = map(string)
  default     = {}
}
