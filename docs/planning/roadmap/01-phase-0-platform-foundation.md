# Phase 0 — Platform foundation (VM + pipeline)

> Part of the [build roadmap](README.md). Legend: `[ ]` todo · `[~]` in progress · `[x]` done · 🔒 security-gated.

**Progress:** 0/10 done (6 in progress — gated on the one-time Azure arming).

> Goal: stand up the VM and prove the deploy pipeline before the bulk of the app logic. (Kubernetes was dropped — recover the K8s checkpoints from git history if it is ever revisited.)
>
> Deploy-track: Slices 1–4 merged (code-complete + gated); what remains is the **one-time Azure arming**, which flips #1/#3/#7/#8a and the live half of the `[~]` items. Threat models: `vm-ingress.md`, `vm-secrets.md`, `vm-cd.md`.

- [ ] 1. **VM provisioned** via Terraform (`infra/azure/`) — `terraform apply` clean; the Azure VM (EU `germanywestcentral`) boots with Docker + the Compose stack
- [~] 2. **Managed Identity → Key Vault** wired — the VM reads a Key Vault secret with no static creds (delivered as a credential file, not env) 🔒
- [ ] 3. **NSG deny-inbound proven** — the Azure NSG drops all inbound; the VM reaches out only via the Cloudflare Tunnel (no open ports) 🔒
- [~] 4. **Ingress + TLS via Cloudflare** — cloudflared dials out, Cloudflare terminates TLS + runs the edge WAF/rate-limit; Caddy is a plain-HTTP single-origin reverse proxy (PWA + `/api` + `/ws`); admin subdomains behind Cloudflare Access
- [~] 5. **CD via `az vm run-command`** — GitHub Actions + Azure OIDC deploys the stack with no SSH and no open ports
- [~] 6. **CI green on a PR** — lint/format/typecheck/test/build pass; GitHub→GHCR via OIDC
- [ ] 7. **Hello-world `api` live** end-to-end over HTTPS through the Cloudflare Tunnel
- [~] 7a. **DB migrations run on deploy** — `db:migrate` (owner credential from Key Vault, NOT the runtime `argus_app` role) runs **before** the new API container takes traffic, so a breaking migration can never serve traffic ahead of its schema. 🔒
- [~] 8. **Secrets via Key Vault** fetched by the VM's Managed Identity and mounted as credential files for the API container (never env at rest) 🔒
- [ ] 8a. **Staging + prod environments** stood up (per-env Compose config / subdomains, first deploy, `vars.STAGING_URL` registered) — the prod gate and nightly DAST both require this.
