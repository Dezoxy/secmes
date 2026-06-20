# Threat model: VM deploy infrastructure (Terraform — slice 1)

> Status: **DRAFT for ratification.** The single-VM deploy foundation (roadmap Phase 0): the Azure VM, its
> Managed Identity → Key Vault secret boundary, the NSG (deny-inbound), and the GitHub-OIDC `az vm
> run-command` deploy path. Build-only — this slice provisions; later slices wire the stack onto it.

## 1. Feature & data flow

```
GitHub Actions ──(OIDC federated token, no stored secret)──▶ Azure AD app (custom run-command role)
   └─ az vm run-command invoke ──▶ Azure control plane ──▶ VM guest agent ──▶ deploy script (root)

VM (no public inbound):
   Managed Identity ──▶ Key Vault (Secrets User, read-only) ──▶ credential files (tmpfs) ──▶ stack
   cloudflared (outbound tunnel) ◀── Cloudflare edge ◀── users        [ingress, later slice]
   egress public IP ──▶ Key Vault / B2 / GHCR / apt   (NSG denies ALL inbound)
```

The deploy plane (control-plane `run-command`), the app plane (Cloudflare Tunnel), and secret retrieval
(Managed Identity → Key Vault) are all **outbound or control-plane** — the VM exposes **no inbound port**.
No message content is involved here; this is pure infrastructure (identity, network, secret delivery).

## 2. Assets & trust boundaries

- **Assets:** the runtime secrets in Key Vault (DB passwords, B2 keys, the argus session signing key, cloudflared token);
  the VM host (which, once the stack runs, holds the DB + decrypted-at-rest-sealed material); the GitHub-OIDC
  deploy credential.
- **Boundaries:** internet ↔ VM (closed — no inbound); GitHub ↔ Azure (OIDC federation, no stored creds);
  the deploy SP ↔ the VM (control-plane `run-command` only); the VM identity ↔ Key Vault (read-only); VM ↔
  Cloudflare (outbound tunnel).

## 3. Threats (STRIDE-lite)

- **Spoofing the deployer.** A forged OIDC token could deploy arbitrary code (root) to the VM. → The
  federated credential is scoped to **this repo's `main` ref** (a protected GitHub Environment is the
  must-before-prod tightening, documented); Azure validates the OIDC issuer/subject; the SP holds **only** a
  custom `run-command` role on the one VM (not Contributor).
- **Elevation — the deploy runs as root.** `az vm run-command` executes its script as root on the VM, so
  whoever can mint the OIDC token effectively owns the host (incl. the MI-fetched secrets). → This is
  inherent to the control-plane deploy model; the **OIDC subject binding is the real boundary** (hence the
  protected-environment follow-up), and there is no SSH/network path that widens it.
- **Information disclosure — secrets.** → Secrets live in **Key Vault** (RBAC, default-deny firewall reachable
  only from the VM's subnet service endpoint + an optional admin IP); the VM identity is **read-only**; no
  secret is in Terraform, tfvars (gitignored), state-in-repo, or cloud-init. State is local + flagged to move
  to an encrypted remote backend.
- **Tampering / network exposure.** A misconfigured NSG or public data service would expose the box. → The
  NSG has an explicit **deny-all-inbound** + no internet-inbound allow; the public IP is egress-only;
  Standard SKU is secure-by-default. Data services bind to loopback/internal (enforced in a later slice).
- **Denial / durability.** Host crash could lose data on the DB disk. → The data disk uses host caching
  **`None`** (write-heavy DB durability); disks are SSE-encrypted + `encryption_at_host`. (Backups + restore
  drill are checkpoint 49, already built.)

## 4. Invariant check

- **#1 crypto-blind / #6 no admin content** — N/A: infra only, no message content.
- **#2 no secret persistence** — upheld: no secret in code/tfvars/state-in-repo/cloud-init; secrets delivered
  as Key-Vault files at runtime.
- **#3 RLS** — N/A (no DB tables).
- **#4 no hand-rolled crypto** — N/A.
- **#5 secrets via Key Vault + Managed Identity** — this slice *is* that mechanism: MI → Key Vault (read-only)
  → credential files, never env at rest.

## 5. Decision & mitigations

- `infra/azure/terraform/`: VM (Ubuntu 24.04, system MI, `encryption_at_host`), NSG deny-inbound, egress-only
  public IP, Key Vault (RBAC + default-deny firewall via the subnet's KeyVault service endpoint), data disk
  (`caching=None`), GitHub-OIDC app + federated credential + a least-privilege custom `run-command` role,
  cloud-init (base tooling only — pulls no secrets).
- Gate: **`infra-reviewer`** PASS; `terraform fmt`/`validate` clean; Checkov (resource-scoped `# checkov:skip`
  for the deliberate beta trade-offs) + Semgrep green.

## 6. Residual risk

- **OIDC bound to the `main` branch ref**, not a protected GitHub Environment — any workflow on `main` can
  mint a deploy token. **Must-before-prod:** bind to `environment:prod` with required reviewers
  (documented in the module README + `var.github_deploy_subject`).
- **Egress public IP** (vs a NAT Gateway) and **open egress** (vs service-tag/Firewall filtering) — accepted
  for cost; inbound is denied either way. NAT Gateway + egress filtering are the hardening upgrades.
- **Local Terraform state** — must move to an encrypted remote backend before any shared/CI use.
- **Key Vault network is firewalled but public-endpoint** — a private endpoint is the Phase-6 upgrade.
