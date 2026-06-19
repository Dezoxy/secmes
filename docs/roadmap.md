# argus — Build Roadmap (checkpoints)

Living checklist. Check items off as they land. Each checkpoint states its **done-when** so "complete" is objective. **Effort is per-item, not flat** — most are ~½–2 days, but a few (notably #41 core UX, #42, #43) are *weeks*; don't plan runway against an average. The implied "~10–12 weeks" is realistically **6–9 months solo**.

> **Detailed build log:** per-checkpoint implementation notes and PR-by-PR history live in [`roadmap-history.md`](roadmap-history.md). This file is the slim status checklist.

**Reality notes**

- Checkpoints **17–32 (crypto + messaging) are the hard, high-risk core** — most of the effort and all of the "is this actually secure" risk lives there. Don't rush them.
- Two GA gates (**G4 crypto review, G5 pen test**) are **external and paid** — schedule and budget them early; they block launch.
- This is a genuine multi-month solo effort. That's expected — the list just makes it honest.
- **Front-load the unknowns** (spikes S1–S2 below): the hardest thing (MLS) and the longest-lead-time thing (paid audits) start _now_, not in sequence.
- This roadmap is **canonical** for phasing; `secure_messaging_platform_plan.md` §17 is an earlier, looser cut — defer to this file when they disagree.
- Each phase is gated by its `docs/threat-models/*.md` note (rls-tenant-isolation, key-directory, prf-keystore-unlock, attachments) — ratify the note before the code.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · 🔒 security-gated (route through the matching reviewer).

**Status (2026-06-14):** **feature-complete.** Phases 0–7 are built, plus group chat (B1) and multi-device sync (B2). The server stays crypto-blind; multi-tenant isolation is FORCE-RLS on every table. **What remains is operational, not feature work:** the one-time **Azure arming** of the gated deploy track (`vars.ENABLE_DEPLOY` is off, so merges don't deploy yet) flips the live half of the Phase-0/6 `[~]` items, and the two external paid GA gates — **G4 crypto review**, **G5 pen test** — stay open. A handful of `[~]` residuals (the S1 iOS-PWA proof, #39/#41 polish) are noted inline below. Per-checkpoint detail: [`roadmap-history.md`](roadmap-history.md).

---

## Front-load — start now, parallel to Phase 0

- [~] S1. **MLS spike** (laptop, no cluster) — `ts-mls` two-party encrypt/decrypt + add-member, run RFC 9420 interop vectors, measure gzipped bundle size, **prove it on a real iOS-Safari installed PWA**, sketch an IndexedDB keystore. Ratifies `docs/mls-library-selection.md`. 🔒 — _residual: RFC 9420 interop vectors, gzipped bundle-size measurement, and the iOS-Safari installed-PWA proof (USER)._
- [ ] S2. **Book the paid GA gates** — quotes + provisional calendar holds for G4 (crypto review) and G5 (pen test), ~2 months out. Lead time is the schedule risk, not the audits.

## Phase 0 — Platform foundation (VM + pipeline)

> Goal: stand up the VM and prove the deploy pipeline before the bulk of the app logic. (Kubernetes was dropped — recover the K8s checkpoints from git history if it is ever revisited.)
>
> Deploy-track: Slices 1–4 merged (code-complete + gated); what remains is the **one-time Azure arming**, which flips #1/#3/#7/#8a and the live half of the `[~]` items. Threat models: `vm-ingress.md`, `vm-secrets.md`, `vm-cd.md`.

- [ ] 1. **VM provisioned** via Terraform (`infra/azure/`) — `terraform apply` clean; the Azure VM (EU `germanywestcentral`) boots with Docker + the Compose stack
- [~] 2. **Managed Identity → Key Vault** wired — the VM reads a Key Vault secret with no static creds (delivered as a credential file, not env) 🔒
- [ ] 3. **NSG deny-inbound proven** — the Azure NSG drops all inbound; the VM reaches out only via the Cloudflare Tunnel (no open ports) 🔒
- [~] 4. **Ingress + TLS via Cloudflare** — cloudflared dials out, Cloudflare terminates TLS + runs the edge WAF/rate-limit; Caddy is a plain-HTTP single-origin reverse proxy (PWA + `/api` + `/ws`); admin subdomains behind Cloudflare Access
- [~] 5. **CD via `az vm run-command`** — GitHub Actions + Azure OIDC deploys the stack with no SSH and no open ports
- [~] 6. **CI green on a PR** — lint/format/typecheck/test/build pass; GitHub→GHCR via OIDC
- [ ] 7. **Hello-world `api` live** end-to-end over HTTPS through the Cloudflare Tunnel
- [~] 7a. **DB migrations run on deploy** — `db:migrate` (owner credential from Key Vault, NOT the runtime `argus_app` role) runs **before** the new API container takes traffic, so a breaking migration can never serve traffic ahead of its schema. 🔒
- [~] 8. **Secrets via Key Vault** fetched by the VM's Managed Identity and mounted as credential files for the API container (never env at rest) 🔒
- [ ] 8a. **Staging + prod environments** stood up (per-env Compose config / subdomains, first deploy, `vars.STAGING_URL` registered) — the prod gate and nightly DAST both require this.

## Phase 1 — Identity & tenancy

> Goal: real login, real tenant isolation enforced by the database.

- [~] 9. **Zitadel deployed** (Docker Compose on the VM) with its DB — admin console reachable — _local stand-in done; VM prod stack built; awaits arming + provisioning._
- [x] 10. ~~**Managed Postgres** (Flexible Server) + private endpoint~~ 🔒 — **SUPERSEDED / N/A** (the VM self-hosts Postgres under FORCE-RLS; see #11/#12).
- [x] 11. **Drizzle wired** with a per-transaction `app.tenant_id` session var
- [x] 12. **`tenants` + `users` with RLS** — cross-tenant read provably blocked by a test 🔒
- [x] 13. **OIDC login** via Zitadel works; API validates JWTs
- [x] 14. **Tenant guard** sets `app.tenant_id` from the verified token only (never client input) 🔒
- [x] 15. **`/me` + user directory** (per tenant) — Zod-validated, documented in the spec
- [x] 16. **Audit events** table + login/logout auditing (IDs/metadata only, no secrets) 🔒

## Phase 2 — Device keys & recovery (crypto foundation)

> Goal: the hard part. E2EE keys generated, published, and recoverable.

- [x] 16a. **Headless 2-device test harness** — a CLI/Node oracle doing encrypt→send→fetch→decrypt across two simulated devices, so checkpoints 17–38 have a repeatable pass/fail. 🔒
- [x] 17. **MLS integrated** in `packages/crypto` — local encrypt/decrypt smoke test passes 🔒
- [x] 18. **Device keys** generated client-side, stored in IndexedDB (sealed at rest)
- [x] 19. **Key directory** — `devices` + `key_packages` tables (RLS); publish/fetch public KeyPackages 🔒
- [x] 20. **Crypto review #1** — crypto-reviewer pass + threat-model note for the key model 🔒
- [x] 21. **Passphrase backup** — Argon2id-derived key encrypts private material client-side 🔒 — **SUPERSEDED & REMOVED (2026-06, migration `0040`)**
- [x] 22. **Backup storage** — `key_backups` table (ciphertext only) + backup/restore API 🔒 — **SUPERSEDED & REMOVED (2026-06, migration `0040`)**
- [x] 23. **Recovery proven** — fresh browser → passphrase → restore → recovered identity works for MLS — **SUPERSEDED (2026-06)**
  > Checkpoints 21–23 (passphrase / Argon2id / server-stored `key_backups` backup + recovery) were **dropped**. The keystore is now sealed under a per-passkey **WebAuthn-PRF** key with **no server backup and no recovery** — a lost passkey is a fresh start. See `docs/threat-models/prf-keystore-unlock.md` + `key-model.md`.
- [x] 24. **CSPRNG audit** — no `Math.random` in security paths; Semgrep rule green 🔒

## Phase 3 — 1:1 encrypted text

> Goal: send and receive encrypted messages in real time.

- [x] 25. **Schema** — `conversations`, `conversation_members`, `messages` (RLS, ciphertext only) 🔒
- [x] 26. **Send API** — membership authz + Zod I/O + store ciphertext (no plaintext server-side) 🔒
- [x] 26a. **MLS Welcome delivery** — relay opaque join material so an added member can join the group 🔒
- [x] 27. **End-to-end text** — client MLS-encrypts → stored → recipient fetches → decrypts
- [x] 28. **WebSocket gateway** — authenticated connections; real-time ciphertext delivery 🔒
- [x] 29. **Redis backplane** — the realtime bus (and future throttler store) 🔒
- [x] 30. **Offline delivery** — queue + catch-up on reconnect
- [x] 31. **Delivery receipts** — sent/delivered/read end-to-end 🔒
- [x] 32. **API security** — messaging endpoints in OpenAPI; 42Crunch audit ≥ 75 (achieved 100/100) 🔒

## Phase 4 — Encrypted images

> Goal: encrypted attachments, blobs the server can't read.

- [x] 33. **Presigned upload** — private bucket + presigned grant API 🔒
- [x] 34. **Client-side image encryption** with a random content key 🔒
- [x] 35. **Attachment refs** — encrypted blob upload + `attachments` table (RLS, ciphertext refs) 🔒
- [x] 36. **Download + decrypt** — recipient renders; member-only authz 🔒
- [x] 37. **Limits + lifecycle** — size limit (no type limit) + expiry/cleanup 🔒
- [x] 38. **Re-audit** — 42Crunch incl. attachment routes (100/100)

## Phase 5 — Frontend PWA

> Goal: installable on every platform, no app store.

- [~] 39. **Installable PWA** — manifest + service worker + offline shell; Lighthouse PWA pass — _residual: iOS installed-PWA proof (S1, USER)._
- [x] 40. **Web Push** — content-free VAPID notifications; iOS installed-PWA path verified
- [~] 41. **Core UX** — conversation list, composer, image, delivery states — _live loop complete (41a); the seed/demo path is retained alongside it._
- [x] 42. **Key-loss UX** — fresh-start message + new-registration-code flow (no backup/recovery by design) — **revised (2026-06)**
- [x] 41a. **Live client message loop** — chat wired to the real server (device provisioning → start 1:1 → join → live send/fetch/receive + sealed message-history persistence), replacing the seed/loopback
- [x] 43. **Code-delivery hardening** — CSP + SRI + service-worker pinning; published bundle hash 🔒
- [x] 44. **A11y + responsive** — WCAG AA pass; mobile/desktop layouts
- [x] 44a. **Frontend maintainability + PWA/UX hardening pass** — the canonical 14-step `apps/web` upgrade + F1–F6 follow-ups (design tokens, UI primitives, route-owned shell, settings split, pseudonymous-profile boundary, typed API client, versioned persistence, chat-hook decomposition, safe async/error states, PWA caching safety, telemetry boundary, a11y/Lighthouse/bundle/update-prompt polish). Canonical detail in `frontend-plan.md`.
- [x] 44b. **Generated pseudonymous identity** — local DiceBear avatars (no external requests) + random `<Adjective> <Animal>` handles, extending the #44a profile boundary.

## Phase 6 — Hardening & observability

> Goal: production-grade reliability and visibility (without leaking content).

- [ ] 45. **Default-deny network isolation** — Azure NSG drops all inbound (no open ports; the VM reaches out only via the Cloudflare Tunnel) + Cloudflare as the edge; verified 🔒
- [x] 46. **Rate limiting + abuse protection** (API) 🔒
- [~] 47. **Metrics + dashboards** — Prometheus + Grafana + Alertmanager (Docker Compose on the VM); SLOs defined — _built as gated code; deploys with the stack at arming._
- [~] 47b. **Centralized logs** — self-hosted Loki + Grafana Alloy collector on the VM, queried in the existing Grafana (#47); logs are IDs/metadata only (invariant #2), scrubbed before ship. 🔒 — _built; deploys at arming._
- [x] 48. **Error tracking** — `@sentry/node` SDK with strict PII/content scrubbing (invariant #2), DSN-gated; self-hosted GlitchTip (Sentry-API-compatible) as a gated Compose service (EU, no new sub-processor). 🔒
- [~] 49. **Backups + restore drill** — Postgres backup + a *tested* restore — _nightly encrypted logical backup to a private EU B2 bucket built; the restore drill needs the live VM._
- [ ] 50. **Resilience** — full security suite green, DR runbook, load test to target concurrency 🔒

---

## Phase 7 — GA / go-to-market (the last mile to selling)

> Not in the 50 — the commercialization layer once the beta is solid.

- [x] G1. **Self-serve tenant onboarding** — org create → admin → invite users
- [x] G2. **Per-tenant SSO** — customers federate their own Entra/Okta/Google (OIDC/SAML)
- [x] G3. **Admin panel** — metadata only (users, devices, revoke, audit); never content 🔒
- [~] G4. **🔒 Independent cryptography review** of the MLS integration *(external, paid — deferred; not blocking GA for now)*
- [~] G5. **🔒 Third-party pen test** + remediation *(external, paid — deferred; not blocking GA for now)*
- [x] G6. **GDPR pack** — DPA, processing records, residency doc, deletion/export (metadata)
- [x] G7. **Security page** — protocol, bundle hashes, sub-processors
- [x] G8. **Billing/plan gating** — Free/Pro/Enterprise tiers; member-limit + SSO gating; Stripe Checkout/Portal/webhooks

## Beyond GA — backlog (the deferred hard stuff)

- [x] B1. **Group chat** (MLS groups) — composite `userId:deviceUuid` identity, group create fan-out, group UI + WS routing + history persistence
- [x] B2. **Multi-device sync** — encrypt-to-all-devices + verified enrollment fan-out; a new device decrypts from its add-epoch forward (forward secrecy)
- [ ] B3. **Per-tenant compliance mode** — opt-in escrow/journaling for regulated buyers
- [ ] B4. **Multi-region / zone-redundant VM deploy**; Azure sovereign-operator option
- [ ] B5. **SOC 2 / ISO 27001 / NIS2** path
