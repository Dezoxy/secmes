# Phase 6 — Hardening & observability

> Part of the [build roadmap](README.md). Legend: `[ ]` todo · `[~]` in progress · `[x]` done · 🔒 security-gated.

**Progress:** 2/7 done (3 in progress — observability built as gated code, deploys at arming).

> Goal: production-grade reliability and visibility (without leaking content).

- [ ] 45. **Default-deny network isolation** — Azure NSG drops all inbound (no open ports; the VM reaches out only via the Cloudflare Tunnel) + Cloudflare as the edge; verified 🔒
- [x] 46. **Rate limiting + abuse protection** (API) 🔒
- [~] 47. **Metrics + dashboards** — Prometheus + Grafana + Alertmanager (Docker Compose on the VM); SLOs defined — _built as gated code; deploys with the stack at arming._
- [~] 47b. **Centralized logs** — self-hosted Loki + Grafana Alloy collector on the VM, queried in the existing Grafana (#47); logs are IDs/metadata only (invariant #2), scrubbed before ship. 🔒 — _built; deploys at arming._
- [x] 48. **Error tracking** — `@sentry/node` SDK with strict PII/content scrubbing (invariant #2), DSN-gated; self-hosted GlitchTip (Sentry-API-compatible) as a gated Compose service (EU, no new sub-processor). 🔒
- [~] 49. **Backups + restore drill** — Postgres backup + a *tested* restore — _nightly encrypted logical backup to a private EU B2 bucket built; the restore drill needs the live VM._
- [ ] 50. **Resilience** — full security suite green, DR runbook, load test to target concurrency 🔒
