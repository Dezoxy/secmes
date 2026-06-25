data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

# ============================================================================================================
# Instance role — what the EC2 box itself may do. AWS's no-static-credential equivalent of an Azure Managed
# Identity: the instance assumes this role via IMDSv2, never holding a long-lived AWS key. It may (a) talk to
# the SSM control plane (so CD can run commands on it), and (b) read the ONE Arc onboarding secret it needs at
# boot. Nothing else. The real app secrets are NOT here — they live in Azure Key Vault, read via the Arc
# managed identity (see arc.tf + the secret-fetch script).
# ============================================================================================================
resource "aws_iam_role" "instance" {
  name = "${var.prefix}-instance"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = { Name = "${var.prefix}-instance" }
}

# SSM agent control channel (the deploy path). AWS-managed least-privilege policy for SSM-managed instances.
resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.instance.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Read ONLY the Arc onboarding secret (the SP client secret used once by `azcmagent connect`) + decrypt it.
# kms:Decrypt is constrained to the SSM service so this role can't decrypt arbitrary ciphertext.
resource "aws_iam_role_policy" "instance_onboarding_read" {
  name = "${var.prefix}-onboarding-read"
  role = aws_iam_role.instance.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid      = "ReadArcOnboardingSecret"
        Effect   = "Allow"
        Action   = ["ssm:GetParameter"]
        Resource = aws_ssm_parameter.arc_onboarding_secret.arn
      },
      {
        Sid      = "DecryptViaSsmOnly"
        Effect   = "Allow"
        Action   = ["kms:Decrypt"]
        Resource = "*"
        Condition = {
          StringEquals = { "kms:ViaService" = "ssm.${data.aws_region.current.name}.amazonaws.com" }
        }
      },
      {
        Sid      = "LocateDeployArtifactsBucket"
        Effect   = "Allow"
        Action   = ["s3:GetBucketLocation"]
        Resource = aws_s3_bucket.deploy_artifacts.arn
      },
      {
        Sid    = "ReadDeployBundlesOnly"
        Effect = "Allow"
        # Scoped to transient deploy artifacts under this one private bucket prefix.
        Action   = ["s3:GetObject"] # nosemgrep: terraform.lang.security.iam.no-iam-data-exfiltration.no-iam-data-exfiltration
        Resource = "${aws_s3_bucket.deploy_artifacts.arn}/deploy-bundles/*"
      }
    ]
  })
}

resource "aws_iam_instance_profile" "instance" {
  name = "${var.prefix}-instance"
  role = aws_iam_role.instance.name
}

# ============================================================================================================
# GitHub Actions OIDC deploy role — the AWS analogue of the live least-privilege custom `run-command` role
# (infra/azure/terraform/github_oidc.tf). GitHub mints a short-lived OIDC token (no stored cloud cred); this role
# trusts ONLY tokens whose subject is this repo bound to the `aws-experiment` GitHub Environment. The role can
# do exactly: start the instance (so a deploy can wake a stopped box), describe it, and run AWS-RunShellScript
# on THAT ONE instance via SSM. It CANNOT stop/terminate/resize it, read Key Vault, or touch any other host.
# ============================================================================================================
data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

resource "aws_iam_openid_connect_provider" "github" {
  count          = var.create_github_oidc_provider ? 1 : 0
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # AWS no longer validates this thumbprint for the GitHub IdP (it trusts the CA), but the argument is required.
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
  tags            = { Name = "${var.prefix}-github-oidc" }
}

locals {
  github_oidc_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
  # AWS-owned public SSM document — no account id in the ARN (the `::` is intentional).
  run_shell_doc_arn = "arn:aws:ssm:${data.aws_region.current.name}::document/AWS-RunShellScript"
}

resource "aws_iam_role" "github_deploy" {
  name = "${var.prefix}-github-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Federated = local.github_oidc_arn }
      Action    = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "token.actions.githubusercontent.com:aud" = "sts.amazonaws.com"
          # Bind to the GitHub Environment, NOT a branch ref — the per-release required-reviewer gate lives on
          # the environment. Any subject mismatch (a branch, another repo, another env) is rejected.
          "token.actions.githubusercontent.com:sub" = "repo:${var.github_owner}/${var.github_repo}:environment:${var.github_deploy_environment}"
        }
      }
    }]
  })
  tags = { Name = "${var.prefix}-github-deploy" }
}

resource "aws_iam_role_policy" "github_deploy" {
  name = "${var.prefix}-github-deploy"
  role = aws_iam_role.github_deploy.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Run a shell script as root on the ONE instance, via the ONE AWS-owned document. Pinning both the
        # instance ARN and the document ARN is the whole least-privilege boundary — `Resource: *` here would
        # let the role run arbitrary root commands on every SSM-managed host in the account.
        Sid    = "SendRunShellToThisInstanceOnly"
        Effect = "Allow"
        Action = ["ssm:SendCommand"]
        Resource = [
          aws_instance.this.arn,
          local.run_shell_doc_arn,
        ]
      },
      {
        # Start the box if it's stopped (you stop it by hand to save cost). No StopInstances — stopping is
        # manual. StartInstances supports resource-level scoping; pin it to the one instance.
        Sid      = "StartThisInstanceOnly"
        Effect   = "Allow"
        Action   = ["ec2:StartInstances"]
        Resource = aws_instance.this.arn
      },
      {
        # Read-only status. ec2:DescribeInstances, ssm:DescribeInstanceInformation, and ssm:GetCommandInvocation
        # do NOT support resource-level scoping (AWS requires `*`); they leak no mutation capability.
        Sid    = "ReadDeployStatus"
        Effect = "Allow"
        Action = [
          "ec2:DescribeInstances",
          "ssm:DescribeInstanceInformation",
          "ssm:GetCommandInvocation",
          "ssm:ListCommandInvocations",
        ]
        Resource = "*"
      },
      {
        Sid      = "LocateDeployArtifactsBucket"
        Effect   = "Allow"
        Action   = ["s3:GetBucketLocation"]
        Resource = aws_s3_bucket.deploy_artifacts.arn
      },
      {
        # Upload the exact-SHA infra bundle for the instance to fetch, then delete it after the SSM rollout.
        Sid    = "WriteDeployBundlesOnly"
        Effect = "Allow"
        Action = [
          "s3:DeleteObject",
          "s3:PutObject",
        ]
        Resource = "${aws_s3_bucket.deploy_artifacts.arn}/deploy-bundles/*"
      }
    ]
  })
}
