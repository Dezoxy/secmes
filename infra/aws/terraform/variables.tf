# --- AWS (compute) ---

variable "aws_region" {
  type        = string
  default     = "eu-central-1"
  description = "AWS region. EU data residency: eu-central-1 (Frankfurt) is the parity region for the live germanywestcentral stack + the B2 eu-central buckets."
}

variable "prefix" {
  type        = string
  default     = "argus-exp"
  description = "Name prefix for all experiment resources (kept distinct from the live `argus` stack)."
}

variable "instance_type" {
  type        = string
  default     = "t3.medium"
  description = "EC2 instance type. t3.medium = 2 vCPU / 4 GiB — the lean start for the core+observability stack (a 2 GiB swapfile gives headroom). Upgrade to t3.large (8 GiB) if memory-tight: a 2-min stop -> change type -> start, no rebuild, EIP preserved."
}

variable "root_volume_gb" {
  type        = number
  default     = 30
  description = "EBS gp3 root volume size (GiB). Holds the OS + Docker images/volumes + the (empty) experiment DB; no separate data volume for the experiment. Prod re-adds a dedicated data disk."
}

variable "instance_ami" {
  type        = string
  default     = null
  description = "Optional explicit AMI id. Leave null to auto-resolve the latest Canonical Ubuntu 24.04 LTS (amd64) for var.aws_region (see data.aws_ami in ec2.tf)."
}

variable "admin_cidr" {
  type        = string
  default     = null
  description = "Optional CIDR for a break-glass inbound SSH rule (port 22). Leave null (default) for NO inbound at all — deploys ride SSM, ingress rides the Cloudflare Tunnel. Set to your /32 only if you must SSH in for debugging."
}

# --- GitHub OIDC (CD via SSM) ---

variable "github_owner" {
  type        = string
  default     = "Dezoxy"
  description = "GitHub org/user that owns the repo (for the AWS IAM OIDC federated-credential subject)."
}

variable "github_repo" {
  type        = string
  default     = "secmes"
  description = "GitHub repository name (for the AWS IAM OIDC federated-credential subject)."
}

variable "github_deploy_environment" {
  type        = string
  default     = "aws-experiment"
  description = "GitHub Environment the deploy job runs in. The IAM deploy role trusts the OIDC subject `repo:OWNER/REPO:environment:<this>` ONLY — bind the cd-aws.yml deploy job to this same environment (with required reviewers) so a tagged release pauses for your approval before SSM runs anything as root."
}

variable "create_github_oidc_provider" {
  type        = bool
  default     = true
  description = "Create the GitHub Actions IAM OIDC provider. Set false if one already exists in the account (only one per URL is allowed) and import/reference it instead."
}

# --- Azure (experiment Key Vault + Arc onboarding) ---

variable "azure_subscription_id" {
  type        = string
  description = "Azure subscription ID that holds the experiment Key Vault + the Arc machine projection."
}

variable "azure_location" {
  type        = string
  default     = "germanywestcentral"
  description = "Azure region for the experiment Key Vault + the Arc machine ARM resource. Keep the Arc projection in the EU even though the machine runs in AWS."
}

variable "azure_admin_object_id" {
  type        = string
  default     = null
  description = "Optional Entra object ID (you) granted Key Vault Secrets Officer on the experiment vault, so Terraform/you can seed + rotate the dummy secrets. Leave null to manage them another way."
}

variable "seed_admin_ip" {
  type        = string
  default     = null
  description = "Optional public IP/CIDR of the apply principal (your laptop), allowed through the experiment Key Vault firewall so the first `terraform apply` can seed the dummy secrets. Leave null if you seed from a host that egresses via the EC2 EIP, or add your IP to the vault manually."
}

variable "seed_dummy_secrets" {
  type        = bool
  default     = true
  description = "Seed the experiment Key Vault with DUMMY values for the mandatory secret names the stack expects, so the experiment runs end-to-end without real secrets. Requires azure_admin_object_id (the apply principal needs Secrets Officer). NEVER point this module at real secrets."
}

variable "arc_machine_connected" {
  type        = bool
  default     = false
  description = "Two-phase apply flag. Leave FALSE for the first apply (the Arc machine + its managed identity do not exist until the EC2 box runs `azcmagent connect` at boot). After the instance shows Connected in Azure Arc, set TRUE and re-apply to grant that machine's managed identity `Key Vault Secrets User` on the experiment vault (see arc.tf)."
}

variable "tags" {
  type = map(string)
  default = {
    project = "argus"
    managed = "terraform"
    stack   = "aws-experiment"
  }
  description = "Tags applied to all resources (AWS default_tags + Azure resource tags)."
}
