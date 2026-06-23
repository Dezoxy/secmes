# Data Residency Statement

**Last updated**: 2026-06-12

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

---

## No third-country transfers

- No personal data is transferred to or processed in countries outside the EU/EEA.
- No US-based SaaS analytics, CDN, or third-party integrations are used.
- Cloudflare Tunnel is used for ingress only (TLS pass-through); no data is stored at Cloudflare edge nodes.

---

## Backups

Database backups are encrypted (Postgres-level + Backblaze SSE) and stored in a private Backblaze B2 bucket in `eu-central-003`. Backups are retained for 30 days. Access requires the backup encryption key stored in Azure Key Vault (Germany West Central).

---

## Future changes

Any change to data residency (new provider, new region, or transfer outside EU/EEA) requires:
1. A DPA update with the new processor.
2. An update to `docs/gdpr/article-30-records.md` and this file.
3. Notification to affected data subjects if required by Art. 13/14.
