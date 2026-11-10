variable "region" {
  description = "AWS region. ap-south-1 (Mumbai) keeps the data in India (DPDP)."
  type        = string
  default     = "ap-south-1"
}

# ------------------------------------------------------------------ naming and DNS
variable "zone_name" {
  description = "Subdomain delegated to Route 53. The site is served at this name, the API at api.<zone_name>."
  type        = string
  default     = "dawai.rasuonline.in"
}

variable "acme_email" {
  description = "Contact e-mail for Let's Encrypt (Caddy)."
  type        = string
}

variable "alarm_email" {
  description = "Receives CloudWatch alarms and budget alerts. AWS sends a confirmation mail you must click."
  type        = string
}

# ------------------------------------------------------------------ compute
variable "architecture" {
  description = "CPU architecture of the instance AND of the images: x86_64 (default) or arm64 (Graviton, t4g). Must match the instance type and the repository variable TARGET_PLATFORM (linux/amd64 or linux/arm64)."
  type        = string
  default     = "x86_64"
  validation {
    condition     = contains(["x86_64", "arm64"], var.architecture)
    error_message = "architecture must be x86_64 or arm64."
  }
}

variable "instance_type" {
  description = <<-EOT
    t3.medium   (2 vCPU, 4 GB, x86)       default: demo mode, about $0.045/h. Needs the 2 GB swap.
    t4g.medium  (2 vCPU, 4 GB, Graviton)  about 20% cheaper, but Mumbai had no capacity on 2026-11-10 (set architecture = "arm64").
    t3.large / t4g.large (8 GB)           comfortable, about twice the price.
  EOT
  type        = string
  default     = "t3.medium"
}

variable "az_index" {
  description = "Which availability zone of the region to use (0 = a, 1 = b, 2 = c). Change it when AWS reports InsufficientInstanceCapacity for the instance type."
  type        = number
  default     = 2
}

variable "root_volume_gb" {
  description = "Encrypted gp3 root volume: OS, Docker images, Postgres and Redis data. It is billed even while the instance is stopped."
  type        = number
  default     = 20
}

variable "swap_gb" {
  type    = number
  default = 2
}

variable "max_uptime_minutes" {
  description = "Every boot schedules a shutdown after this long (cost guard). `extend-uptime.sh` pushes it out."
  type        = number
  default     = 280
}

# ------------------------------------------------------------------ cost guard
variable "monthly_budget_usd" {
  description = "AWS Budget limit (account-wide cost, whole month)."
  type        = number
  default     = 20
}

variable "budget_stop_usd" {
  description = "When ACTUAL spend passes this, a Budget Action STOPS the instance (Budgets data lags by up to ~a day, so keep a margin below the limit)."
  type        = number
  default     = 8
}

# ------------------------------------------------------------------ data
variable "media_retention_days" {
  description = "Same value as MEDIA_RETENTION_DAYS in the app: media/ objects expire after this many days."
  type        = number
  default     = 30
}

variable "log_retention_days" {
  type    = number
  default = 30
}

variable "ecr_keep_images" {
  description = "Images kept per ECR repository (ECR charges per GB-month; the AI image is about 1 GB)."
  type        = number
  default     = 5
}

variable "force_destroy" {
  description = "true lets `terraform destroy` delete NON-EMPTY buckets and ECR repos (all media and backups!). Leave false until you really want everything gone."
  type        = bool
  default     = false
}

# ------------------------------------------------------------------ CI
variable "github_repo" {
  description = "owner/name of the GitHub repository allowed to deploy through OIDC, e.g. sachin/dawai-saathi."
  type        = string
}
