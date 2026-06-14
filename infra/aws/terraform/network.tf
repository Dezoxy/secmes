# --- Network. Mirrors the live VM posture: the instance is reachable ONLY outbound. App ingress rides the
#     Cloudflare Tunnel (cloudflared dials OUT), and deploys ride the AWS control plane (SSM send-command — the
#     SSM agent dials OUT to the SSM endpoints). So the security group allows NO inbound from the internet.
#     A public subnet + an Elastic IP give the box a stable egress address (needed for the Key Vault firewall
#     allow-list); a NAT Gateway (no public IP on the instance) is the pricier hardening upgrade. ---

resource "aws_vpc" "this" {
  # checkov:skip=CKV2_AWS_11: VPC flow logging is an enterprise observability add (needs a log destination + IAM); not warranted for a single-box experiment where all inbound is denied.
  cidr_block           = "10.40.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "${var.prefix}-vpc" }
}

# Lock the VPC's DEFAULT security group: adopt it with NO rules so it denies all traffic (CKV2_AWS_12). The
# instance always uses aws_security_group.instance; this just ensures the unused default SG is inert.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id
  # no ingress/egress blocks → all rules removed → restricts all traffic
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.prefix}-igw" }
}

# One public subnet. The instance needs outbound internet for cloudflared, Key Vault, the Arc endpoints, B2,
# GHCR, and apt; a public subnet + EIP is the cheapest stable-egress option for a single-box experiment.
resource "aws_subnet" "public" {
  vpc_id     = aws_vpc.this.id
  cidr_block = "10.40.0.0/24"
  # Auto-assign a public IP at launch so first-boot cloud-init (apt, Docker/awscli/azcmagent downloads, the
  # azcmagent Arc onboarding) has outbound internet IMMEDIATELY — the Elastic IP is associated only AFTER the
  # instance is created (it depends on the instance id), so without this the box would boot with no egress. The
  # EIP then swaps in as the stable address the Key Vault firewall allow-lists.
  map_public_ip_on_launch = true
  tags                    = { Name = "${var.prefix}-public" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = "${var.prefix}-public-rt" }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# Security group: NO inbound by default (deploys = SSM outbound, ingress = Cloudflare Tunnel outbound). An
# optional break-glass SSH rule opens 22 ONLY to var.admin_cidr if you set it — default null = nothing inbound.
resource "aws_security_group" "instance" {
  name        = "${var.prefix}-sg"
  description = "argus experiment instance — no inbound (SSM + Cloudflare Tunnel are outbound); egress open."
  vpc_id      = aws_vpc.this.id
  tags        = { Name = "${var.prefix}-sg" }
}

# Optional break-glass SSH. Off unless var.admin_cidr is set. Never 0.0.0.0/0.
resource "aws_vpc_security_group_ingress_rule" "ssh" {
  count             = var.admin_cidr == null ? 0 : 1
  security_group_id = aws_security_group.instance.id
  description       = "break-glass SSH (admin CIDR only)"
  cidr_ipv4         = var.admin_cidr
  from_port         = 22
  to_port           = 22
  ip_protocol       = "tcp"
}

# Egress open: cloudflared, Key Vault (vault.azure.net), the Arc endpoints (*.arc.azure.com,
# login.microsoftonline.com, management.azure.com), B2, GHCR, apt all dial out. Tightening egress to prefix
# lists / a firewall is an enterprise follow-up; inbound is denied either way.
resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.instance.id
  description       = "all egress (cloudflared, Key Vault, Arc, B2, GHCR, apt)"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
