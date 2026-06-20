# Article 30 Records of Processing Activities

**Controller**: Argus Secure Messaging (operator entity — fill in legal name)  
**DPO contact**: dpo@[operator-domain] (fill in)  
**Last updated**: 2026-06-19  
**Regulation**: GDPR Art. 30(1)

---

## 1. Identity and contact details

| Role | Details |
|---|---|
| Controller | [Operator legal name, address] |
| DPO | [DPO name, email] |
| Processor (infra) | Microsoft Azure — EU (Germany West Central) |
| Processor (blob storage) | Backblaze B2 — EU (eu-central-003) |
| Processor (error tracking) | GlitchTip — self-hosted on same VM |

> **No external identity processor.** OIDC/Zitadel was decommissioned (#223, `phase-6-decommission.md`); authentication is now in-process passkey (WebAuthn) — there is no third-party or sub-processor for identity.

---

## 2. Purposes of processing

| Purpose | Legal basis | Notes |
|---|---|---|
| Provide end-to-end encrypted messaging | Art. 6(1)(b) — contract | Core service |
| Account management (registration, login, settings) | Art. 6(1)(b) — contract | |
| Delivery receipts and read confirmations | Art. 6(1)(b) — contract | Metadata only |
| Attachment storage | Art. 6(1)(b) — contract | Ciphertext only |
| Security audit logging | Art. 6(1)(f) — legitimate interest | Actor + event type + IDs; no content |
| GDPR data export (Art. 20 portability) | Art. 6(1)(c) — legal obligation | Metadata only |
| GDPR account deletion (Art. 17 erasure) | Art. 6(1)(c) — legal obligation | |
| Error tracking / observability | Art. 6(1)(f) — legitimate interest | No content, no tokens in logs |
| Web Push notification delivery | Art. 6(1)(b) — contract | Endpoint URL prefixes only |

---

## 3. Data subjects and categories of personal data

| Category | Data subjects | Data elements | Sensitivity |
|---|---|---|---|
| Account identity | Users | argus ID, display name (pseudonymous handle), avatar seed, tenant ID | Low |
| Authentication | Users | WebAuthn passkey credentials (COSE public key, credential ID, sign counter); persisted refresh sessions (`auth_sessions`: SHA-256 refresh-token hash, 30-day expiry) | High |
| Devices | Users | Device UUID, public signature key, creation timestamp | Low |
| Messages | Users | Ciphertext blob (opaque), conversation ID, sender UUID, timestamp, epoch | Content: not accessible to server |
| Attachments | Users | Object key, byte size, conversation ID, timestamps | Content: not accessible to server |
| Audit events | Users | Actor sub, event type, IDs in metadata, timestamp | Low |
| Push subscriptions | Users | Endpoint URL (capability URL — access-granting), p256dh public key, auth secret | Medium |
| Invites | Users | Single-use invite tokens (SHA-256 hashed at rest), timestamps | Low |

**Note on push subscriptions**: the full endpoint URL is a capability URL and must be treated as a credential. It is never returned in exports (only the first 40 chars are exported for identification). It is never logged.

**Note on legacy email / IdP columns**: the `users.email`, `users.external_identity_id`, and `tenant_invites.invitee_email` columns are retained in the schema but were **nulled out** by migration `0039_decommission_enterprise.sql`. Under passkey auth no email is collected at registration, and invites are **bearer-only** (the redeem path reads no email hint). These columns hold no personal data going forward.

---

## 4. Recipients

| Recipient | Data shared | Safeguard |
|---|---|---|
| Microsoft Azure (VM compute, Key Vault) | Encrypted-at-rest data volumes | DPA + EU region pinned (germanywestcentral) |
| Backblaze B2 (blob storage) | Encrypted attachment blobs (ciphertext only) | DPA + EU region (eu-central-003) |
| GlitchTip (self-hosted error tracking) | Stack traces, error metadata (no content, no tokens) | Same VM, EU, no third-party transfer |

No personal data is transferred to third countries outside the EU/EEA.

---

## 5. Retention periods

| Data category | Retention | Basis |
|---|---|---|
| User account (profile, devices, memberships) | Until erasure request or account deletion | Art. 6(1)(b) |
| Messages (ciphertext) | Indefinite until sender exercises erasure (then pseudonymized — sender_user_id → NULL) | Art. 6(1)(b) |
| Attachment blobs | 7 days from creation (Backblaze lifecycle rule) | Proportionality |
| Attachment metadata rows | Until uploader exercises erasure | Art. 6(1)(b) |
| Audit events | 90 days from event creation (rolling window, enforced by the `argus-audit-prune` systemd-timer worker; see `docs/threat-models/audit-logging.md`) | Proportionality + Art. 6(1)(f) |
| Auth sessions | 30 days past expiry (rolling window, same prune worker) | Proportionality + Art. 6(1)(f) |
| Push subscriptions | Until device deletion or account deletion | Art. 6(1)(b) |
| Error tracking events | 30 days (GlitchTip default) | Proportionality |
| Backups (encrypted DB snapshots) | 30 days (Backblaze backup bucket lifecycle) | Operational necessity |

---

## 6. Technical and organisational security measures (Art. 30(1)(g))

- **End-to-end encryption**: all message content is encrypted on-device using MLS before reaching the server. The server is crypto-blind.
- **Encryption at rest**: Azure managed disk encryption (AES-256) for the VM volume; Backblaze server-side encryption for blobs.
- **Encryption in transit**: TLS 1.2+ enforced via Cloudflare Tunnel (no public ports).
- **Access control**: per-tenant PostgreSQL Row-Level Security enforced for all tenant-scoped tables. No cross-tenant query path exists.
- **Secrets management**: secrets delivered from Azure Key Vault via Managed Identity as credential files — never in environment variables or source code.
- **Authentication**: passkey (WebAuthn) — the API mints and verifies its own EdDSA session tokens (no external IdP); access tokens are re-verified on every request (`auth.service.ts`).
- **Audit logging**: security-relevant events (login, device registration, invite actions, admin actions) are logged with actor sub, event type, and IDs — never content. Retention is bounded to 90 days and enforced by the `argus-audit-prune` worker.
- **Vulnerability management**: automated scanning via Semgrep, OSV, Trivy, Checkov, gitleaks, 42Crunch, CodeQL on every PR; nightly DAST.
- **Erasure**: self-service account deletion (Art. 17) available via `DELETE /me`; messages are pseudonymized (sender → NULL), blobs deleted best-effort.
