# Data Residency Statement

**Last updated**: 2026-06-24

All personal data processed by this service is stored and processed exclusively within the **European Union**.

---

## Infrastructure locations

| Component | Provider | Region | Data stored |
|---|---|---|---|
| Application VM (API, gateway, GlitchTip, Redis) | Microsoft Azure | Germany West Central (`germanywestcentral`) | DB volumes, Redis state, application logs |
| PostgreSQL (self-hosted on VM) | Microsoft Azure | Germany West Central | All relational data |
| Attachment blob storage | Backblaze B2 | EU Central (`eu-central-003`) | Encrypted attachment ciphertext |
| DB backups | Backblaze B2 | EU Central (`eu-central-003`) | Encrypted database snapshots |
| Error tracking (GlitchTip) | Self-hosted on same VM | Germany West Central | Error events (no personal content) |
| Ingress / TLS termination | Cloudflare Tunnel | EU edge PoPs | No data stored; traffic only |
| VoIP media relay (coturn / TURN) | Self-hosted on same VM | Germany West Central | **Transient only** — relays encrypted DTLS-SRTP between call peers and processes their IP/port 5-tuples in memory during a call. **No media content** (relay is crypto-blind, holds no media key); **no IPs logged or persisted** (`simple-log`, excluded from long-term logs). |

---

## No third-country transfers

- No personal data is transferred to or processed in countries outside the EU/EEA.
- No US-based SaaS analytics, CDN, or third-party integrations are used.
- Cloudflare Tunnel is used for ingress only (TLS pass-through); no data is stored at Cloudflare edge nodes.
- **VoIP media is relayed by a self-hosted TURN server (coturn) on the same EU VM** — no third-party TURN/STUN provider (e.g. Twilio, Cloudflare Realtime, Google STUN), so call 5-tuples and relayed media never leave the EU region.
- **Web Push wake-ups** are delivered via the subscriber's browser-vendor push service (Apple APNs / Google FCM / Mozilla autopush), which may operate globally. argus sends **content-free** payloads only (a notification type tag — no message or call content, no caller, no conversation), so no personal *content* leaves the EU. This is the inherent Web Push model and the one metadata path not fully in-region; the providers are named as sub-processors in `article-30-records.md`. (The VoIP call-wake push is **V1.1**; V1 is foreground-ring only and sends no push.)

---

## Backups

Database backups are encrypted (Postgres-level + Backblaze SSE) and stored in a private Backblaze B2 bucket in `eu-central-003`. Backups are retained for 30 days. Access requires the backup encryption key stored in Azure Key Vault (Germany West Central).

---

## Future changes

Any change to data residency (new provider, new region, or transfer outside EU/EEA) requires:
1. A DPA update with the new processor.
2. An update to `docs/gdpr/article-30-records.md` and this file.
3. Notification to affected data subjects if required by Art. 13/14.
