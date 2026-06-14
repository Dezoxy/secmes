# Threat model — cross-cloud secret fetch (AWS EC2 compute → Azure Key Vault via Azure Arc)

Status: **DRAFT — experiment-scoped.** Covers the parallel **AWS experiment** stack (`infra/aws/`): the platform's
compute runs on a single AWS EC2 instance (eu-central-1) while secrets stay in **Azure Key Vault**. Because an
EC2 box has no Azure Managed Identity, it is onboarded to **Azure Arc**, which gives it a real Entra managed
identity that mints Key Vault tokens on-box — the structural twin of the live VM's IMDS path. This note exists
because the change crosses a trust boundary (a non-Azure host reading Azure secrets) and must be re-checked
against the six invariants. **Scope guard:** the experiment runs with **no real user data** and a **separate
experiment Key Vault seeded with DUMMY values** — it does not touch the production vault or the live VM.

## What changes vs the live VM path

| Aspect | Live (`infra/azure/`) | Experiment (`infra/aws/`) |
| --- | --- | --- |
| Compute | Azure VM (germanywestcentral) | AWS EC2 (eu-central-1) |
| Secret token source | VM Managed Identity via Azure IMDS `169.254.169.254` | Azure Arc managed identity via HIMDS `localhost:40342` + challenge-token handshake |
| KV network binding | subnet `Microsoft.KeyVault` service endpoint (Azure backbone) | default-deny firewall + the EC2 **Elastic IP** allow-listed (public internet, TLS) |
| Deploy channel | `az vm run-command` (Azure control plane) | AWS SSM `send-command` (AWS control plane) |
| Deploy identity | GitHub OIDC → Entra app, custom run-command role | GitHub OIDC → AWS IAM role, scoped to one instance + `AWS-RunShellScript` |
| Secrets store | production Key Vault, real values | separate experiment Key Vault, DUMMY values |

## Data flow

```
first boot (cloud-init):
  EC2 IAM role (IMDSv2, no static AWS cred) ──▶ SSM Parameter Store ──▶ Arc onboarding SP secret (one-time)
     └─ azcmagent connect ──▶ Entra: register Arc machine + system-assigned managed identity (cert-based, auto-rotating)
        (the onboarding secret is used once, never written to disk, then dropped; it CANNOT read Key Vault)

steady state (argus-secrets.service, root, Before=docker.service):
  HIMDS (localhost:40342) ──challenge handshake──▶ Entra token for vault.azure.net (Arc managed identity, no static cred)
     1. GET /metadata/identity/oauth2/token  ──▶ 401 + Www-Authenticate: Basic realm=<.key file, 0440 himds/root>
     2. read the .key file (root) ──▶ retry Authorization: Basic <contents>  ──▶ access token
  GET https://<exp-vault>.vault.azure.net/secrets/<name>  (Bearer)  ──▶ value ──▶ /run/argus/secrets/<file> (tmpfs, 0444)
  stack (compose) reads the credential files                          (identical to the live path from here on)

deploy (CD):
  push tag ─▶ cd-aws.yml ─▶ aws-experiment Environment approval ─▶ GitHub OIDC ─▶ AWS IAM deploy role
     └─ ec2 start-instances (if stopped) ─▶ wait SSM Online ─▶ ssm send-command AWS-RunShellScript ─▶ deploy.sh (root)

network: EC2 security group denies ALL inbound. Ingress = Cloudflare Tunnel (outbound). Egress reaches Key
Vault, the Arc endpoints (*.arc.azure.com, login.microsoftonline.com, management.azure.com), B2, GHCR, apt.
```

## Assets & trust boundaries

- **Assets:** the (dummy) secrets in the experiment Key Vault; the Arc machine's managed identity; the Arc
  onboarding SP secret (transient); the EC2 host; the IAM deploy role (root on the box).
- **Boundaries:**
  - EC2 ↔ HIMDS (`localhost:40342`) — loopback only; token minting additionally gated by a **challenge file**
    readable only by root / the `himds` group. `argus-secrets.service` runs as root and qualifies; container
    users are NOT added to `himds`. This is **stricter** than Azure IMDS, where any on-box process can mint.
  - EC2 ↔ Key Vault — the Arc managed identity holds **Key Vault Secrets User** (read-only) on the experiment
    vault; the vault firewall default-denies and allows only the instance's Elastic IP.
  - EC2 IAM role ↔ AWS — assumed via IMDSv2 (token-gated, hop-limit 1); may read only the one onboarding
    parameter + talk to SSM. No static AWS credential exists on the box.
  - GitHub ↔ AWS — short-lived OIDC token, subject-bound to `repo:OWNER/REPO:environment:aws-experiment`; the
    role can start/describe **one** instance and run `AWS-RunShellScript` on **that one** instance only.

## Threats & mitigations

- **Spoofing the secret identity / token theft.** No static credential to steal: the KV token is minted on-box
  by the Arc managed identity via HIMDS, and the HIMDS challenge file is root/himds-only. A stolen token is
  short-lived and scoped to `vault.azure.net` read. The onboarding SP secret *is* a credential, but it is
  transient (one `azcmagent connect`), never written to disk, and **cannot read Key Vault** (onboarding role
  only) — see residual risk on its brief argv exposure.
- **Tampering / unauthorized deploy.** Root-on-box runs only via SSM `send-command`, gated by the
  `aws-experiment` Environment (required reviewer) and the OIDC subject binding. The IAM policy pins
  `ssm:SendCommand` to one instance ARN + the `AWS-RunShellScript` document — not `Resource: *` — so the role
  cannot run commands on any other host. Images are cosign-verified (this workflow's identity) before they run.
- **Token/secret in logs or process state.** Tokens pass via `curl --config` stdin (never argv); secret values
  go to `0444` tmpfs files inside a `0700` root dir, never env; logs carry names + HTTP status only. Unchanged
  from the live path.
- **SSM agent attack surface.** The SSM agent is a long-running root daemon with an outbound control channel —
  a larger persistent surface than the per-invocation RunCommand extension. Mitigations: keep the agent patched;
  the real "who can run root" boundary is *who can call SendCommand*, pinned by the IAM policy above. (Routing
  the channel over SSM VPC interface endpoints is the hardening upgrade — not built for the beta.)
- **KV network exposure.** With no Azure subnet, the KV firewall trusts the EC2 Elastic IP over the public
  internet (TLS) instead of the Azure backbone service endpoint — a weaker *network-identity* binding (see
  residual risk). The vault still default-denies; only the EIP is allowed.

## Six-invariant re-check

1. **Server is crypto-blind** — unchanged; compute moving clouds doesn't change what the server stores
   (ciphertext + metadata).
2. **Never log/persist secrets** — unchanged; same names-only logging, `--config` stdin tokens, tmpfs files.
3. **Tenant RLS** — unchanged; same Postgres/schema runs on the box.
4. **No hand-rolled crypto** — unchanged; no crypto added (HIMDS handshake is HTTP + a file read).
5. **Secrets via a platform machine identity, no static cred** — ✅ **intact.** The Arc managed identity is a
   genuine Entra machine identity; the KV token is minted on-box; there is no standing credential that reads
   secrets. The onboarding SP secret is transient and KV-incapable.
6. **No admin path to content** — unchanged; SSM/deploy operate on metadata + ciphertext only.

## Residual risks (experiment-scoped; recorded, accepted for the beta)

- **KV firewall by IP, not network identity.** The experiment vault trusts the EC2 Elastic IP; every KV call
  traverses the public internet (TLS) rather than the Azure backbone. Weaker than the live service-endpoint
  binding and breaks if the EIP changes. **Upgrade:** Azure Private Link to KV over a cross-cloud VPN
  (production hardening, not built for the experiment).
- **Onboarding SP secret brief argv exposure.** `azcmagent connect` takes the SP secret as a flag, so it is
  momentarily visible in `/proc` on this single-tenant root box during the one-time onboarding. The secret is
  transient and cannot read Key Vault. Acceptable for the experiment; rotate by tainting the credential.
- **SSM agent persistent root daemon** — see threats above; patch + tight SendCommand IAM are the controls.
- **Dummy secrets / partial stack health.** The experiment Key Vault holds format-valid DUMMY values; external
  credentials (GHCR/B2/Cloudflare tokens) are placeholders the operator must replace for a fully healthy stack.
  The point this validates is the **Arc → KV → credential-file** path, not production-grade service health.
- **Two-phase Key Vault grant.** The Arc machine's identity doesn't exist until first boot, so the
  `Key Vault Secrets User` grant lands on a second `terraform apply` (`arc_machine_connected = true`). Between
  the two applies the box is onboarded but cannot yet read secrets — fail-closed, not fail-open.
- **GDPR / data-residency record (deferred).** Moving compute to AWS makes the privacy story span **two**
  US-headquartered clouds (AWS compute + Azure KV), both EU-regioned. This is **not** triggered now (no real
  user data on AWS), but **before any production promotion**: update `docs/gdpr/data-residency.md` +
  `docs/gdpr/article-30-records.md` (dual-processor split, AWS DPA) and generalize invariant #5's wording in
  `AGENTS.md` to bless the Arc managed-identity path.
