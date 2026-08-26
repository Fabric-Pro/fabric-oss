variable "repository_names" {
  description = "ECR repository names (e.g. [\"fabric-web\", \"fabric-temporal-worker\", ...])"
  type        = list(string)
}

variable "kms_key_arn" {
  description = "KMS CMK ARN for image encryption"
  type        = string
}

variable "force_delete" {
  description = "Allow `terraform destroy` to delete repos with images (true for dev)"
  type        = bool
  default     = true
}

variable "lifecycle_keep_count" {
  description = "How many most-recent images to keep (older expire)"
  type        = number
  default     = 10
}

variable "tags" {
  description = "Common tags"
  type        = map(string)
  default     = {}
}
