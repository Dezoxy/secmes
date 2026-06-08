# Secure Messaging Platform — Architecture Plan v2

> Supersedes `aws_secure_internal_messaging_architecture_plan.md` (kept as history / north-star).
> This version reflects the decisions made: PWA-only, true E2EE (single device in v1), multi-tenant SaaS sold to other companies, privacy-first, EU-hosted. _(The original **Kubernetes learning goal** was dropped 2026-06 — see the banner.)_
>
> **⚠️ Composition update (2026-06 — supersedes the AKS / managed-data sections below):** Kubernetes/AKS was **dropped** as solo-dev overhead, and so were the **Azure managed data services** (managed Postgres / Cache). The deploy target is now a **single Azure VM** running **self-hosted Postgres + Redis + Zitadel** via Docker Compose; attachment blobs live on **Backblaze B2** (S3-compatible, EU `eu-central-003`, private buckets; MinIO locally); DB backups on a separate private EU B2 bucket; secrets in **Azure Key Vault**, fetched by the VM's **Managed Identity** and delivered as credential files (never env at rest). **Azure stays** (the VM + Key Vault + Entra). The detailed AKS / Helm / Argo CD / managed-data sections below are **legacy** — read them as history. Canonical: `AGENTS.md` → _Stack & conventions_.

---

## 0. Executive Summary

A **multi-tenant, end-to-end-encrypted messaging product** delivered as an installable **PWA on every platform** (no app stores). The server is a **crypto-blind delivery layer**: it stores ciphertext, fans out real-time messages, and brokers keys — it can never read message content.

**Decided stack:**

| Layer | Choice |
|---|---|
| Language | **TypeScript**, end-to-end |
| Frontend | **React + Vite**, built as a **PWA** |
| Backend | **NestJS** |
| Realtime | **WebSocket** in a dedicated gateway, Redis backplane |
| Database | **PostgreSQL** + Row-Level Security (multi-tenant) |
| Client crypto | **MLS (RFC 9420)** via wasm — never hand-rolled |
| Identity | **Zitadel** (self-hosted, EU), OIDC/SAML, multi-tenant |
| Object storage | **Backblaze B2** (S3-compatible, EU `eu-central-003`, private buckets) — MinIO locally _(was Azure Blob)_ |
| Orchestration | **Single Azure VM** + Docker Compose (EU `germanywestcentral`) _(AKS dropped)_ |
| Ingress / TLS | **Cloudflare Tunnel** (no public ports) + Cloudflare edge TLS/WAF; **Caddy** plain-HTTP reverse proxy internally |
| Deploy | **Docker Compose** on the VM; CD via **`az vm run-command`** (GitHub OIDC) _(Helm + Argo CD dropped)_ |

**Why Azure (and the privacy trade you're accepting):** Azure gives you a single low-cost **VM**, **Key Vault** for secrets, native **Entra ID** alignment for the Microsoft-shop companies you're selling to, and cloud skills that transfer to any job — without the K8s ops a solo dev can't justify. The honest cost: Azure is **US-owned**, so your privacy story shifts from *"EU-owned provider"* to *"E2EE (the cloud only ever holds ciphertext + metadata) + EU Data Boundary + a German region."* That's defensible, but a notch weaker than Hetzner/Scaleway on pure sovereignty. For stricter buyers later you can deploy via an Azure sovereign operator (Delos/Bleu) or move just the VM to an EU-owned provider — the stack is plain Docker Compose, so it's portable either way.

---

## 1. Product Goal & Scope

**Goal:** a private messaging platform that companies can adopt for sensitive internal communication, where the vendor (you) is technically incapable of reading message content.

**v1 scope:**
- Multi-tenant company sign-up (one organization = one tenant)
- SSO login via the tenant's IdP (OIDC/SAML) or local accounts
- User directory (per tenant)
- One-to-one text messaging (E2EE)
- Image messages / encrypted attachments
- Single device per user
- Real-time delivery + offline catch-up
- Delivery status
- Encrypted key backup & recovery
- Admin panel (metadata only — never content)
- Audit log for security events

**Explicitly out of v1:**
- Voice / video
- Group chat (MLS chosen now so it's cheap to add later)
- Multi-device sync (the single hardest E2EE problem — deferred deliberately)
- Federation / cross-org messaging
- Server-side message search (impossible with E2EE — will be client-side only)
- Compliance/eDiscovery mode (a future, opt-in, per-tenant feature)
- Bots / AI features

---

## 2. Core Principle

> The server delivers messages; it never owns their content.

- Content is encrypted **on the client** before it touches the network.
- The database stores **ciphertext**; object storage stores **encrypted blobs**.
- Admins see **security metadata**, never plaintext.

The backend manages: authentication, authorization, tenant isolation, the public **key directory**, message routing & storage, attachment references, audit events, and operations. It never manages: plaintext, user private keys, or decryption of conversations.

---

## 3. Security Model

### 3.1 What "E2EE, single device" means in v1
- Each user has **one client/device**. Their MLS private keys live in **IndexedDB** (via WebCrypto-managed key material).
- "New phone / new browser" is handled by **key recovery** (§3.4), not live multi-device sync. This sidesteps the multi-device problem entirely for v1.

### 3.2 The honest PWA caveat (read this twice)
A web app delivers the encryption code on every load, so a **fully compromised server could ship malicious JavaScript** and capture plaintext. Native apps avoid this; a pure PWA cannot fully escape it. You can only narrow it:

- Strict **Content-Security-Policy** + **Subresource Integrity** (browser rejects tampered scripts)
- **Service worker** caches the app shell, so the code changes rarely and visibly
- **Reproducible builds** + publish the bundle hash on a security page for verification
- Treat the **deploy pipeline as your #1 attack surface** — lock it down hard

Be honest with buyers: this is "very strong privacy," not "uncompromisable." It's the same trade Signal made when it chose native apps. Acceptable for a privacy-first PWA; just don't oversell it.

### 3.3 Crypto: build on a standard, never hand-roll
- **Protocol: MLS (RFC 9420)** via a wasm library. Chosen over the Signal protocol because MLS is the modern IETF standard and is **group-ready**, so adding group chat later is not a rewrite.
- **Do not** use the deprecated `libsignal-protocol-javascript`.
- **Do not** compose your own scheme from primitives ("rolling crypto") — it weakens both security and your sales story.
- Server stores MLS **KeyPackages** (public), ciphertext messages, and Welcome messages for offline delivery.

### 3.4 Key backup & recovery (mandatory)
iOS evicts PWA storage under pressure → without backup, a user loses all history. So:
- Derive a backup key from a **user passphrase** with **Argon2id**.
- Encrypt the user's private key material with it.
- Store the result **server-side as ciphertext**. The server can't use it (no passphrase).
- Recovery / new device = enter passphrase → fetch ciphertext → decrypt locally.

### 3.5 Auth ↔ crypto boundary
The IdP authenticates **who you are**. It **never** sees or holds **message keys**. Keep these two systems strictly separate or you've defeated E2EE.

---

## 4. Multi-Tenancy

- **Model:** shared PostgreSQL, every table carries `tenant_id`, enforced with **Row-Level Security (RLS)**. The app sets the tenant context per request; Postgres rejects cross-tenant reads even if app code has a bug.
- **Isolation upgrade path:** schema-per-tenant or database-per-tenant only when a large buyer contractually demands it.
- **Per-tenant config:** IdP connection, branding, retention policy, feature flags.
- **Tenant onboarding:** self-serve org creation → first admin → invite users.

---

## 5. Architecture Overview

```text
        Every platform (installed PWA: iOS/Android/Win/macOS/Linux)
                                  |
                                  | HTTPS / WSS
                                  v
                   Cloudflare edge (TLS, WAF, rate-limit; Access on admin subdomains)
                                  |
                                  | Cloudflare Tunnel (cloudflared dials OUT — no public ports)
                                  v
        ============== single Azure VM (germanywestcentral) ==============
        |                Docker Compose stack                            |
        |                                                                |
        |   cloudflared ── Caddy (plain-HTTP reverse proxy, single origin)|
        |                    |        |          |                       |
        |                    v        v          v                       |
        |                 web (PWA)  api      realtime (WS)   zitadel     |
        |                 static    NestJS   WS gateway       identity    |
        |                              |        |               |        |
        |                              v        v               v        |
        |                          Postgres   Redis         zitadel-db    |
        |                        (self-host) (backplane)   (self-host PG) |
        ==================================================================
                                       |
                                       v
                          Backblaze B2 (EU eu-central-003)
                            encrypted image blobs (private)

  Secrets: Azure Key Vault, fetched by the VM's Managed Identity as credential files.
  Network: Azure NSG denies all inbound; the VM reaches out only via the Cloudflare Tunnel.
```

---

## 6. VM Deploy Architecture

> Kubernetes/AKS was dropped (solo-dev overhead). The deploy is now a **single Azure VM** running the whole stack via **Docker Compose**. The old §6 AKS/Helm/Argo CD design is recoverable from git history if K8s is ever re-opened.

### 6.1 The VM
- **Host:** one Azure VM (burstable **B-series** to start) in **Germany West Central** (`germanywestcentral`) for the strongest EU data-residency story. Pin every Azure resource to the same region.
- **Stack:** **Docker Compose** runs **self-hosted Postgres + Redis + Zitadel** alongside `api`, `web`, **Caddy**, and **cloudflared**. One container per service (no autoscaling — scale up the VM if needed).
- **Identity:** the VM's **Managed Identity** reads secrets from **Azure Key Vault** with no static creds; secrets are delivered as **credential files** (systemd `LoadCredential`), never env at rest.

### 6.2 Ingress, TLS & isolation
- **Ingress = Cloudflare Tunnel.** `cloudflared` dials **outbound** to Cloudflare, so **no inbound ports** are opened on the VM. Cloudflare is the edge: **TLS termination, WAF, rate-limit**. Admin/ops surfaces sit on subdomains behind **Cloudflare Access**.
- **Internal proxy = Caddy** (plain HTTP, single origin): serves the PWA, proxies `/api` and `/ws`. TLS is Cloudflare's job, not Caddy's (no cert-manager / Let's-Encrypt-on-host).
- **Network isolation = Azure NSG** (deny all inbound) + Cloudflare. There is no K8s NetworkPolicy/Cilium — the NSG + outbound-only tunnel are the boundary.

### 6.3 CD & secrets
- **CD = `az vm run-command`** driven by **GitHub Actions + Azure OIDC** — no SSH, no open ports, and it works before the tunnel exists. The pipeline builds + signs the image (registry: GHCR), then runs the deploy command on the VM (pull + `docker compose up` + migrate-on-deploy).
- **Secrets = Key Vault + Managed Identity**, delivered as files (above). The `db:migrate` runs with the owner/migration credential (not the runtime `argus_app` role) before the new container takes traffic.

### 6.4 Container security (Compose-level, apply everywhere)
```text
runAsNonRoot, read-only root filesystem, drop ALL capabilities
resource limits on every service
data services (Postgres/Redis/Zitadel-db) on the private Docker network only — never published
image scanning (Trivy) in CI; only signed/scanned images deploy
short-lived OIDC tokens for CD; no long-lived cloud keys on the VM
```

### 6.5 IaC
- Terraform (`infra/vm/`) provisions the RG, VNet, NSG (deny inbound), the VM, Key Vault, and the Managed Identity.

---

## 7. Data Model

Every table includes `tenant_id` (RLS-enforced). Key tables:

```text
tenants(id, name, idp_config, retention_policy, created_at)

users(id, tenant_id, external_identity_id, email, display_name,
      status, created_at, updated_at)

devices(id, tenant_id, user_id, public_identity_key, status,
        created_at, last_seen_at, revoked_at)          # one per user in v1

key_packages(id, tenant_id, device_id, mls_key_package, used_at, created_at)
                                                        # MLS KeyPackages (public)

key_backups(id, tenant_id, user_id, ciphertext, kdf_params, created_at)
                                                        # passphrase-encrypted

conversations(id, tenant_id, type, created_at, updated_at)

conversation_members(conversation_id, tenant_id, user_id, role,
                     joined_at, removed_at)

messages(id, tenant_id, conversation_id, sender_user_id, sender_device_id,
         ciphertext, encrypted_metadata, created_at, expires_at)

attachments(id, tenant_id, message_id, object_key, encrypted_size,
            encrypted_metadata, created_at, expires_at)

delivery_receipts(id, tenant_id, message_id, recipient_user_id,
                  status, created_at)

audit_events(id, tenant_id, actor_user_id, event_type, ip_address,
             user_agent, metadata, created_at)
```

---

## 8. Identity & Auth

- **Zitadel** self-hosted in the Docker Compose stack on the VM — built for multi-tenant federation, keeps identity data on infra you control, stays portable. *(Azure-native alternative: Entra External ID — managed CIAM, but more lock-in. Either way, customers' own Entra/Okta/Google federate in.)*
- Per-tenant **OIDC/SAML** so customers bring their own IdP (Entra ID, Okta, Google Workspace); local accounts as fallback for small tenants.
- Backend validates JWTs; maps `external_identity_id` → `users`.
- MFA, conditional access, user lifecycle, disable/revoke all handled by the IdP.
- **Reminder:** identity ≠ message keys (§3.5).

---

## 9. Message & Image Flows

### Text
```text
1. Client fetches recipient's MLS KeyPackage from the key directory.
2. Client encrypts the message (MLS) locally.
3. Client sends ciphertext to api.
4. api authorizes sender, writes ciphertext to Postgres, emits delivery event.
5. realtime pushes ciphertext to the recipient over WSS (or queues if offline).
6. Recipient client decrypts locally.
```

### Image
```text
1. Client generates a random content key, encrypts the image locally.
2. Client requests a presigned upload URL from api.
3. Client uploads the encrypted blob directly to object storage.
4. Client sends an E2EE message containing the encrypted attachment metadata
   (object key + content key wrapped for the recipient).
5. Recipient downloads the blob, decrypts locally.
```

Object storage: **private buckets, no public URLs, access only via short-lived presigned URLs**, server-side encryption on top of the client-side encryption.

---

## 10. Realtime Design

- The WebSocket gateway (in the `api` service) holds the connections; on the single-container VM that's one process.
- **Redis pub/sub backplane** is the realtime bus (and the future throttler store); it would also fan out across instances if the API ever ran more than one.
- Cloudflare + Caddy proxy the WebSocket upgrade through to the gateway.
- Offline users: messages persist as ciphertext; delivered on reconnect.
- Presence/typing indicators: optional, off by default (privacy).

---

## 11. Observability (without leaking content)

**Log:** request id, tenant id, user id, service, operation, status, latency, error category, message id.
**Never log:** message text, image data, plaintext metadata, private keys, tokens, full auth headers, presigned URLs.

Stack: OpenTelemetry → self-hosted **Prometheus + Grafana** (metrics + dashboards) + **Loki** (logs) on the VM, with **Sentry** for error tracking. Azure-native alternative if you want managed: Azure Monitor managed Prometheus + Managed Grafana + Application Insights — watch Log Analytics ingestion cost (set retention and a daily cap).

---

## 12. CI/CD

```text
push / PR
  └─ lint, unit + integration tests, typecheck
  └─ SAST + dependency scan
  └─ build container image
  └─ Trivy image scan
  └─ cosign sign + SBOM
  └─ push to the container registry (GHCR)   # GitHub Actions → Azure via OIDC, no stored creds
merge to main
  └─ az vm run-command on the VM (GitHub Actions → Azure OIDC; no SSH, no open ports)
       pull the new image → migrate-on-deploy → docker compose up
       (auto to staging, manual gate to prod)
```

Tools: GitHub Actions (OIDC federation to Entra — no stored Azure secrets), Docker Compose, `az vm run-command`, GHCR, Trivy, cosign, Checkov, Dependabot (dep updates).

---

## 13. Repository / IaC Structure

```text
infra/
  vm/                   # Terraform (azurerm): RG, VNet, NSG (deny inbound),
                        #   the VM, Key Vault, Managed Identity
  backup/               # nightly pg_dump → encrypted → private EU B2 bucket (systemd)
  cleanup/              # expired-attachment reaper (systemd timer)
  local/                # local-dev stand-ins (Zitadel bootstrap, etc.)
apps/
  web/                  # React + Vite PWA
  api/                  # NestJS (HTTP + WebSocket gateway)
  worker/               # background jobs
  packages/
    crypto/             # MLS wrapper, shared client/server
    contracts/          # shared TS types + Zod schemas (the E2EE envelope)
compose.yaml            # dev stack today (Postgres, Redis, MinIO, Zitadel, api); prod overlay adds web, Caddy, cloudflared
.github/workflows/      # CI + CD (build/sign image → az vm run-command deploy)
```

The `packages/contracts` shared types are the concrete payoff of going TypeScript end-to-end — client and server can never disagree on the encrypted envelope.

---

## 14. Threat Model

| Threat | Protection |
|---|---|
| Database leak | Ciphertext only; RLS limits blast radius per tenant |
| Object storage leak | Client-side encryption + private buckets + presigned-only access |
| Cross-tenant access | Postgres RLS + tenant context per request |
| Stolen infra credentials | Least-privilege, no long-lived keys on the VM (Managed Identity + Key Vault), audit logs |
| Compromised container | NSG deny-inbound + Cloudflare edge; data services private on the Docker network; non-root, read-only FS, dropped caps |
| Compromised admin | MFA via IdP, least privilege, full audit trail, no content access |
| Lost device | Key recovery from encrypted backup; device revocation |
| Malicious insider (you) | E2EE means you *cannot* read content — provable, sellable |
| Malicious JS injection | CSP + SRI + service-worker pinning + hardened pipeline (§3.2) |
| Compromised user account | IdP MFA + session controls + device revocation |

---

## 15. Privacy vs. Compliance Positioning (your call, not mine)

Maximum-privacy E2EE means you **cannot** offer message archival, eDiscovery, legal hold, or admin content audit. That wins privacy-first buyers (legal, M&A, journalism, executive comms, privacy-conscious healthcare) and loses regulated buyers who *require* content retention (some finance/healthcare).

**Recommendation:** commit to **privacy-first** for the beta — it's your differentiator. Keep a documented, opt-in, **per-tenant "compliance mode"** as a future feature for buyers who need it. Decide your target customer before you write sales copy, not during a sales call.

---

## 16. Cost Estimate (EU, monthly, rough)

```text
Azure VM (1× B2ms/B2s burstable)          ~$30–60   (runs the whole Compose stack)
Azure Key Vault                           ~$0–5
Backblaze B2 (blobs + backups + egress)   ~$5–10
Cloudflare (Tunnel + edge, Free/Pro)      $0–20
GHCR (container registry)                 $0
Self-hosted Postgres/Redis/Zitadel        $0   (on the VM)
------------------------------------------------
Total                                     ~$40–95 / month
```

Self-hosting the data services on one VM is far cheaper than managed Azure data + AKS; the trade is you own Postgres/Redis backups + patching (mitigated by the nightly encrypted B2 backup + restore drill). Native Entra alignment for B2B buyers stays. Cost levers: a burstable VM, Cloudflare Free tier, scale the VM up before splitting services out.

---

## 17. Phased Delivery

> This is an earlier, looser cut. `docs/roadmap.md` is **canonical** for phasing — defer to it when they disagree.

**Phase 0 — VM & pipeline**
The Azure VM via Terraform (`infra/vm/`), Managed Identity → Key Vault, NSG deny-inbound, Cloudflare Tunnel ingress + Caddy reverse proxy, CD via `az vm run-command`, migrate-on-deploy, a "hello world" `api` live end-to-end. *Prove the pipeline before the bulk of the app logic.*

**Phase 1 — Identity & tenancy**
Zitadel deployed (Docker Compose on the VM); tenant + user model with RLS; OIDC login; admin role; audit events for login/logout.

**Phase 2 — Device keys & recovery**
Client MLS key generation; KeyPackage upload; key directory; passphrase-encrypted backup + recovery flow.

**Phase 3 — 1:1 encrypted text**
Self-hosted Postgres on the VM; encrypt → store ciphertext → WSS delivery → offline catch-up → delivery status. Redis backplane (the realtime bus).

**Phase 4 — Encrypted images**
Client-side image encryption; presigned upload to object storage; encrypted metadata message; recipient download + decrypt.

**Phase 5 — Harden & observe**
NSG deny-inbound + Cloudflare edge, CSP/SRI, rate limiting, Prometheus + Loki + Grafana dashboards, Sentry, backups with a **tested restore**, basic DR runbook.

**Phase 6 — Productize**
Multi-tenant onboarding polish, per-tenant SSO config UI, Web Push notifications, security page (protocol + bundle hashes), pen-test prep.

---

## 18. Future / North-Star (not now)

Group chat (MLS makes it incremental), multi-device sync, optional per-tenant compliance mode, multi-region / zone-redundant deploy, Azure sovereign-operator (Delos/Bleu) deployment for stricter buyers, native apps if a buyer demands the stronger code-delivery trust model.

---

## 19. The One Design Principle

> The server operates the platform; the clients own message privacy.
