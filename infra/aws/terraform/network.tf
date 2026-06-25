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
# nosemgrep: terraform.aws.security.aws-subnet-has-public-ip-address.aws-subnet-has-public-ip-address
resource "aws_subnet" "public" {
  # checkov:skip=CKV_AWS_130: the auto-assigned public IP is EGRESS-ONLY (the security group denies ALL inbound) and is required for first-boot provisioning before the Elastic IP associates; a NAT Gateway (no public IP) is the cost upgrade. Mirrors the live Azure VM's egress-only public IP.
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
  description = "argus experiment instance - no inbound (SSM + Cloudflare Tunnel are outbound); egress open."
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

# --- TURN relay ingress (VoIP V1, PR 5/14) ---
# coturn needs direct internet access on three port bands. Source is 0.0.0.0/0: TURN peers are
# arbitrary internet clients; no source restriction is possible.
# The HTTP/WS origin (Caddy/api) remains tunnel-only — no HTTP/HTTPS inbound rule is added here.
# IPv4-only: this VPC has no IPv6 CIDR, no IPv6 subnet, and no ::/0 route — adding ::/0 SG rules
# without the underlying network plumbing is a no-op. IPv6 TURN support requires VPC redesign
# (aws_vpc ipv6_cidr_block, subnet ipv6_cidr_block, route ::/0 → igw + instance IPv6 assignment).
# See docs/threat-models/voip-turn.md §Threat — Spoofing the origin.
resource "aws_vpc_security_group_ingress_rule" "turn_3478_udp" {
  security_group_id = aws_security_group.instance.id
  description       = "STUN/TURN UDP 3478 (coturn)"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 3478
  to_port           = 3478
  ip_protocol       = "udp"
}

resource "aws_vpc_security_group_ingress_rule" "turn_3478_tcp" {
  security_group_id = aws_security_group.instance.id
  description       = "STUN/TURN TCP 3478 (coturn - TCP fallback)"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 3478
  to_port           = 3478
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "turns_5349_udp" {
  security_group_id = aws_security_group.instance.id
  description       = "TURNS UDP 5349 (coturn TLS - captive-portal path)"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 5349
  to_port           = 5349
  ip_protocol       = "udp"
}

resource "aws_vpc_security_group_ingress_rule" "turns_5349_tcp" {
  security_group_id = aws_security_group.instance.id
  description       = "TURNS TCP 5349 (coturn TLS)"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 5349
  to_port           = 5349
  ip_protocol       = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "turn_relay_udp" {
  security_group_id = aws_security_group.instance.id
  description       = "TURN relay range UDP 49160-49260 (coturn media relay allocation)"
  cidr_ipv4         = "0.0.0.0/0"
  from_port         = 49160
  to_port           = 49260
  ip_protocol       = "udp"
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
