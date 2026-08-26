variable "bucket_names" {
  description = "Logical bucket names (will be prefixed for global uniqueness)"
  type        = list(string)
  default = [
    "avatars",
    "chat-documents",
    "project-contexts",
    "workspace-documents",
    "orchestrator-artifacts",
    "skills",
    "project-document-assets",
  ]
}

variable "bucket_prefix" {
  description = "Prefix to guarantee global S3 namespace uniqueness, e.g. \"fabric-dev-12345678\""
  type        = string
}

variable "environment" {
  description = "Environment label (used in tags only here; uniqueness comes from bucket_prefix)"
  type        = string
}

variable "kms_key_arn" {
  description = "KMS CMK ARN for SSE-KMS"
  type        = string
}

variable "force_destroy" {
  description = "Allow `terraform destroy` to delete buckets with objects (true for dev)"
  type        = bool
  default     = true
}

variable "allowed_origins" {
  description = "CORS allowed origins (defaults to localhost; override for prod)"
  type        = list(string)
  default     = ["http://localhost:3000", "http://localhost:3001"]
}

variable "tags" {
  description = "Common tags"
  type        = map(string)
  default     = {}
}
