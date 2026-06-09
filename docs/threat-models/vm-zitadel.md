# Threat model: self-hosted Zitadel on the VM (checkpoint 9)

> Status: **DRAFT for ratification.** Stands up the production identity provider (roadmap Phase 1,
> checkpoint 9): the `zitadel` + `zitadel-db` + `zitadel-login` services in `compose.prod.yaml`, the
> `auth.4rgus.com` ingress through Caddy, and the masterkey/DB secrets from Key Vault. **Build-only** —
> this defines the IdP as code; nothing is deployed (`vars.ENABLE_DEPLOY` off). Extends `vm-ingress.md`
> (the single-origin topology) and `auth-tenant-context.md` (how the API consumes the issued JWT).
> The local stand-in is `compose.yaml` + `infra/local/zitadel/` (see `docs/local-auth.md`).

## 1. Feature & data flow

Zitadel is the OIDC provider that authenticates human users and mints the JWT the SPA presents to the API.
It is **not** on the message path — it issues tokens; it never sees message content or keys.

```
                         TLS + WAF + rate-limit          outbound tunnel
browser ───HTTPS──▶ Cloudflare edge ───────────────▶ cloudflared ─────────┐  (no inbound port on the VM)
  (login)          (auth.4rgus.com, 4rgus.com)        (container)         │
                                                                          ▼
                                                Caddy :8080 (plain HTTP, internal docker net only)
                                                  ├─ Host 4rgus.com   → PWA + /api,/ws → api:3000
                                                  └─ Host auth.4rgus.com
                                                       ├─ /ui/v2/login* → zitadel-login:3000  (login screens)
                                                       └─ /*            → zitadel:8080        (OIDC/OAuth/JWKS/console)
                                                                          │
                                                  zitadel:8080 ──▶ zitadel-db:5432 (own Postgres, internal net, NO published port)
```

Login flow: the SPA (`oidc-client-ts`, Authorization-Code + PKCE, public client) redirects the browser to
`auth.4rgus.com`; the user authenticates against the hosted Login V2 UI; Zitadel returns a code; the SPA
exchanges it for a **JWT access token** carrying the verified `tenant_id` UUID (+ email/name) asserted by a
token Action. The API validates that JWT via JWKS (`iss`/`aud`/alg-allowlist/`exp`/`nbf`) and sets
`app.tenant_id` from the **verified** claim only (`auth-tenant-context.md`). TLS terminates at Cloudflare;
Caddy→Zitadel and Zitadel→its DB are plain HTTP/TCP on the internal Docker network. Zitadel is configured
`ExternalSecure=true` + `--tlsMode external` so it emits `https://auth.4rgus.com` issuer URLs while serving
plain HTTP behind the TLS-terminating edge.

## 2. Assets & trust boundaries

- **Assets:**
  - the **Zitadel masterkey** (32 bytes) — encrypts the encryption keys Zitadel stores in its DB (signing
    keys, stored OIDC client secrets, OTP seeds). Compromise → forge tokens / decrypt stored secrets. Loss →
    the instance's encrypted data is unrecoverable.
  - the **zitadel-db password** and the database itself (user records, sessions, the signing keys at rest).
  - the **issued JWT** integrity (its `tenant_id` claim is the tenant-isolation root for the whole API).
  - availability of login (an outage blocks all sign-in, but not already-issued sessions until expiry).
- **Boundaries:**
  - internet ↔ Cloudflare edge (TLS, WAF, edge rate-limit) — Cloudflare is trusted infrastructure.
  - Cloudflare ↔ cloudflared (authenticated, token-based, remotely-managed tunnel).
  - cloudflared ↔ Caddy ↔ zitadel ↔ zitadel-db (intra-VM Docker network — one trust zone on one host;
    **no published ports** on any of these).
  - **end user ↔ Zitadel admin** — the admin console is served from the same `auth.4rgus.com` host; it is
    protected by Zitadel's own authentication (an IAM_OWNER login), NOT exposed unauthenticated.
  - **Zitadel ↔ argus API** — the API trusts the JWT signature + issuer/audience, nothing else from the
    browser. A user from tenant A can never mint a token asserting tenant B's `tenant_id` (the Action sets
    it server-side from the user's org; the browser cannot influence it).

## 3. Threats (STRIDE-lite)

- **Spoofing:**
  - _Forged tokens_ — mitigated by asymmetric JWT signatures (the API pins `iss` + `aud` + an asymmetric-alg
    allowlist + JWKS). An attacker without the signing key (which is sealed under the masterkey) cannot mint
    a valid token.
  - _Phishing a fake `auth.4rgus.com`_ — out of scope here (DNS/TLS via Cloudflare); the real issuer is
    pinned in both the SPA build (`VITE_OIDC_ISSUER`) and the API (`OIDC_ISSUER`).
- **Tampering:**
  - _Tenant-claim injection_ — the SPA cannot set `tenant_id`; the Action asserts it from the authenticated
    user/org. The API casts the **verified** claim to `tenants.id` and never reads tenant from client input.
  - _Image tampering_ — the Zitadel/login/db images are pinned by tag (Dependabot-tracked); they are
    upstream images (not signed by our cosign identity like our own api/ingress). Pin + digest-pull is the
    control; see Residual risk.
- **Information disclosure:**
  - _Masterkey / DB password leak_ — both are delivered from Key Vault as files at runtime (never committed,
    never in an env file at rest). The masterkey is a Docker secret file (`--masterkeyFile`); logs carry
    names + HTTP status only (the secret-fetch script never logs values; invariant #2).
  - _DB exposure_ — zitadel-db has no published port; reachable only by the `zitadel` container on the
    internal network. At rest the signing keys are encrypted under the masterkey.
  - _Console data_ — the admin console exposes identity metadata (users, sessions) but **never** message
    content or message keys (those never reach Zitadel; invariant #6 holds — the IdP is not an admin path to
    content).
- **Elevation of privilege:**
  - _Container escape_ — every Zitadel service runs non-root + `no-new-privileges` + `cap_drop:[ALL]` (db
    re-adds only the caps the postgres entrypoint needs); zitadel + zitadel-login are read-only-root + tmpfs.
  - _DB role_ — Zitadel owns its own DB cluster; it has no access to the argus app DB and vice-versa
    (separate containers, separate volumes, separate networks-of-trust on the same host).

## 4. Invariant check

1. **Server crypto-blind** — Zitadel is off the message path; it issues tokens, never touches ciphertext or
   keys. ✔
2. **No secret logging/persistence** — masterkey + DB password come from Key Vault as a file / runtime value;
   the fetch script logs names + status only; no secret in an env file at rest. The DB-password runtime-env
   delivery reuses the **same accepted exception** as the cloudflared `TUNNEL_TOKEN` (a runtime-fetched value,
   not a committed/on-disk env file) — Zitadel has no `_FILE` env convention for the DB password. ✔ (noted)
3. **Tenant isolation** — Zitadel is the **source** of the `tenant_id` claim that drives RLS; the Action sets
   it server-side, the API trusts only the verified claim. No argus tenant table is added here. ✔
4. **No hand-rolled crypto** — Zitadel is an established IdP; we configure it, we do not implement crypto. ✔
5. **Secrets via Key Vault + Managed Identity** — masterkey + DB password are new Key Vault secrets fetched by
   the VM's Managed Identity (added to `fetch-keyvault-secrets.sh`). The non-secret issuer/audience/domain are
   env. ✔
6. **No admin path to content** — the Zitadel admin console is metadata-only (identities/sessions); message
   content/keys are E2EE and never reach the IdP. ✔

**Tension:** invariant #5 prefers credential **files** over env. The Zitadel→DB password is delivered as a
runtime env value (Zitadel exposes no `_FILE` form for it), matching the existing `TUNNEL_TOKEN` precedent.
The most sensitive secret — the masterkey — IS a file (`--masterkeyFile`). Splitting the Zitadel DB user vs
admin passwords and config-file delivery are enterprise-grade follow-ups (§6).

## 5. Decision & mitigations

Stand up `zitadel-db` + `zitadel` + `zitadel-login` in `compose.prod.yaml`, hardened, no published ports, own
volume; route `auth.4rgus.com` through Caddy (host-split, login UI under `/ui/v2/login`); deliver the
masterkey as a Docker secret file and the DB password as a Key-Vault-sourced file (postgres `*_FILE`) +
runtime env (Zitadel side). Gates: **`infra-reviewer`** (container hardening, no published data ports, secret
delivery, EU region), plus the standing CI (Checkov/Trivy/gitleaks). The API-side JWT validation is unchanged
and already covered by `auth-tenant-context.md`.

**Operational must-dos (documented in `docs/deploy.md`, enforced at arming, not in code):**

- **Generate the masterkey once** (32 bytes, CSPRNG), store it in Key Vault, and **never rotate it casually** —
  rotation requires Zitadel's documented key-re-encryption, and loss makes the instance's encrypted data
  unrecoverable. Back it up with the rest of the Key Vault material.
- **Provisioning** (project / SPA OIDC app / tenant-claim Action) and the **org→`tenant_id`** mapping are a
  one-time admin step against the live instance — **deferred to G1 (self-serve onboarding)**; today's local
  Action hardcodes a single dev tenant UUID, which is not the multi-tenant prod model.

## 6. Residual risk

- **Upstream image trust** — Zitadel/login/db are third-party images pinned by tag (not cosign-signed by our
  identity like api/ingress). Mitigation: Dependabot tracking + Trivy scan + digest pull. Acceptable: Zitadel
  is a widely-audited IdP; building it ourselves would be worse.
- **Single-host availability** — one VM; an outage blocks new logins (existing JWTs work until expiry).
  Multi-region/HA is the enterprise upgrade (B4), consistent with the rest of the single-VM deploy.
- **Masterkey single point of recovery** — if Key Vault and its backups are lost, the instance is
  unrecoverable. Acceptable for this phase; Key Vault soft-delete/purge-protection is the safety net.
- **DB-password as runtime env** — visible in the zitadel container's `/proc/<pid>/environ` (root-on-host
  only), same exposure class as `TUNNEL_TOKEN`. The config-file delivery + separate db roles are the
  enterprise-grade hardening.
- **Multi-tenant claim model unbuilt** — prod login works, but mapping real orgs to argus tenants is G1; until
  then the instance is single-tenant by configuration. Flagged, not hidden.
- **read-only root FS is untested for these images** — local dev runs zitadel/zitadel-login *without*
  `read_only`, so prod is the first place they run read-only-root. If either writes outside `/tmp` or the
  bootstrap volume it will crash-loop — which `wait_running` catches loudly (fails the deploy, never silently
  serves broken), so it fails closed. Smoke-test read-only in a scratch env before arming; drop `read_only`
  for that one service if it can't tolerate it.
