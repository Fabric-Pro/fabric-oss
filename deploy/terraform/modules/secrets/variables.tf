variable "environment" {
  description = "Environment name (e.g. \"dev\", \"prod\") — used in secret paths fabric/<env>/<group>"
  type        = string
}

variable "kms_key_arn" {
  description = "KMS CMK ARN for secret encryption"
  type        = string
}

variable "secret_groups" {
  description = "Logical secret group names — each becomes fabric/<env>/<group>"
  type        = list(string)
  default = [
    "database",
    # Dedicated BYPASSRLS worker-role credentials (WORKER_DATABASE_URL +
    # WORKER_DB_PASSWORD). Kept separate from `database` so the migrate hook can
    # pull the worker password without its DATABASE_URL colliding with the
    # privileged app DATABASE_URL. Populated only where the worker bypass is used.
    "database-worker",
    "auth",
    "ai-providers",
    "oauth",
    "integrations",
    "redis",
    "temporal",
    "cloudflare",
    "storage",
    "email",
    "payments",
    "qdrant",
    "agents",
    "upstash",
    "databricks",
  ]
}

variable "recovery_window_in_days" {
  description = "Recovery window after deletion (0 = immediate delete for dev; minimum 7 for prod)"
  type        = number
  default     = 0
}

variable "tags" {
  description = "Common tags"
  type        = map(string)
  default     = {}
}
