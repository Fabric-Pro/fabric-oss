variable "key_aliases" {
  description = "List of logical alias names to create CMKs for (e.g. [\"eks\", \"rds\", \"s3\", \"secrets\", \"ecr\"])"
  type        = list(string)
}

variable "tags" {
  description = "Common tags"
  type        = map(string)
  default     = {}
}
