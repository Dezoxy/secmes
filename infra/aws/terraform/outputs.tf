output "instance_id" {
  value       = aws_instance.this.id
  description = "EC2 instance id — the SSM send-command target + the ec2 start-instances target for CD."
}

output "instance_arn" {
  value       = aws_instance.this.arn
  description = "EC2 instance ARN (the deploy IAM role is scoped to exactly this)."
}

output "egress_ip" {
  value       = aws_eip.this.public_ip
  description = "Instance Elastic IP. Point nothing at it (no inbound) — it's the stable egress address allow-listed on the experiment Key Vault firewall."
}

output "github_deploy_role_arn" {
  value       = aws_iam_role.github_deploy.arn
  description = "Set as the AWS_DEPLOY_ROLE_ARN var in GitHub Actions — cd-aws.yml assumes it via OIDC (configure-aws-credentials)."
}

output "deploy_artifacts_bucket" {
  value       = aws_s3_bucket.deploy_artifacts.id
  description = "Set as AWS_DEPLOY_ARTIFACTS_BUCKET in GitHub Actions — cd-aws.yml uploads the SSM deploy bundle here."
}

output "aws_region" {
  value       = var.aws_region
  description = "Set as the AWS_REGION var in GitHub Actions."
}

output "key_vault_name" {
  value       = azurerm_key_vault.exp.name
  description = "Experiment Key Vault name — passed to the deploy as the vault to read (ARGUS_KEY_VAULT) and seeded with DUMMY values."
}

output "arc_machine_name" {
  value       = "${var.prefix}-ec2"
  description = "Name the box registers under in Azure Arc. After it shows Connected, set arc_machine_connected=true and re-apply to grant its identity Key Vault access."
}

output "arc_resource_group" {
  value       = azurerm_resource_group.exp.name
  description = "Azure resource group holding the experiment Key Vault + the Arc machine projection."
}

output "next_step_hint" {
  value       = "1) apply (arc_machine_connected=false) → 2) wait for '${var.prefix}-ec2' to show Connected in Azure Arc → 3) set arc_machine_connected=true and re-apply to grant Key Vault access."
  description = "The two-phase apply order (see arc.tf)."
}
