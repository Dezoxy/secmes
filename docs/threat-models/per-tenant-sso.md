# Threat model: G2 Per-tenant SSO

> **RETIRED (Phase 6, 2026-06-17).** The per-tenant SSO feature was removed in the enterprise teardown —
> auth is passkey-only now. The SSO module, `tenant_sso_configs` table, and Zitadel management client are
> gone. Kept for history; see `docs/threat-models/phase-6-decommission.md`.

## Scope

G2 adds per-tenant OIDC SSO: each tenant admin can configure their org's OIDC IdP (Entra/Okta/Google/generic OIDC). Argus lazily provisions one Zitadel org + IdP per tenant on first configuration and exposes a set of admin-only endpoints for lifecycle management (create, update, rotate secret, delete).

---

## Invariant checklist

### 1 — Server crypto-blind

No message content or crypto material passes through SSO config endpoints. The SSO endpoints deal with metadata only (provider name, issuer URL, client ID). The `client_secret` is **write-only**: it arrives in the request body, is forwarded to Zitadel as-is via the Management API, and is **zeroed in a `finally` block immediately after the API call completes**. It is never written to our DB, never logged, and never returned in any response. Response DTOs carry no `clientSecret` field.

### 2 — No secrets logged

The SSO service logs only: `deleteOrg` warnings (with the Zitadel org ID, which is not secret) and the `ZITADEL_MANAGEMENT_PAT_FILE` path (on read failure, never the value). The Zitadel Management PAT is loaded from a credential file (`ZITADEL_MANAGEMENT_PAT_FILE`), never from an env var committed to source. NestJS request logging via the existing scrubber already strips `Authorization` headers.

### 3 — RLS + tenant isolation

`tenant_sso_configs` has `FORCE ROW LEVEL SECURITY` with a policy scoped to `current_setting('app.tenant_id')`. `withTenant(auth.tenantId, tx => ...)` sets this session variable. The unique constraint on `tenant_id` means one config per tenant — no cross-tenant access or shared configs.

### 4 — No hand-rolled crypto

No cryptography in this feature. The Zitadel Management API (HTTPS) handles the IdP credential storage; Zitadel encrypts `client_secret` under its masterkey in its own DB.

### 5 — Secrets from Key Vault via Managed Identity

`ZITADEL_MANAGEMENT_PAT_FILE` is populated from Azure Key Vault secret `argus-zitadel-management-pat` by `fetch-keyvault-secrets.sh`. Seeded empty on first boot (SSO endpoints return 503 until provisioned). Never a committed env file. Local dev uses the bootstrap admin PAT appended to `api.env.local` by `provision.sh`.

### 6 — No admin path to content

SSO endpoints expose no message content, no keys, no ciphertext. Responses carry only provider metadata and the login URL.

---

## Key flows and risks

### SSRF via `issuerUrl`

**Risk:** A malicious admin could supply an `issuerUrl` pointing at internal services (the Zitadel container, Postgres, Redis, 169.254.169.254 IMDS).

**Mitigation:** `validateIssuerUrl()` in `sso.service.ts` enforces:
- `https:` scheme required
- Blocked hostnames: `localhost`, `zitadel`, `postgres`, `redis`, `minio`
- Blocked suffixes: `.local`, `.internal`
- Blocked by regex: RFC-1918 ranges (10/8, 172.16-31/12, 192.168/16), loopback (127.x, ::1)

**Residual:** Custom internal services not in the hostname blocklist. Hardening note: the Zitadel client only calls the provisioned `issuerUrl` during OIDC login (browser-side), not during server-side provisioning — the server sends issuer/clientId/secret to the Zitadel Management API via the internal Docker network; Zitadel, not us, makes the federation call to the external IdP's well-known endpoint at login time. The SSRF guard prevents poisoning Zitadel into calling internal services via a crafted issuerUrl.

### Invite-first invariant

**Risk:** SSO could bypass the invite requirement and allow unauthorized users to join a tenant.

**Mitigation:** SSO changes *how* an already-invited user authenticates, not *whether* they can join. The `acceptInvite` → `user_tenant_index` binding flow is unchanged. A user who successfully authenticates via SSO but has not accepted an invite gets `{ bound: false }` from `GET /me` and is blocked at the `OnboardingGate`. SSO does not bypass the `user_tenant_index` lookup in `tenants.service.ts`.

### Zitadel org orphaning

**Risk:** If org creation succeeds but IdP creation or DB insert fails, a Zitadel org exists without a corresponding DB row, leaking Zitadel resources.

**Mitigation:** `createSsoConfig` attempts `deleteOrg(orgId)` in the `catch` block before re-throwing. If the cleanup call also fails, it is logged as a warning and the error is re-thrown (the DB row was never inserted, so no inconsistent state exists on our side). Operators can find orphaned orgs in the Zitadel console and delete them manually.

### Management PAT scope

**Current scope:** The bootstrap admin PAT (used in local dev) is IAM_OWNER scoped. The production PAT should ideally be scoped to org-management only.

**Hardening note (post-G2):** Provision a dedicated Zitadel service user scoped to `org.write`, `idp.write`, `policy.write` on the default org context, rather than IAM_OWNER. Track in roadmap G2b.

### `client_secret` in transit

`browser → API`: HTTPS (Cloudflare TLS termination + internal Docker network TLS-free but container-only). `API → Zitadel`: internal Docker network (no encryption needed — both containers are on the same host; the network is private).

At rest: Zitadel encrypts under its 32-byte masterkey (Chacha20-Poly1305). Our DB stores `client_id` only; no secret at rest on our side.

### SSO login URL disclosure

The login URL (`<appBaseUrl>/?orgID=<zitadelOrgId>`) exposes the Zitadel org ID. This is intentionally semi-public: the admin copies it to share with their team. The org ID is not sensitive — it scopes the Zitadel login page, does not grant any access. The `organization_id` extraQueryParam is read client-side from `?orgID` and is forwarded to Zitadel OIDC auth request by the SPA.

---

## Data stored in `tenant_sso_configs`

| Column | Sensitivity | Notes |
|--------|-------------|-------|
| `zitadel_org_id` | Low | Zitadel resource ID; semi-public in the login URL |
| `zitadel_idp_id` | Low | Zitadel internal reference; not exposed externally |
| `provider_name` | Low | Admin-chosen display name |
| `issuer_url` | Low | The IdP's public OIDC endpoint |
| `client_id` | Low-medium | Returned in GET response; not secret per OIDC spec |
| `login_url` | Low | Shared with team members |
| **No `client_secret`** | — | Stored in Zitadel only, never in our DB |
