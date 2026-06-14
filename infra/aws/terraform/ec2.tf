# Latest Canonical Ubuntu 24.04 LTS (amd64) for the region, unless var.instance_ami pins one.
data "aws_ami" "ubuntu" {
  count       = var.instance_ami == null ? 1 : 0
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

locals {
  ami_id = var.instance_ami != null ? var.instance_ami : data.aws_ami.ubuntu[0].id
}

# The experiment box. Single instance, single root volume, IMDSv2 enforced. First-boot provisioning (Docker,
# the Arc agent + `azcmagent connect`, the swapfile, the secret-fetch unit) is in cloud-init.yaml — the AWS
# port of infra/azure/terraform/cloud-init.yaml.
resource "aws_instance" "this" {
  # checkov:skip=CKV_AWS_126: detailed (1-min) CloudWatch monitoring is a paid add; basic 5-min monitoring is enough for one experiment box.
  ami                    = local.ami_id
  instance_type          = var.instance_type
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.instance.id]
  iam_instance_profile   = aws_iam_instance_profile.instance.name
  ebs_optimized          = true # t3 is EBS-optimized by default; set explicit for CKV_AWS_135

  # IMDSv2 REQUIRED: token-gated metadata, hop-limit 1 so a container/SSRF can't reach the instance role's
  # credentials. The AWS equivalent of "IMDS is link-local, on-box only".
  metadata_options {
    http_tokens                 = "required"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    volume_type           = "gp3"
    volume_size           = var.root_volume_gb
    encrypted             = true # EBS encryption at rest (defense-in-depth; this box holds the experiment DB)
    delete_on_termination = true
  }

  # Re-render user-data when the Arc onboarding inputs change so a replaced instance re-onboards correctly.
  user_data = templatefile("${path.module}/cloud-init.yaml", {
    arc_tenant_id        = data.azuread_client_config.current.tenant_id
    arc_subscription_id  = var.azure_subscription_id
    arc_resource_group   = azurerm_resource_group.exp.name
    arc_location         = var.azure_location
    arc_sp_app_id        = azuread_application.arc_onboarding.client_id
    arc_onboarding_param = aws_ssm_parameter.arc_onboarding_secret.name
    arc_machine_name     = "${var.prefix}-ec2"
    aws_region           = var.aws_region
  })

  # IMDSv2 + a change to user_data shouldn't silently leave a stale box; but DON'T auto-replace on AMI bumps
  # (a new Canonical release id) — that would terminate the experiment on every `apply`. Pin via var.instance_ami
  # if you want fully deterministic replacement behavior.
  lifecycle {
    ignore_changes = [ami]
  }

  # Don't boot until the Arc onboarding SP can actually onboard: the role assignment must exist before
  # cloud-init runs `azcmagent connect`, or a fresh apply races (box boots → connect → SP has no role → fails).
  # (The onboarding secret in SSM is already an implicit dep via the user_data templatefile ref. The phase-2
  # Key Vault grant to the Arc machine identity necessarily comes AFTER boot — the machine identity doesn't
  # exist until onboarding — and the secret fetch only runs later at deploy, so that ordering is by design.)
  depends_on = [azurerm_role_assignment.arc_onboarding]

  tags = { Name = "${var.prefix}-ec2" }
}

# Stable egress IP: needed for the Key Vault firewall allow-list (keyvault.tf references this) and so a
# stop/start keeps the same address. ~$3.60/mo for the public IPv4 (no longer free as of 2024).
resource "aws_eip" "this" {
  instance   = aws_instance.this.id
  domain     = "vpc"
  tags       = { Name = "${var.prefix}-eip" }
  depends_on = [aws_internet_gateway.this]
}
