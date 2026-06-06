# argus — Build Roadmap (checkpoints)

Living checklist. Check items off as they land. Each checkpoint states its **done-when** so "complete" is objective. **Effort is per-item, not flat** — most are ~½–2 days, but a few (notably #41 core UX, #42, #43) are *weeks*; don't plan runway against an average. The implied "~10–12 weeks" is realistically **6–9 months solo**.

**Reality notes**

- Checkpoints **17–32 (crypto + messaging) are the hard, high-risk core** — most of the effort and all of the "is this actually secure" risk lives there. Don't rush them.
- Two GA gates (**G4 crypto review, G5 pen test**) are **external and paid** — schedule and budget them early; they block launch.
- This is a genuine multi-month solo effort. That's expected — the list just makes it honest.
- **Front-load the unknowns** (spikes S1–S2 below): the hardest thing (MLS) and the longest-lead-time thing (paid audits) start _now_, not in sequence.
- This roadmap is **canonical** for phasing; `secure_messaging_platform_plan.md` §17 is an earlier, looser cut — defer to this file when they disagree.
- Each phase is gated by its `docs/threat-models/*.md` note (rls-tenant-isolation, key-directory, key-backup, attachments) — ratify the note before the code.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done · 🔒 security-gated (route through the matching reviewer).

**Status (2026-06-05):** building. **Phase 1 app layer DONE** — **Done:** 11–12 (Drizzle + RLS, PR #34), 14 + `GET /me` (JWT auth + tenant guard, PR #36), 16 (append-only audit log, PR #37), 15 (`/me` + JIT provisioning + `GET /users` directory, PR #38/#39). **In progress:** 13 (API JWT validation done; live Zitadel login pending deploy), S1 (`ts-mls` verified in Node; iOS-PWA proof pending — USER), 6 (CI green; ACR-via-OIDC awaits the cluster). The infra-gated Phase-1 items (9 Zitadel, 10 managed Postgres) + Phase-0 Terraform→Azure are **deferred by choice** — building app logic locally first (Docker stack: `make up`). **Phase 2 crypto IN PROGRESS:** 16a + 17 (MLS wrapper, PR #40) + 19 (server key directory, PR #41) done. 16a + 17 (MLS wrapper, PR #40), 19 (key directory, PR #41), 18 (keystore + build-order enabler, PR #42), 21 (`sealBackup`/`openBackup`, PR #43), 22 (server `key_backups` storage, PR #44), 18→sealed + 23 (sealed keystore at rest + fresh-device recovery, PR #45 — **18's unsealed gate lifted**), **20** (crypto review #1 — consolidated `key-model.md` + OpenAPI input bounds, PR #46; stays `[~]` until the Phase-5 **fingerprint-verification** MITM defense ships, which needs the client app #39), and **24** (CSPRNG audit — all randomness CSPRNG; `argus-no-insecure-random` total-ban rule, PR #47) done. **Phase 2 crypto primitives are now complete**; its only open gate is 20's fingerprint verification (blocked on the client, #39). **Next build front:** Phase 3 (1:1 encrypted text) starts at **25** (schema) once the client exists; the thin `apps/web` → `PUT`/`GET /backups/me` wiring also lands with the client. Group chat / PCS handshake fan-out deferred (B1).

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
- [ ] 5. **Argo CD** installed — app-of-apps syncs `charts/argus`
- [~] 6. **CI green on a PR** — lint/format/typecheck/test/build pass; GitHub→ACR via OIDC — _CI green (ci · security · codeql); ACR push via OIDC awaits the cluster (Phase-0/Azure)._
- [ ] 7. **Hello-world `api` live** end-to-end over HTTPS via GitOps
- [ ] 7a. **DB migrations run on deploy** — a Helm **pre-upgrade/pre-install hook Job** that runs `db:migrate` (owner/migration credential from Key Vault, NOT the runtime `argus_app` role) **before** the Deployment rolls out, so a breaking migration (e.g. `0009` role rename) can never serve traffic ahead of its schema. Until this lands, migrations are manual and MUST precede any image promotion that needs them (see `cd.yml` note). 🔒
- [ ] 8. **Secrets via Key Vault** + Secrets Store CSI mounted in the `api` pod 🔒
- [ ] 8a. **Staging + prod environments** stood up (namespaces, per-env Helm values, first GitOps sync, `vars.STAGING_URL` registered) — the GitOps prod gate and nightly DAST both require this, and no other checkpoint creates it.

## Phase 1 — Identity & tenancy

> Goal: real login, real tenant isolation enforced by the database.

- [ ] 9. **Zitadel deployed** (Helm) with its DB — admin console reachable
- [ ] 10. **Managed Postgres** (Flexible Server) + private endpoint — reachable only in-VNet 🔒
- [x] 11. **Drizzle wired** with a per-transaction `app.tenant_id` session var — _`withTenant()` (PR #34); pool `prepare:false` for PgBouncer txn mode._
- [x] 12. **`tenants` + `users` with RLS** — cross-tenant read provably blocked by a test 🔒 — _PR #34; non-bypass `argus_app` role, FORCE RLS + WITH CHECK, 8-test spec incl. pooled-reuse + privilege-escalation negatives._
- [~] 13. **OIDC login** via Zitadel works; API validates JWTs — _API JWT validation DONE (jose/JWKS: iss + aud + asymmetric-alg allowlist + exp/nbf; PR #36); live Zitadel login pending deploy (checkpoint 9)._
- [x] 14. **Tenant guard** sets `app.tenant_id` from the verified token only (never client input) 🔒 — _PR #36; global deny-by-default guard → `withTenant(verifiedTenantId)`; threat model `auth-tenant-context.md`._
- [x] 15. **`/me` + user directory** (per tenant) — Zod-validated, documented in the spec — _`GET /me` + JIT provisioning + `GET /users` directory DONE (Zod-validated via a reusable `ZodValidationPipe`, RLS-scoped, active-only, bounded `limit`; PR #36, #38, #39). Threat models `auth-tenant-context.md` §7 + `user-directory.md`._
- [x] 16. **Audit events** table + login/logout auditing (IDs/metadata only, no secrets) 🔒 — _PR #37; append-only `audit_events` (RLS; `argus_app` INSERT+SELECT only → tamper-resistant), `auth.login`/`auth.logout` via `POST`/`DELETE /auth/session`; 90-day retention policy (per-tenant worker prune later); threat model `audit-logging.md`._

## Phase 2 — Device keys & recovery (crypto foundation)

> Goal: the hard part. E2EE keys generated, published, and recoverable.

- [x] 16a. **Headless 2-device test harness** — a CLI/Node oracle doing encrypt→send→fetch→decrypt across two simulated devices, so checkpoints 17–38 (all _client_ behavior, but no client exists until #39) have a repeatable pass/fail instead of hand-verification. 🔒 — _PR #40; mock-server harness + a **server-blind assertion** (plaintext never appears in the wire bytes)._
- [x] 17. **MLS integrated** in `packages/crypto` — local encrypt/decrypt smoke test passes 🔒 — _PR #40; thin typed wrapper over `ts-mls` 1.6.2 (`MlsEngine`/`Conversation`); pinned suite, downgrade-resistant KeyPackage; crypto-reviewer PASS. **2-party scope** — group/PCS handshake fan-out deferred (B1); see `mls-integration.md`._
- [x] 18. **Device keys** generated client-side, stored in IndexedDB — _PR #42; `apps/web` `DeviceKeystore` (idb) generates via `@argus/crypto` + persists (race-safe, identity-checked). Also landed the monorepo **build-order enabler** (root `prepare` builds `packages/*` so `apps/web` can consume `@argus/crypto`). Originally **unsealed at rest** (dev/beta gate); **now SEALED at rest** — gate lifted in PR #45 (Argon2id + AES-256-GCM; IndexedDB schema v2 drops legacy unsealed records). Threat model `device-keystore.md`._
- [x] 19. **Key directory** — `devices` + `key_packages` tables (RLS); publish/fetch public KeyPackages 🔒 — _PR #41; `POST /devices/me/key-packages` (caller-bound device + pool cap) + `POST /users/:id/key-package/claim` (one-time-use, atomic FOR-UPDATE-SKIP-LOCKED, audited). Server stores PUBLIC base64 only. MITM defense = client-side fingerprint verification (Phase 5, NOT yet built). Threat model `key-directory.md`._
- [~] 20. **Crypto review #1** — crypto-reviewer pass + threat-model note for the key model 🔒 — _Review done: consolidated `docs/threat-models/key-model.md` over the whole key lifecycle (17–23); **`crypto-reviewer` PASS** (client crypto) + **`security-boundary-auditor` PASS** (server surface). Fixed the one Must-fix (OpenAPI input bounds + `additionalProperties:false` now mirror the enforced Zod) and hardened both key schemas with `.strict()`. **Stays `[~]`:** the checkpoint's own gate (`key-directory.md` §5) is the **fingerprint-verification MITM defense**, which needs the client app — closes in Phase 5 (after #39)._
- [x] 21. **Passphrase backup** — Argon2id-derived key encrypts private material client-side 🔒 — _PR #43; `@argus/crypto` `sealBackup`/`openBackup` (Argon2id 64 MiB/t3/p1 + AES-256-GCM, unique salt/IV, min-param floor, derived-key wipe). Generic over bytes; crypto-reviewer PASS. Threat model `key-backup.md`._
- [x] 22. **Backup storage** — `key_backups` table (ciphertext only) + backup/restore API 🔒 — _PR #44; `PUT`/`GET /backups/me` store/restore the opaque sealed blob (one per user, RLS, never parsed server-side), store+fetch audited. Threat model `key-backup.md`._
- [x] 23. **Recovery proven** — fresh browser → passphrase → restore → _the recovered **identity** works for MLS (PR #45). Per the identity-only / forward-secrecy decision (`key-backup.md` §4), pre-existing message **history is intentionally NOT recoverable** — this amends the original "decrypt an old message" wording. Also **lifts checkpoint 18's unsealed-at-rest gate** (keystore now sealed)._
- [x] 24. **CSPRNG audit** — no `Math.random` in security paths; Semgrep rule green 🔒 — _Audited every randomness source (`docs/threat-models/csprng-audit.md`): all key/nonce/salt/IV/ID/token material is CSPRNG (WebCrypto `getRandomValues`/`randomUUID`, `@noble` via ts-mls, pgcrypto `gen_random_uuid()`); zero `Math.random`/`pseudoRandomBytes`. Hardened `argus-no-insecure-random` (catches aliasing + `pseudoRandomBytes`; **total ban, no test exclusion**); enforced by `sast-semgrep` (`--error`)._

## Phase 3 — 1:1 encrypted text

> Goal: send and receive encrypted messages in real time.

- [x] 25. **Schema** — `conversations`, `conversation_members`, `messages` (RLS, ciphertext only) 🔒 — _PR #48; migration `0007_messaging.sql` — three tenant-scoped tables, all ENABLE+FORCE RLS + WITH CHECK + leading-`tenant_id` indexes; `messages` is **ciphertext-only** (opaque base64 + routing metadata, no plaintext column) and **append-only** (select/insert grant). Composite-FK tenant pinning beneath RLS; idempotency unique index. 9-test live-DB RLS spec (cross-tenant isolation, WITH CHECK, append-only, composite-FK, fail-closed) green. `security-boundary-auditor` PASS. Threat model `messaging-schema.md`. Intra-tenant membership authz is the app layer's job (26)._
- [x] 26. **Send API** — membership authz + Zod I/O + store ciphertext (no plaintext server-side) 🔒 — _PR #49; `messaging` module — `POST /conversations` (creator + members; cross-tenant member rejected by composite FK) + `POST /conversations/:id/messages` (CIPHERTEXT-ONLY store). **Membership authz** (the intra-tenant guard 25 deferred): non-member / cross-tenant / missing conversation → 404 (no existence leak); `sender_user_id` is the verified caller, never client-supplied. `.strict()` Zod + OpenAPI bounds + `additionalProperties:false`; conversation-scoped idempotency (0008). Live-DB specs (authz, cross-tenant, opaque round-trip, per-conversation idempotency) + full suite 86/86. `security-boundary-auditor` PASS._
- [~] 27. **End-to-end text** — client MLS-encrypts → stored → recipient fetches → decrypts — _Server half DONE (PR #51): `GET /conversations/:id/messages` — member-only, keyset-paginated (cursor on `(created_at,id)`), returns opaque ciphertext + routing metadata verbatim (crypto-blind); same membership-404 as send; `requireMembership` factored out and shared. Live-DB tests (chronological order, pagination walk, non-member/cross-tenant 404, empty). `security-boundary-auditor` PASS. **Stays `[~]`:** the actual client encrypt→store→fetch→decrypt loop needs the client app (#39); provable meanwhile via the 16a headless harness._
- [x] 28. **WebSocket gateway** — authenticated connections; real-time ciphertext delivery 🔒 — _PR #52; native `ws` gateway (`@nestjs/platform-ws`, no socket.io) at `/ws`. **First-frame token auth** (never in the handshake URL/headers), auth deadline closes silent sockets; **subscribe is membership-gated** (`isMember` under RLS); **delivery keyed by (tenant, conversation)** so fan-out never crosses a tenant or reaches a non-member; opaque ciphertext forwarded verbatim (crypto-blind). HTTP send emits on an in-process `RealtimeBus` (no module cycle, no extra dep). Global JWT guard tightened to skip only `ws`. Tests: 8 gateway unit (auth/authz/scoped-delivery/deadline/dead-socket-resilience) + 2 **real-WebSocket e2e** (adapter wiring). `security-boundary-auditor` PASS. Threat model `realtime-delivery.md`. **Single-pod** — cross-pod fan-out is 29 (Redis backplane)._
- [x] 29. **Redis backplane** — delivery across ≥2 gateway pods; HPA configured 🔒 — _PR #53; `RealtimeBus` is now abstract — `InProcessRealtimeBus` (single pod / dev) or **`RedisRealtimeBus`** (when `REDIS_URL` set) which PUBLISHES each event and every pod SUBSCRIBES + fans out locally, so a message sent on pod A reaches a client on pod B. Only the opaque ciphertext envelope crosses Redis (crypto-blind); incoming events Zod-validated (malformed dropped, no crash). **Cross-pod fan-out proven against live Redis** (two bus instances) + malformed-payload test. **HPA** (`charts/argus`, autoscaling/v2, CPU 70%, 300s scale-down window) + secret-ref `REDIS_URL` (never plaintext) + a `fail` guard so a multi-pod config can't ship without the backplane. `security-boundary-auditor` + `infra-reviewer` PASS (their Must-fixes folded in). Live ≥2-pod cluster verification awaits Phase-0 cluster._
- [~] 30. **Offline delivery** — queue + catch-up on reconnect — _Server half DONE (PR #54): the durable `messages` table is the offline queue; **`GET /sync`** returns messages across ALL the caller's conversations after a cursor (keyset, each tagged with `conversationId`) so a reconnecting client back-fills everything it missed in one paginated stream. Member-scoped (inner join under RLS); cursor resolved through the caller's memberships too (closes an intra-tenant existence/timing oracle — `security-boundary-auditor` Should-improve, fixed + tested). Live-DB tests: cross-conversation catch-up, non-member exclusion, pagination, cross-tenant isolation, cursor-oracle closed. `security-boundary-auditor` PASS. **Stays `[~]`:** the client reconnect→subscribe→sync loop needs the client app (#39)._
- [~] 31. **Delivery receipts** — sent/delivered/read end-to-end 🔒 — _Server half DONE (PR #55): `conversation_receipts` (0010, tenant-scoped + FORCE RLS + composite-FK tenant pinning) stores per-member delivered/read **high-water-marks** (metadata only). `POST /conversations/:id/receipts` advances the caller's own watermark (member-only, monotonic — no rollback; `throughMessageId` must be in the conversation); `GET …/receipts` returns per-member watermarks. Live-DB tests (record, monotonic, member-only 404, cross-tenant, foreign-message). `security-boundary-auditor` PASS (the `sql.raw(status)` splice is enum-gated; no injection). **Read-receipt sending is client-opt-in** (privacy). **Stays `[~]`:** the client opt-in + live receipt push over the WS gateway land with the client (#39)._
- [x] 32. **API security** — messaging endpoints in OpenAPI; 42Crunch audit ≥ 75 🔒 — _PR #56; the whole API surface (messaging + identity + key directory + backups) is documented and hardened to a **42Crunch audit score of 100/100** (up from 20.5). Centralized in `apps/api/src/openapi.ts`: a single HTTPS server + global bearer (`bearerFormat: JWT`) clears the transport / "token-in-clear" criticals; a shared `ErrorResponse` envelope + injected standard responses (400/401/403/404/406/415/default — **429 deliberately deferred to rate limiting #46**, not documented as fiction) give every error a typed body; a recursive tightener pins `additionalProperties:false` + a real `pattern`/`maxLength`/`maximum`/`maxItems` on every schema and parameter (uuid / date-time / email / base64 / base64url / tag / bounded-text — never a catch-all). Infra probes (`/healthz`, `/`) excluded from the audited contract. Audited in Free-Trial CLI mode; `ENABLE_42CRUNCH` stays false in CI._

## Phase 4 — Encrypted images

> Goal: encrypted attachments, blobs the server can't read.

- [ ] 33. **Presigned upload** — Blob private container + SAS upload API
- [ ] 34. **Client-side image encryption** with a random content key 🔒
- [~] 35. **Attachment refs** — encrypted blob upload + `attachments` table (RLS, ciphertext refs) 🔒 — _Table DONE (PR #57): migration `0011_attachments.sql` — tenant-scoped, ENABLE+FORCE RLS + WITH CHECK + leading-`tenant_id` index; composite-FK tenant pinning `(tenant_id, uploaded_by)→users` (NO ACTION — preserves attachment history on a user delete, like `messages.sender_user_id`); **METADATA + ciphertext-refs ONLY** (`object_key` blob handle + `byte_size` + uploader + timestamps — NO content, NO content key, NO plaintext content-type, NO URL). Prunable (`select, insert, delete` to `argus_app` for the #37 cleanup worker; no UPDATE). 9-test live-DB RLS spec (isolation, WITH CHECK, composite-FK, byte_size check, unique, prunable delete, NO-ACTION user-delete block, tenant-teardown cascade, fail-closed). `security-boundary-auditor` PASS. Threat model `encrypted-attachments.md`. **Stays `[~]`:** the encrypted-blob UPLOAD (presigned `POST /attachments` that mints the grant + writes the row) rides #33's `BlobStore`; the client populates it. MUST-WIRE at #33: `POST /attachments` Zod caps `byteSize` (Drizzle `mode:'number'`), download is membership-404, `uploaded_by` from the verified token only, presigned URL never logged/persisted._
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
