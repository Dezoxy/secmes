# Article 30 Records of Processing Activities

**Controller**: Argus Secure Messaging (operator entity — fill in legal name)  
**DPO contact**: dpo@[operator-domain] (fill in)  
**Last updated**: 2026-06-24  
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
| 1:1 voice calling (VoIP) | Art. 6(1)(b) — contract | E2EE audio (DTLS-SRTP, server crypto-blind); only call-routing **metadata** and transient relay 5-tuples are processed. V1 persists **no** call record. See `docs/threat-models/voip-calling.md` + `dpia-voip-calling.md`. |

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
| Call peer IP address (VoIP) | Users | Source IP/port 5-tuple processed **transiently in memory** by the self-hosted coturn relay during a call | High (personal data; **never logged or persisted**) |
| Call metadata (VoIP, V1.1) | Users | Caller/callee UUIDs, conversation ID, started/answered/ended timestamps — metadata only, no content, no SDP/keys | Low — **dormant in V1** (no `call_sessions` table ships until V1.1) |

**Note on call peer IP**: relay 5-tuples are inherent to running a TURN relay and are **transient only** — coturn runs `simple-log` (no verbose), logs no credentials, and its logs are excluded from the long-term Loki store. No IP is written to the database. The relay is crypto-blind (relays opaque DTLS-SRTP, holds no media key). See `docs/threat-models/voip-turn.md`.

**Note on push subscriptions**: the full endpoint URL is a capability URL and must be treated as a credential. It is never returned in exports (only the first 40 chars are exported for identification). It is never logged.

**Note on legacy email / IdP columns**: the `users.email`, `users.external_identity_id`, and `tenant_invites.invitee_email` columns are retained in the schema but were **nulled out** by migration `0039_decommission_enterprise.sql`. Under passkey auth no email is collected at registration, and invites are **bearer-only** (the redeem path reads no email hint). These columns hold no personal data going forward.

---

## 4. Recipients

| Recipient | Data shared | Safeguard |
|---|---|---|
| Microsoft Azure (VM compute, Key Vault) | Encrypted-at-rest data volumes | DPA + EU region pinned (germanywestcentral) |
| Backblaze B2 (blob storage) | Encrypted attachment blobs (ciphertext only) | DPA + EU region (eu-central-003) |
| GlitchTip (self-hosted error tracking) | Stack traces, error metadata (no content, no tokens) | Same VM, EU, no third-party transfer |
| Browser push services — Apple (APNs), Google (FCM), Mozilla autopush | **Content-free** push wake-ups (a `{type}` tag only — no caller, conversation, message text, or SDP). Selected per the subscriber's browser. Covers existing message-notification push; the VoIP **call-wake** branch is **V1.1** (V1 is foreground-ring only, sends no push). | Web Push protocol (RFC 8030); payloads carry no personal content. **Third-country note:** Apple/Google operate these services globally; argus minimizes by sending content-free pushes only. Tracked here as the named sub-processors for transparency. |

No message content, call content, or media keys are transferred to third countries. Push wake-ups are content-free metadata only.

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
| Call metadata (`call_sessions`, VoIP missed-call list) | **30 days** (rolling window, dedicated `argus_call_prune` worker) — **dormant in V1** (no table ships until V1.1); the retention literal is fixed now so the worker and ROPA agree when it lands | Proportionality + Art. 6(1)(f) |
| Error tracking events | 30 days (GlitchTip default) | Proportionality |
| Backups (encrypted DB snapshots) | 30 days (Backblaze backup bucket lifecycle) | Operational necessity |

---

## 6. Technical and organisational security measures (Art. 30(1)(g))

- **End-to-end encryption**: all message content is encrypted on-device using MLS before reaching the server. The server is crypto-blind.
- **End-to-end encrypted calling (VoIP)**: 1:1 call media is encrypted browser-to-browser with WebRTC DTLS-SRTP; the self-hosted coturn relay forwards opaque ciphertext and holds no media key. Call signaling (SDP/ICE) rides inside MLS ciphertext. No call content or media key is ever accessible to the server or relay; no call recording exists. Relay peer-IPs are transient and unlogged.
- **Encryption at rest**: Azure managed disk encryption (AES-256) for the VM volume; Backblaze server-side encryption for blobs.
- **Encryption in transit**: TLS 1.2+ enforced via Cloudflare Tunnel (no public ports).
- **Access control**: per-tenant PostgreSQL Row-Level Security enforced for all tenant-scoped tables. No cross-tenant query path exists.
- **Secrets management**: secrets delivered from Azure Key Vault via Managed Identity as credential files — never in environment variables or source code.
- **Authentication**: passkey (WebAuthn) — the API mints and verifies its own EdDSA session tokens (no external IdP); access tokens are re-verified on every request (`auth.service.ts`).
- **Audit logging**: security-relevant events (login, device registration, invite actions, admin actions) are logged with actor sub, event type, and IDs — never content. Retention is bounded to 90 days and enforced by the `argus-audit-prune` worker.
- **Vulnerability management**: automated scanning via Semgrep, OSV, Trivy, Checkov, gitleaks, 42Crunch, CodeQL on every PR; nightly DAST.
- **Erasure**: self-service account deletion (Art. 17) available via `DELETE /me`; messages are pseudonymized (sender → NULL), blobs deleted best-effort.
