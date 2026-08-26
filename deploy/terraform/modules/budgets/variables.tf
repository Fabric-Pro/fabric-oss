variable "email" {
  description = "Email to receive budget alerts (also receives near-threshold + over-threshold notifications)"
  type        = string
}

variable "thresholds" {
  description = "USD thresholds — one Budget created per threshold"
  type        = list(number)
  default     = [50, 100, 200]
}

variable "tags" {
  description = "Common tags"
  type        = map(string)
  default     = {}
}
