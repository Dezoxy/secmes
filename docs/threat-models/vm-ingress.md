# Threat model: production ingress topology (Slice 2)

> Status: **DRAFT for ratification.** The production runtime topology (roadmap Phase 0, checkpoint 4):
> the `compose.prod.yaml` stack, the Caddy single-origin router, and the cloudflared outbound tunnel.
> **Build-only** — this slice defines the topology as code; nothing is deployed. Secret *values* and the
> Key Vault → credential-file wiring are Slice 3 (this slice references file/env placeholders only).
> Cross-references the infra-foundation threat model in `vm-deploy.md` (slice 1).

## 1. Feature & data flow

```
                 TLS + WAF + rate-limit          outbound QUIC tunnel
users ─────▶ Cloudflare edge ───────────────▶ cloudflared ──────────┐  (no inbound port on the VM)
 (HTTPS)      (4rgus.com, admin.* etc.)        (container)           │
                                                                     ▼
                                               Caddy :80 (plain HTTP, internal docker network only)
                                                 ├─ /api/*  → strip /api → api:3000   (REST)
                                                 ├─ /ws*    →           → api:3000   (WebSocket upgrade)
                                                 └─ /*      → file_server /srv (PWA, SPA fallback)
                                                                     │
                                   api:3000 ──▶ postgres / redis (internal network, NO published ports)
                                   api:3000 ──▶ Backblaze B2 (egress, presigned) ; Zitadel (OIDC, internal)
```

The browser only ever talks to the **Cloudflare edge** over HTTPS. Cloudflare terminates TLS and runs the
WAF + edge rate-limit, then forwards to **cloudflared**, which holds an **outbound** tunnel to Cloudflare —
so the VM opens **no inbound port** (the NSG denies all inbound; see `vm-deploy.md`). cloudflared forwards to
**Caddy** over the internal Docker network in plain HTTP; Caddy is the single origin that serves the PWA and
proxies `/api` + `/ws` to the API. Message content on this path is **E2EE ciphertext** end to end — Caddy and
the API are crypto-blind (server stores/forwards ciphertext only; invariant #1).

## 2. Assets & trust boundaries

- **Assets:** the runtime secrets consumed by the stack (DB password, B2 secret key, Zitadel masterkey,
  cloudflared tunnel token); the integrity of what Cloudflare forwards; availability of the ingress.
- **Boundaries:**
  - internet ↔ Cloudflare edge (TLS, WAF) — Cloudflare is trusted infrastructure.
  - Cloudflare ↔ cloudflared (authenticated tunnel; token-based, remotely-managed).
  - cloudflared ↔ Caddy ↔ api (intra-VM Docker network — a single trust zone on one host).
  - api ↔ postgres/redis (intra-VM; **not** reachable off-host — no published ports).
  - admin surfaces (Zitadel console, future ops) ↔ users — gated by **Cloudflare Access** at the edge.

## 3. Threats (STRIDE-lite)

- **Spoofing the origin / bypassing the edge.** If the VM published ports, an attacker could hit Caddy or
  Postgres directly and skip Cloudflare's WAF/rate-limit/Access. → The NSG denies all inbound and
  `compose.prod.yaml` publishes **no host ports** (cloudflared is outbound-only; Caddy and the data services
  are reachable only on the internal Docker network). The only path in is the authenticated tunnel.
- **Tampering / info-disclosure in transit.** → TLS terminates at Cloudflare; the Cloudflare↔cloudflared leg
  is an authenticated tunnel; the internal cloudflared↔Caddy↔api legs are plain HTTP but never leave the
  host's Docker network. Message bodies are E2EE ciphertext regardless of the transport.
- **Info-disclosure of secrets.** A leaked DB/B2/Zitadel/tunnel secret compromises the stack. → No secret
  values live in `compose.prod.yaml` or the image. Data-plane secrets are **mounted credential files**
  (Docker secrets) the app reads via `*_FILE` (`POSTGRES_PASSWORD_FILE`, `DATABASE_URL_FILE`,
  `S3_SECRET_ACCESS_KEY_FILE`) — never the value in env. The cloudflared `TUNNEL_TOKEN` is a
  **runtime-fetched value** (the image has no shell/`--token-file`), injected from the deploy environment, not
  an on-disk env file. All are populated out-of-band (Slice 3: Key Vault via Managed Identity).
  `.env.prod.example` carries placeholders only. Non-secret config (B2 access-key-**id**, region, bucket,
  issuer URL, public origin) may ride env per invariant #5. Logs carry IDs/metadata only (invariant #2); the
  tunnel token is never logged.
- **Elevation via a compromised container.** A breakout from api/Caddy must not trivially own the host or
  reach more than it needs. → Containers run **non-root** with `no-new-privileges`, `cap_drop: [ALL]`,
  read-only root FS where feasible, and resource limits. Data services hold ciphertext + metadata only (RLS
  per tenant).
- **DoS / volumetric flood.** → Absorbed at the Cloudflare edge (WAF + rate-limit) before it reaches the
  tunnel; this is the edge tier that the API's per-user throttler (#46) deliberately delegates unauth-flood
  protection to. Caddy adds request timeouts; the VM has no open port to flood directly.
- **Admin surface exposure.** Zitadel console / future ops UIs must never be world-reachable. → Published on
  admin subdomains gated by **Cloudflare Access** (identity at the edge) — and never exposing message content
  (invariant #6). Admin routing is dashboard-managed alongside the app hostname.

## 4. Invariant check (CLAUDE.md ×6)

1. **Crypto-blind server** — ✅ Caddy/api forward ciphertext; no decryption added.
2. **No secret/plaintext logging or persistence** — ✅ no secret values in compose/image; tunnel token,
   DB/B2/Zitadel secrets are file/env-injected out-of-band; logs are IDs/metadata only.
3. **tenant_id + RLS on tenant tables** — N/A (no schema change); the data services that enforce it run
   with no off-host exposure.
4. **No hand-rolled crypto** — ✅ none introduced; TLS is Cloudflare's, MLS stays in `packages/crypto`.
5. **Secrets via Key Vault + Managed Identity as files** — ✅ data-plane secrets are mounted credential
   **files** (`*_FILE`), the tunnel token a runtime-fetched value; no secret rides a committed env file. The
   actual Key Vault wiring is Slice 3. Placeholders only in this slice; **no committed secrets**.
6. **No admin path to content** — ✅ admin surfaces (Zitadel/ops) are metadata-only and gated by Cloudflare
   Access; no content endpoint is exposed to admins.

## 5. Decision & mitigations

Ship the topology as code, gated and undeployed. Must-hold mitigations baked into this slice:

- **No published host ports** in `compose.prod.yaml` (cloudflared outbound-only; Caddy + data services
  internal). This is the single most important control — it forces all traffic through the Cloudflare edge.
- **Container hardening** — non-root, `no-new-privileges`, `cap_drop: [ALL]`, read-only FS where feasible,
  restart policy, resource limits.
- **No secret values** anywhere in the tree; placeholders + `.env.prod.example` only. Real values land via
  Slice 3 (Key Vault → credential files).
- **Single origin** — Caddy is the only thing cloudflared talks to; `/api` strip + `/ws` upgrade + SPA
  fallback. No CORS surface (same-origin), matching the PWA's same-origin assumption.

Reviewer: **infra-reviewer** (Compose, Dockerfile, Caddyfile, ingress posture). CI gates: Checkov
(Dockerfile — note Checkov has **no** docker-compose framework, so `compose.prod.yaml` is **not** statically
scanned; a compose-aware gate, e.g. `docker compose config -q` + a Trivy `config` scan, is a Slice-4 CI
addition), gitleaks (no secrets), Semgrep. Not deployed — `vars.ENABLE_DEPLOY` stays off.

## 6. Residual risk

- **Plain-HTTP internal hop (cloudflared↔Caddy↔api).** Acceptable: single-host Docker network, no off-host
  exposure, content is E2EE ciphertext. mTLS on the internal hop is enterprise-grade optional.
- **Single host = single failure domain.** No HA; a VM loss is an outage (data recoverable from the nightly
  encrypted B2 backup). Accepted for this phase; multi-host/managed-data is the enterprise-grade path.
- **Image build verified locally; CI/CD wiring deferred.** The Caddy image was built and run end-to-end
  (`docker build` clean, runs **non-root** as `caddyapp` on `:8080`, serves the PWA with SPA fallback +
  `/caddy-healthz` 200); `compose.prod.yaml` passes `docker compose config` and the Caddyfile passes `caddy
  validate`. Building + scanning + pushing the image in CI and pulling it on the VM lands in Slice 4. The api
  image still carries its Phase-0 self-contained-build TODO (separate concern, not widened here).
- **Cloudflare as trusted edge / dependency.** TLS, WAF, Access, and availability lean on Cloudflare; a
  Cloudflare outage is an ingress outage, and the edge sees TLS-terminated *metadata* (never plaintext —
  content is E2EE). Accepted as the cost of the no-inbound-port model.
