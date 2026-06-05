# secmes — Build Roadmap (checkpoints)

Living checklist. Check items off as they land. Each checkpoint states its **done-when** so "complete" is objective. **Effort is per-item, not flat** — most are ~½–2 days, but a few (notably #41 core UX, #42, #43) are *weeks*; don't plan runway against an average. The implied "~10–12 weeks" is realistically **6–9 months solo**.

**Reality notes**

- Checkpoints **17–32 (crypto + messaging) are the hard, high-risk core** — most of the effort and all of the "is this actually secure" risk lives there. Don't rush them.
- Two GA gates (**G4 crypto review, G5 pen test**) are **external and paid** — schedule and budget them early; they block launch.
- This is a genuine multi-month solo effort. That's expected — the list just makes it honest.
- **Front-load the unknowns** (spikes S1–S2 below): the hardest thing (MLS) and the longest-lead-time thing (paid audits) start _now_, not in sequence.
- This roadmap is **canonical** for phasing; `secure_messaging_platform_plan.md` §17 is an earlier, looser cut — defer to this file when they disagree.
- Each phase is gated by its `docs/threat-models/*.md` note (rls-tenant-isolation, key-directory, key-backup, attachments) — ratify the note before the code.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · 🔒 security-gated (route through the matching reviewer).

**Status (2026-06-05):** building has started. **Done:** 11–12 (Drizzle + `tenants`/`users` with enforced RLS, PR #34). **In progress:** S1 (`ts-mls` verified in Node; iOS-Safari installed-PWA proof pending — USER), 6 (CI green; ACR-via-OIDC half awaits the cluster). Phase-0 infra (Terraform→Azure) is **deferred by choice** — building Phase 1 app logic locally first (Docker stack: `make up`). **Next:** 13–14 (server-side OIDC token exchange + tenant guard that feeds `withTenant`).

---

## Front-load — start now, parallel to Phase 0

- [~] S1. **MLS spike** (laptop, no cluster) — `ts-mls` two-party encrypt/decrypt + add-member, run RFC 9420 interop vectors, measure gzipped bundle size, **prove it on a real iOS-Safari installed PWA**, sketch an IndexedDB keystore. Ratifies `docs/mls-library-selection.md`. _Highest-leverage de-risking action — do it this week._ 🔒 — _Node portion VERIFIED (`ts-mls` 1.6.2 full 2-party flow) — recorded with reproduction steps in `docs/mls-library-selection.md` § "Spike result" (the spike code is a gitignored throwaway, not committed). Steps 2–5 (interop vectors, bundle size, **iOS-Safari installed-PWA proof**, IndexedDB keystore) still pending — stays `[~]` until the iOS proof passes (USER)._
- [ ] S2. **Book the paid GA gates** — quotes + provisional calendar holds for G4 (crypto review) and G5 (pen test), ~2 months out. Lead time is the schedule risk, not the audits.

## Phase 0 — Platform foundation (cluster + pipeline)

> Goal: prove the whole pipeline before any app logic.

- [ ] 1. **AKS provisioned** via Terraform — `terraform apply` clean, `kubectl get nodes` healthy
- [ ] 2. **Entra Workload ID** federation wired — a pod reads a Key Vault secret with no static creds 🔒
- [ ] 3. **Cilium NetworkPolicy** proven — default-deny blocks pod-to-pod, allow-rule permits it 🔒
- [ ] 4. **Ingress + TLS** — ingress-nginx + cert-manager issue a valid Let's Encrypt cert on a test host
- [ ] 5. **Argo CD** installed — app-of-apps syncs `charts/secmes`
- [~] 6. **CI green on a PR** — lint/format/typecheck/test/build pass; GitHub→ACR via OIDC — _CI green (ci · security · codeql); ACR push via OIDC awaits the cluster (Phase-0/Azure)._
- [ ] 7. **Hello-world `api` live** end-to-end over HTTPS via GitOps
- [ ] 8. **Secrets via Key Vault** + Secrets Store CSI mounted in the `api` pod 🔒
- [ ] 8a. **Staging + prod environments** stood up (namespaces, per-env Helm values, first GitOps sync, `vars.STAGING_URL` registered) — the GitOps prod gate and nightly DAST both require this, and no other checkpoint creates it.

## Phase 1 — Identity & tenancy

> Goal: real login, real tenant isolation enforced by the database.

- [ ] 9. **Zitadel deployed** (Helm) with its DB — admin console reachable
- [ ] 10. **Managed Postgres** (Flexible Server) + private endpoint — reachable only in-VNet 🔒
- [x] 11. **Drizzle wired** with a per-transaction `app.tenant_id` session var — _`withTenant()` (PR #34); pool `prepare:false` for PgBouncer txn mode._
- [x] 12. **`tenants` + `users` with RLS** — cross-tenant read provably blocked by a test 🔒 — _PR #34; non-bypass `secmes_app` role, FORCE RLS + WITH CHECK, 8-test spec incl. pooled-reuse + privilege-escalation negatives._
- [ ] 13. **OIDC login** via Zitadel works; API validates JWTs
- [ ] 14. **Tenant guard** sets `app.tenant_id` from the verified token only (never client input) 🔒
- [ ] 15. **`/me` + user directory** (per tenant) — Zod-validated, documented in the spec
- [ ] 16. **Audit events** table + login/logout auditing (IDs/metadata only, no secrets) 🔒

## Phase 2 — Device keys & recovery (crypto foundation)

> Goal: the hard part. E2EE keys generated, published, and recoverable.

- [ ] 16a. **Headless 2-device test harness** — a CLI/Node oracle doing encrypt→send→fetch→decrypt across two simulated devices, so checkpoints 17–38 (all _client_ behavior, but no client exists until #39) have a repeatable pass/fail instead of hand-verification. 🔒
- [ ] 17. **MLS integrated** in `packages/crypto` — local encrypt/decrypt smoke test passes 🔒
- [ ] 18. **Device keys** generated client-side, stored in IndexedDB
- [ ] 19. **Key directory** — `devices` + `key_packages` tables (RLS); publish/fetch public KeyPackages 🔒
- [ ] 20. **Crypto review #1** — crypto-reviewer pass + threat-model note for the key model 🔒
- [ ] 21. **Passphrase backup** — Argon2id-derived key encrypts private material client-side 🔒
- [ ] 22. **Backup storage** — `key_backups` table (ciphertext only) + backup/restore API 🔒
- [ ] 23. **Recovery proven** — fresh browser → passphrase → restore → decrypt an old message
- [ ] 24. **CSPRNG audit** — no `Math.random` in security paths; Semgrep rule green 🔒

## Phase 3 — 1:1 encrypted text

> Goal: send and receive encrypted messages in real time.

- [ ] 25. **Schema** — `conversations`, `conversation_members`, `messages` (RLS, ciphertext only) 🔒
- [ ] 26. **Send API** — membership authz + Zod I/O + store ciphertext (no plaintext server-side) 🔒
- [ ] 27. **End-to-end text** — client MLS-encrypts → stored → recipient fetches → decrypts
- [ ] 28. **WebSocket gateway** — authenticated connections; real-time ciphertext delivery
- [ ] 29. **Redis backplane** — delivery across ≥2 gateway pods; HPA configured
- [ ] 30. **Offline delivery** — queue + catch-up on reconnect
- [ ] 31. **Delivery receipts** — sent/delivered/read end-to-end
- [ ] 32. **API security** — messaging endpoints in OpenAPI; 42Crunch audit ≥ 75 🔒

## Phase 4 — Encrypted images

> Goal: encrypted attachments, blobs the server can't read.

- [ ] 33. **Presigned upload** — Blob private container + SAS upload API
- [ ] 34. **Client-side image encryption** with a random content key 🔒
- [ ] 35. **Attachment refs** — encrypted blob upload + `attachments` table (RLS, ciphertext refs) 🔒
- [ ] 36. **Download + decrypt** — recipient renders; member-only authz 🔒
- [ ] 37. **Limits + lifecycle** — size/type limits, expiry/cleanup rules
- [ ] 38. **Re-audit** — 42Crunch incl. attachment routes

## Phase 5 — Frontend PWA

> Goal: installable on every platform, no app store.

- [ ] 39. **Installable PWA** — manifest + service worker + offline shell; Lighthouse PWA pass
- [ ] 40. **Web Push** — content-free VAPID notifications; iOS installed-PWA path verified
- [ ] 41. **Core UX** — conversation list, composer, image, delivery states
- [ ] 42. **Key-loss UX** — backup prompt + recovery built into the UI
- [ ] 43. **Code-delivery hardening** — CSP + SRI + service-worker pinning; published bundle hash 🔒
- [ ] 44. **A11y + responsive** — WCAG AA pass; mobile/desktop layouts

## Phase 6 — Hardening & observability

> Goal: production-grade reliability and visibility (without leaking content).

- [ ] 45. **Default-deny NetworkPolicies** across namespaces, verified 🔒
- [ ] 46. **Rate limiting + abuse protection** (API + WS)
- [ ] 47. **Metrics + dashboards** — kube-prometheus + Grafana + Alertmanager; SLOs defined
- [ ] 48. **Error tracking** — App Insights/Sentry with no content/secret leakage 🔒
- [ ] 49. **Backups + restore drill** — Postgres PITR + Blob; a *tested* restore
- [ ] 50. **Resilience** — full security suite green, DR runbook, load test to target concurrency 🔒

---

## Phase 7 — GA / go-to-market (the last mile to selling)

> Not in the 50 — the commercialization layer once the beta is solid.

- [ ] G1. **Self-serve tenant onboarding** — org create → admin → invite users
- [ ] G2. **Per-tenant SSO** — customers federate their own Entra/Okta/Google (OIDC/SAML)
- [ ] G3. **Admin panel** — metadata only (users, devices, revoke, audit); never content 🔒
- [ ] G4. **🔒 Independent cryptography review** of the MLS integration *(external, paid — gates GA)*
- [ ] G5. **🔒 Third-party pen test** + remediation *(external, paid — gates GA)*
- [ ] G6. **GDPR pack** — DPA, processing records, residency doc, deletion/export (metadata)
- [ ] G7. **Security page** — protocol, bundle hashes, sub-processors
- [ ] G8. **Billing/plan gating** *(if monetizing now; else defer)*

## Beyond GA — backlog (the deferred hard stuff)

- [ ] B1. **Group chat** (MLS groups) — cheap-ish because MLS was chosen up front
- [ ] B2. **Multi-device sync** — encrypt-to-all-devices + history sync (the nastiest E2EE problem)
- [ ] B3. **Per-tenant compliance mode** — opt-in escrow/journaling for regulated buyers
- [ ] B4. **Multi-region / zone-redundant AKS**; Azure sovereign-operator option
- [ ] B5. **SOC 2 / ISO 27001** path
