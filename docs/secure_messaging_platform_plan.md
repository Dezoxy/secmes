# Secure Messaging Platform — Architecture Plan v2

> Supersedes `aws_secure_internal_messaging_architecture_plan.md` (kept as history / north-star).
> This version reflects the decisions made: PWA-only, true E2EE (single device in v1), multi-tenant SaaS sold to other companies, privacy-first, EU-hosted. _(The original **Kubernetes learning goal** was dropped 2026-06 — see the banner.)_
>
> **⚠️ Composition update (2026-06 — supersedes the AKS / managed-data sections below):** Kubernetes/AKS was **dropped** as solo-dev overhead, and so were the **Azure managed data services** (managed Postgres / Cache). The deploy target is now a **single Azure VM** running **self-hosted Postgres + Redis + Zitadel** via Docker Compose; attachment blobs live on **Backblaze B2** (S3-compatible, EU `eu-central-003`, private buckets; MinIO locally); DB backups on a separate private EU B2 bucket; secrets in **Azure Key Vault**, fetched by the VM's **Managed Identity** and delivered as credential files (never env/Helm). **Azure stays** (the VM + Key Vault + Entra). The detailed AKS / Helm / Argo CD / managed-data sections below are **legacy** — read them as history. Canonical: `AGENTS.md` → _Stack & conventions_.

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
| Orchestration | **Single Azure VM** + Docker Compose (EU) _(AKS legacy)_ |
| Deploy | **Docker Compose** on the VM (Caddy for TLS) _(Helm + Argo CD legacy)_ |

**Why Azure (and the privacy trade you're accepting):** AKS gives you a **free control plane**, managed **Postgres / Blob / Key Vault** (far less ops than self-hosting), native **Entra ID** alignment for the Microsoft-shop companies you're selling to, and enterprise-standard cloud-native skills that transfer to any job. The honest cost: Azure is **US-owned**, so your privacy story shifts from *"EU-owned provider"* to *"E2EE (the cloud only ever holds ciphertext + metadata) + EU Data Boundary + a German region."* That's defensible, but a notch weaker than Hetzner/Scaleway on pure sovereignty. For stricter buyers later you can deploy via an Azure sovereign operator (Delos/Bleu) or move just the data plane to an EU-owned provider — Terraform + Helm keep you portable either way.

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
                   Azure Standard Load Balancer (EU region)
                                  |
                                  v
                     Ingress (ingress-nginx)
                     TLS via cert-manager (Let's Encrypt)
                                  |
        +-------------------------+--------------------------+
        |              |                |                    |
        v              v                v                    v
     web (PWA)        api          realtime (WS)          zitadel
   static assets    NestJS      WebSocket gateway     identity (OIDC)
        |              |                |                    |
        |              +-------+--------+--------+           |
        |                      |                 |           |
        v                      v                 v           v
   (served via       Azure DB for Postgres    Redis    (zitadel db on
    ingress/CDN)       Flexible Server      (backplane)  same managed PG)
                              |
                              v
                     Azure Blob Storage (EU region)
                       encrypted image blobs

  Cluster: AKS (Germany West Central / West Europe).
  Managed data services reach the cluster over Private Endpoints in the VNet.
```

---

## 6. Kubernetes Architecture (the learning core)

### 6.1 Cluster
- **Service:** Azure Kubernetes Service (AKS), **Free control-plane tier** to start (move to the SLA-backed Standard tier later).
- **Region:** **Germany West Central** (Frankfurt) for the strongest EU data-residency story, or **West Europe** (Netherlands) for widest service/capacity. Pin every data service to the same region.
- **Node pools:** a small **system** pool + an autoscaling **user** pool. Start on burstable **B2ms/B2s** VMs for cost; move to **D-series** for steady load. Cluster Autoscaler on the user pool.
- **CNI:** **Azure CNI powered by Cilium** — eBPF dataplane + **NetworkPolicy enforcement** (you still learn and apply policies) without wiring a CNI by hand.
- **Pod identity:** **Microsoft Entra Workload ID** (federated, no secrets in pods) — the Azure equivalent of AWS IRSA. Use it for every pod → Azure access (Key Vault, Blob, ACR, Postgres).
- **Self-hosted fallback:** if you ever want the deeper "wire it yourself" learning, k3s on EU-owned hardware (Hetzner/Scaleway) stays portable — your Helm charts don't change.

### 6.2 Namespaces
```text
argus          # app workloads
data            # redis backplane (Postgres & Blob are managed Azure services)
identity        # zitadel
platform        # ingress, cert-manager, external-secrets, reloader
observability   # prometheus, grafana, loki
argocd          # gitops controller
```

### 6.3 Workloads
| Workload | Type | Notes / what it teaches |
|---|---|---|
| `web` | Deployment (nginx serving PWA build) | Ingress, static serving, cache headers |
| `api` | Deployment + HPA | Stateless scaling, readiness/liveness probes |
| `realtime` | Deployment + HPA | Scaling **stateful WebSocket** connections, sticky sessions, Redis backplane |
| `worker` | Deployment + CronJobs | Web Push, attachment GC, KeyPackage replenishment — teaches Jobs/CronJobs |
| `zitadel` | Helm release | Running a real stateful third-party app |
| Postgres | **Azure DB for PostgreSQL Flexible Server** (managed, not in-cluster) | Reliability + backups + PITR without the ops; reached via Private Endpoint |
| `redis` | Deployment/StatefulSet | Pub/sub backplane for realtime fanout (or Azure Cache for Redis) |
| _(operator option)_ | CloudNativePG in-cluster | Only if you want the StatefulSet/operator learning instead of managed |

### 6.4 Platform add-ons (your K8s curriculum)
```text
ingress-nginx                # ingress, TLS, WebSocket + sticky sessions
                             #   (or App Gateway Ingress Controller for a managed WAF — pricier)
cert-manager                 # automated Let's Encrypt TLS
Secrets Store CSI + Key Vault# secrets pulled from Azure Key Vault via Workload ID
Azure Monitor managed Prometheus + Managed Grafana   # metrics + dashboards (native)
Container Insights / App Insights   # logs + app traces + error tracking
Argo CD                      # GitOps  (or the AKS-managed Flux extension)
Reloader                     # roll pods on config/secret change
metrics-server + HPA + Cluster Autoscaler   # scaling
Cilium (via Azure CNI)       # dataplane + NetworkPolicy enforcement
```

### 6.5 Pod-level security (standard, learn it once, apply everywhere)
```text
NetworkPolicies (default-deny, then allow per-path)
Pod Security Standards: restricted
runAsNonRoot, readOnlyRootFilesystem, drop ALL capabilities
resource requests + limits on every container
image scanning (Trivy) in CI; only signed/scanned images deploy
short-lived tokens; no long-lived cloud keys in pods
```

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

- **Zitadel** self-hosted in the `identity` namespace — built for multi-tenant federation, keeps identity data on infra you control, stays portable. *(Azure-native alternative: Entra External ID — managed CIAM, but more lock-in. Either way, customers' own Entra/Okta/Google federate in.)*
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

- Dedicated `realtime` gateway (separate Deployment) holds WebSocket connections.
- **Redis pub/sub backplane** so any `realtime` pod can deliver to a connection held by another pod → horizontal scaling.
- Ingress configured for **sticky sessions** + WebSocket upgrade.
- Offline users: messages persist as ciphertext; delivered on reconnect.
- Presence/typing indicators: optional, off by default (privacy).

---

## 11. Observability (without leaking content)

**Log:** request id, tenant id, user id, service, operation, status, latency, error category, message id.
**Never log:** message text, image data, plaintext metadata, private keys, tokens, full auth headers, presigned URLs.

Stack (Azure-native): OpenTelemetry → **Azure Monitor managed Prometheus** + **Azure Managed Grafana** (metrics + dashboards) + **Container Insights** (logs) + **Application Insights** (traces + error tracking). Portable alternative: self-host kube-prometheus-stack + Loki + Grafana + Sentry. Watch Log Analytics ingestion cost — set retention and a daily cap.

---

## 12. CI/CD + GitOps

```text
push / PR
  └─ lint, unit + integration tests, typecheck
  └─ SAST + dependency scan
  └─ build container images
  └─ Trivy image scan
  └─ push to Azure Container Registry (ACR)   # GitHub Actions → Azure via OIDC, no stored creds
merge to main
  └─ update image tags in the GitOps repo
  └─ Argo CD (or AKS-managed Flux) syncs the cluster to match Git
     (auto to staging, manual gate to prod)
```

Tools: GitHub Actions (OIDC federation to Entra — no stored Azure secrets), Helm, Argo CD / Flux, ACR, Trivy, Checkov (manifest scanning), Renovate (dep updates).

---

## 13. Repository / IaC Structure

```text
infra/
  terraform/            # azurerm: RG, VNet, AKS, ACR, Postgres Flexible Server,
                        #   Key Vault, Storage Account, Private Endpoints, DNS, Workload ID
  bootstrap/            # cluster add-ons (ingress-nginx, cert-manager, CSI, Argo CD)
charts/
  argus/               # umbrella Helm chart (web, api, realtime, worker)
  platform/             # cert-manager, ingress, external-secrets values
gitops/                 # Argo CD app-of-apps, per-env values
apps/
  web/                  # React + Vite PWA
  api/                  # NestJS
  realtime/             # WebSocket gateway
  worker/               # background jobs
  packages/
    crypto/             # MLS wrapper, shared client/server
    contracts/          # shared TS types + Zod schemas (the E2EE envelope)
.github/workflows/
```

The `packages/contracts` shared types are the concrete payoff of going TypeScript end-to-end — client and server can never disagree on the encrypted envelope.

---

## 14. Threat Model

| Threat | Protection |
|---|---|
| Database leak | Ciphertext only; RLS limits blast radius per tenant |
| Object storage leak | Client-side encryption + private buckets + presigned-only access |
| Cross-tenant access | Postgres RLS + tenant context per request |
| Stolen infra credentials | Least-privilege, no long-lived keys in pods, audit logs |
| Compromised pod | NetworkPolicies (default-deny), restricted PSS, non-root |
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
AKS control plane (Free tier)             $0
Nodes: 2–3× B2ms (burstable, autoscale)   ~$120–180
Azure DB for PostgreSQL (B1ms/B2s)        ~$25–60
Azure Cache for Redis (Basic C0)          ~$16   (or in-cluster Redis $0)
Standard Load Balancer                    ~$20   (avoid App Gateway WAF_v2 ~$250+ in beta)
Blob Storage + egress                     ~$10
Azure Container Registry (Basic)          ~$5
Azure Monitor / Log Analytics             ~$10–30 (set caps!)
------------------------------------------------
Total                                     ~$200–320 / month
```

~4–5× the Hetzner option, but you get managed Postgres/Blob/Key Vault (less ops), native Entra alignment for B2B buyers, and enterprise-standard cloud-native skills. Cost levers: burstable nodes, in-cluster Redis, skip App Gateway WAF, a spot node pool for non-critical workloads, reserved instances once load is steady.

---

## 17. Phased Delivery (ship *and* learn K8s in stages)

**Phase 0 — Cluster & pipeline (learn the platform)**
AKS via Terraform (azurerm), Azure CNI + Cilium, Entra Workload ID, ingress-nginx + cert-manager (TLS working), ACR, Argo CD, a "hello world" pod deployed end-to-end via GitOps. *Prove the pipeline before any app logic.*

**Phase 1 — Identity & tenancy**
Zitadel deployed; tenant + user model with RLS; OIDC login; admin role; audit events for login/logout.

**Phase 2 — Device keys & recovery**
Client MLS key generation; KeyPackage upload; key directory; passphrase-encrypted backup + recovery flow.

**Phase 3 — 1:1 encrypted text**
Azure DB for PostgreSQL (Private Endpoint); encrypt → store ciphertext → `realtime` WSS delivery → offline catch-up → delivery status. Redis backplane; HPA on `realtime`.

**Phase 4 — Encrypted images**
Client-side image encryption; presigned upload to object storage; encrypted metadata message; recipient download + decrypt.

**Phase 5 — Harden & observe**
NetworkPolicies (default-deny), CSP/SRI, rate limiting, kube-prometheus-stack + Loki + Grafana dashboards, Sentry, backups with a **tested restore**, basic DR runbook.

**Phase 6 — Productize**
Multi-tenant onboarding polish, per-tenant SSO config UI, Web Push notifications, security page (protocol + bundle hashes), pen-test prep.

---

## 18. Future / North-Star (not now)

Group chat (MLS makes it incremental), multi-device sync, optional per-tenant compliance mode, multi-region + zone-redundant AKS, Azure sovereign-operator (Delos/Bleu) deployment for stricter buyers, native apps if a buyer demands the stronger code-delivery trust model.

---

## 19. The One Design Principle

> The cluster operates the platform; the clients own message privacy.
