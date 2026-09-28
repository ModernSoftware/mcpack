variable "region" {
  type = string
}

variable "name" {
  type    = string
  default = "mcpack-support-desk"
  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{2,24}$", var.name))
    error_message = "Use 3-25 lowercase letters/digits/hyphens."
  }
}

variable "hostname" {
  type = string
  validation {
    condition     = can(regex("^[a-z0-9.-]+\\.[a-z]{2,}$", var.hostname))
    error_message = "Supply the public DNS hostname covered by the certificate."
  }
}

variable "certificate_arn" {
  type        = string
  description = "An ISSUED ACM certificate in this region covering hostname."
}

variable "zone_id" {
  type        = string
  default     = ""
  description = "Optional Route53 zone; otherwise create the DNS alias yourself."
}

variable "allowed_client_cidrs" {
  type        = list(string)
  description = "Public client egress CIDRs allowed to reach HTTPS, typically your IP/32."
  validation {
    condition     = length(var.allowed_client_cidrs) > 0 && alltrue([for c in var.allowed_client_cidrs : can(cidrnetmask(c))])
    error_message = "Supply at least one valid IPv4 CIDR."
  }
}

variable "container_image" {
  type = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.container_image))
    error_message = "Deploy the ECR image by immutable digest, not a tag."
  }
}

variable "start_services" {
  type        = bool
  default     = false
  description = "Set true only after the one-off seed task succeeds."
}

variable "replicas" {
  type    = number
  default = 1
  validation {
    condition     = contains([1, 2, 3], var.replicas)
    error_message = "Use 1-3 replicas for this PoC."
  }
}

variable "allow_destroy_data" {
  type        = bool
  default     = false
  description = "Explicitly allow RDS/S3 destruction for this synthetic environment."
}
