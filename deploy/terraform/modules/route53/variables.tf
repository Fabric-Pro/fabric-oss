variable "domain_name" {
  description = "Domain name to manage (e.g. \"fabric.example.com\"). Empty string skips zone creation."
  type        = string
  default     = ""
}

variable "create_zone" {
  description = "Whether to create the hosted zone (false to use a pre-existing one — pass its zone_id directly in env/dev)"
  type        = bool
  default     = true
}

variable "tags" {
  description = "Common tags"
  type        = map(string)
  default     = {}
}
