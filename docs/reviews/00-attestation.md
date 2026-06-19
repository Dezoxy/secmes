# 00 — Security Review Campaign Attestation

> **"Prove it is private and safe."** This is the capstone of a six-slice adversarial security review of **argus**, a privacy-first, end-to-end-encrypted, multi-tenant messaging platform (NestJS API, React + Vite PWA, PostgreSQL + RLS, MLS/ts-mls crypto in `packages/crypto`).
>
> **Anchor:** `main` @ `bf6777fc` (post-#256, all six slice PRs #251–#256 merged). **Dates:** 2026-06-19. **Author:** security-architect (capstone synthesis). **Status:** AUTHORITATIVE for the campaign's verdict; the six slice notes under `docs/reviews/0{1..6}-*.md` are authoritative for the per-claim evidence.

---

## 1. Method & honesty stance

The campaign ran as six adversarial slices, each an `ultracode` workflow with maxed-Opus reviewer subagents (`crypto-reviewer`, `security-boundary-auditor`, `infra-reviewer`) in a fixed pipeline:

1. **Recon** — map the surface and extract the falsifiable claims (one per invariant facet).
2. **Per-claim finders** — one adversarial agent per claim, each trying to *break* it, not confirm it.
3. **Skeptic refutation** — every candidate finding re-attacked: confirmed, downgraded, refuted, or (rarely) *impact-upgraded*.
4. **Synthesis** — the slice note.

**A claim is marked PROVEN only where a break was attempted and failed.** Where the literal wording of a claim was overstated but the security property held, the verdict is PARTIAL — not PASS — by design (default-to-caution). The skeptic pass is what makes "PROVEN" mean something: in Slice 3 it *raised* the impact of FP-1 after the finder under-rated it (`03-auth-identity.md:48`); in Slices 1–2 it refuted five candidate findings as misreads. This document does not soften any gap to make the verdict cleaner. An overclaim that survived into this attestation would itself be the failure.

**Spot-checks for this capstone** (not taken on trust from the slices): the commit anchor (`bf6777fc`, main); the auth single-path (`auth.service.ts:44-79` — one `jwtVerify` against the self-minted key, no Zitadel/JWKS); `key_backups` dropped (`0040_drop_key_backups.sql:3`) and `packages/crypto/src/key-backup.ts` deleted; the audit-prune absence (no `@Cron`/`ScheduleModule`/`SchedulerRegistry`/`pg_cron` in `apps/api/src`); the BKP-1 backup-bundle gap on **both** CD tracks — the production Azure-VM path (`cd.yml:162`) and the parallel AWS experiment (`cd-aws.yml:154`); and the one compliance-grade overclaim verbatim (`docs/gdpr/article-30-records.md:78`).

---

## 2. Executive verdict

**argus's central privacy claim — that the server is end-to-end-encrypted and cryptographically blind to content — is PROVEN.** Across the two highest-stakes slices (crypto core, server boundary) every claim survived a hard break attempt with zero P1/P2 findings: the server stores and forwards ciphertext only, all cryptography is delegated to the vetted MLS library, tenant isolation is FORCE-RLS on every tenant table, private keys live on the client as non-extractable / sealed material, and no admin or log path reaches content. The auth/identity surface holds — no forgery, privilege-escalation, cross-tenant, or silent-device-add break was provable. **The gaps are real and must be visible:** one **P1** (nightly backups are never actually deployed on the shipped target — silent total data loss), one auth **device-linking** weakness (FP-1, the highest-impact auth finding), and a cluster of **P2** at-rest / supply-chain / client-egress issues. None of these breaks the E2EE confidentiality core; they bound *availability*, *active-attacker exfil*, and *retention*. Below, the six invariants — decisive but honest.

| # | Invariant | Verdict | Basis (one line) | Slice(s) |
|---|-----------|---------|------------------|----------|
| 1 | **Server is crypto-blind** (ciphertext only; never decrypts/infers) | **PASS** | Content columns opaque `text`; zero `decrypt/.subtle/aes-` in request path; `body.alg` stored, never branched; reads return ciphertext verbatim under RLS. | 01, 02, 04 |
| 2 | **No secret/plaintext logging or persistence** (keys, tokens, full `Authorization`, presigned URLs) | **PASS-with-residuals** | Logs carry IDs/metadata only across API, gateway, edge, error-sink (default-deny); **one bounded persistence residual** — cloudflared tunnel token in container env (INF-4, P3). | 01, 02, 04, 06 |
| 3 | **RLS on every tenant table** (`tenant_id` + enforced policy; no cross-tenant read) | **PASS** | All **18 live tenant tables** carry a tenant policy + leading `tenant_id` index; `ENABLE`==`FORCE` sets identical; `argus_app` non-bypass; fails closed on unset GUC; tenant context never from client input. | 02 |
| 4 | **No hand-rolled crypto** (all via MLS lib; CSPRNG only) | **PASS** | All E2EE primitives in `packages/crypto` via ts-mls; CSPRNG everywhere (`Math.random` zero functional uses); Semgrep enforces the boundary; key-substitution resistance proven. | 01, 03 |
| 5 | **Secrets from Key Vault via Managed Identity, as files; no long-lived cloud cred in env** | **PASS-with-residuals** | No committed secret; no `aws_iam_access_key`/`aws_iam_user`; OIDC CI; secrets tmpfs `0444` files via IMDS/Arc-HIMDS. Delivery rule holds; INF-4 is the one env-delivered token. | 06 |
| 6 | **No admin path to content** (admin/ops = metadata only) | **PASS** | All 3 admin-gated controllers return bounded metadata; device key capped at `left(...,12)`; audit view omits `metadata` jsonb; no debug/dump/decrypt route; GDPR has no admin override. | 02, 03, 04 |

**Reading the table:** the four invariants that carry the E2EE promise (1, 3, 4, 6) are clean PASS. Invariants 2 and 5 are PASS *on their core rule* with one shared, host-root-gated residual (INF-4). The visible weaknesses below live in **availability** (BKP-1), **active-attacker client exfil** (CDI-1 + CSP-1), **device-linking MITM** (FP-1), and **at-rest retention** (F1/AR-1) — not in the confidentiality core.

---

## 3. What is proven (the affirmative core)

Grouped by invariant, evidence-anchored. This is the substance behind "private and safe."

### Invariant 1 — Server is crypto-blind (Slices 01, 02, 04)
- **No content reachable server-side.** Every content-bearing column is opaque ciphertext: `messages.ciphertext`, `conversation_commits.commit`, `conversation_welcomes.welcome`/`ratchet_tree`, `attachments.object_key` (`02-server-boundary.md:24`). A grep for `decrypt|decipher|.subtle|aes-|chacha|deriveKey` in the request path returns **zero**; the only crypto verb is an Ed25519 *public-key* signature check (an authz step). `body.alg` is stored and echoed but **never branched on** to select a cipher.
- **Reads return ciphertext verbatim under RLS**, and a row-shape mismatch throws a *static* string — ciphertext never reaches an error message (`02-server-boundary.md:29`).

### Invariant 4 — No hand-rolled crypto; key-substitution resistant (Slices 01, 03)
- **All E2EE primitives delegate to ts-mls**; outside `packages/crypto` the only primitive uses are non-E2EE server-auth (SHA-256 opaque-token digests, SHA-384 build SRI, breakglass Argon2id), each pre-cleared and Semgrep-enforced (`01-crypto-core.md:52-56`, three new guard rules at `:82-89`).
- **CSPRNG everywhere** — every key/nonce/IV/salt/token traced to a CSPRNG; `Math.random` has zero functional uses repo-wide (`01-crypto-core.md:30-33`).
- **Malicious-server key substitution is detected**: the safety number derives from the KeyPackage's *embedded* `leafNode.signaturePublicKey`, never a server routing field, so a byte-swap shifts the number and trips the out-of-band check; the joiner side is MLS-validated (`validateRatchetTree`) (`01-crypto-core.md:45-51`). The signature-key pin **transitively pins** the HPKE encryption key via ts-mls `validateKeyPackage` (`03-auth-identity.md:24`).

### Invariant 3 — Tenant isolation (Slice 02)
- **All 18 live tenant tables** carry a tenant-isolation policy + leading `tenant_id` index; the `ENABLE`-RLS and `FORCE`-RLS sets are **identical** (every enabled table is forced) (`02-server-boundary.md:30`).
- **Tenant context is never client-controlled** — `withTenant` sets it tx-locally from verified `auth.tenantId`, the `DEFAULT_TENANT_ID` constant, or a server-derived `row.tenantId`; all ~80 call sites checked; `argus_app` is the non-bypass runtime role; policies fail closed on an unset GUC. Backed by `db/rls.spec.ts` (`02-server-boundary.md:33-37`).

### Invariant 2 — No secret/plaintext logging (Slices 02, 04, 06)
- **Default-deny everywhere**: the off-box error sink drops body/query/cookies/url, allowlists 4 headers, redacts presigned-URL/JWT/Bearer by value-shape (`02-server-boundary.md:42`); metric labels use route *templates* never `req.url` (`04-metadata-privacy.md:40`); WS token-verify failure is never logged; the Zod pipe emits `path: message`, never the rejected value. Web side has **zero** telemetry transport (`04-metadata-privacy.md:55`).
- **Infra logging clean**: every `log()` helper is name/status-only; **no `set -x`, no `curl -v`** anywhere in `infra/`; secret-bearing curls use `--config -` stdin not argv (`06-infra-deploy.md:41`).

### Invariant 5 — Secrets via Key Vault / Managed Identity (Slice 06)
- **No committed secret, no static cloud key in CI** — OIDC federation throughout; **no `aws_iam_access_key`/`aws_iam_user`** in Terraform (`06-infra-deploy.md:31`). Secrets minted from IMDS / Azure Arc HIMDS machine identity with no static credential, written atomically to tmpfs `0444` root files, never exported to env (`06-infra-deploy.md:24`).

### Invariant 6 — No admin path to content (Slices 02, 03, 04)
- **Six concrete break paths attempted, none reached content.** All 3 admin-gated controllers return bounded metadata; the device view caps the key at `left(signature_public_key, 12)` (non-reversible); the audit view omits the `metadata` jsonb; no debug/dump/raw/decrypt route exists; the GDPR routes key on `@CurrentAuth()` with no target-user param (no admin override) (`04-metadata-privacy.md:67-78`).

### Client at-rest (Slice 05) — the strongest client result
- **No browser-storage path persists message plaintext or key bytes unsealed.** One IndexedDB; all 13 write sites seal content/key bytes inside an AES-256-GCM `SealedBlob` under a **non-extractable** WebAuthn-PRF unlock key (fresh 12-byte CSPRNG IV per seal); the decrypted message-log is sealed *before* every `put`; no API/content response is ever cached; the *access* token is memory-only (`05-client-pwa.md:24-31`).

### Auth/device trust (Slice 03) — the headline question answered
- **A malicious server cannot silently add a device to a conversation.** The add is cryptographically bound to the OOB-verified fingerprint + a real Ed25519 proof-of-possession + ts-mls signature validation; a server-inserted member row is pure routing metadata with zero decryption power (`03-auth-identity.md:24`). *(The separate device-**linking** OOB code is the one weak spot — FP-1, §6.)*

---

## 4. Consolidated finding register (every P1 / P2 + the one PARTIAL)

Every P1 and P2 across all six slices, plus the session-token PARTIAL. **No P1/P2 surfaced in Slices 01 or 02** (the two confidentiality-core slices). Priority is the order to fix before beta.

| Prio | ID | Slice | Sev | One-line | Invariant(s) | Status |
|------|----|-------|-----|----------|--------------|--------|
| 1 | **BKP-1** | 06 | **P1** | Nightly DB backup **never deployed** on **either** CD track — the production Azure-VM path (`cd.yml:162`) and the parallel AWS experiment (`cd-aws.yml:154`) both omit `infra/backup` from the tar; `deploy.sh` enables only `argus-secrets`; host unit's `127.0.0.1:5432` can't reach port-less prod PG even if armed → silent total data loss on disk/volume/instance loss. | (availability; not a confidentiality break) | Spun-off fix PR — **blocks beta** |
| 2 | **FP-1** | 03 | P2-impact (rated P3, skeptic-**upgraded**) | Device-**linking** OOB artifact is only the 9-digit `enrollmentDisplayCode` (~30-bit); both the human compare and the fan-out byte-pin key off the **same** server-controlled `enrollment.fingerprint`, so they are not independent → a malicious server can grind a ~30-bit collision and inject a device. | 1, 4 (device-injection MITM) | Spun-off fix PR — **highest auth priority** |
| 3 | **CDI-1** | 05 | P2 (downgraded P1→P2) | MLS crypto chunks (`nist-*`, `ed448-*`, `chacha-*`) load via native dynamic `import()` with **no SRI at any layer** (Workbox precache backstop is dead — `revision:null`, zero integrity fields); a swapped chunk on the edge/CDN/cache leg runs inside the crypto boundary. | 1, 2, 4 | Spun-off fix PR (SW manifest-sha384 handler) |
| 4 | **CSP-1** | 05 | P2 | `connect-src` wildcard `*.s3.eu-central-003.backblazeb2.com` **+** the bare path-style endpoint = attacker-reachable exfil egress into a shared-tenant namespace; in-origin code can POST plaintext/keys out. | 1, 2 | Spun-off fix PR (pin exact prod bucket host; remove path-style) |
| 5 | **F1 / AR-1** | 04 | P2 | 90-day audit/session prune is **prose only** — no scheduler exists; `audit_events` PII (actor_sub, ip, user_agent, `metadata.targetArgusId` lookup history) grows unbounded in live DB + every backup. **Plus** `article-30-records.md:78` formally attests "enforced by cleanup worker" — an Art. 5(1)(e) compliance misstatement. | 2, 3 (+ GDPR) | Spun-off fix PR (prune job + Art.30 correction) |
| 6 | **BKP-2** | 06 | P2 | One B2 application key spans **both** buckets with delete on both; db-backup bucket has no Object Lock → one leaked key can erase all backups + live attachments (confidentiality still held by client-side `age`). | 5 (least-privilege) | Spun-off fix PR (two bucket-scoped keys + Object Lock) |
| 7 | **SUP-1** | 06 | P2 | Third-party CI container images mutable/unpinned — `semgrep/semgrep` runs **untagged `:latest`** in a job holding the repo checkout + `GITHUB_TOKEN` → third-party-code-exec path SHA-pinned actions don't cover. | (supply chain) | Spun-off fix PR (digest-pin CI images) |
| — | **ST-1** | 03 | P3 (PARTIAL basis) | `session-token-integrity` is **PARTIAL**: a *revoked* session's already-minted **access** token stays valid on non-admin routes for its full ≤10-min TTL (only `AdminGuard` re-checks `revoked_at`). Bounded, self-closing, admin surface live-revoked, refresh-chain theft closed by family-revoke. | (session lifecycle) | Spun-off OR accept-and-document — **must be written into `session-tokens.md`** |

**P3 / INFO tail (not enumerated here — see slice docs):** Slice 01 — 5 P3 (`01-crypto-core.md:60-66`). Slice 02 — 2 P3 (`02-server-boundary.md:58-61`). Slice 03 — 11 further P3 (`03-auth-identity.md:30-44`: ST-2, PK-1/2, BG-1/2, DA-1/2, FP-2, AI-1/2/3). Slice 04 — ER-1 + ~13 P3/Low/INFO (`04-metadata-privacy.md:90-110`). Slice 05 — ~13 P3 (`05-client-pwa.md:85-103`). Slice 06 — INF-1/2/3/4 + INFO-1/2 + BKP-3 (`06-infra-deploy.md:122-141`). The P3/INFO tail is overwhelmingly doc-staleness, missing regression guards, and defense-in-depth that holds today but could degrade on a careless future edit — none is a live confidentiality break.

---

## 5. Threat-model overclaim register

The shipped *code* is generally more correct than the threat-model *docs*. The campaign's Phase-1 reconciliation cross-checked all 58 threat-model notes against the slice findings and the shipped code, surfacing **49 overclaims (32 NEW, not previously flagged by any slice)**. The dominant pattern is a large cluster of stale notes describing **decommissioned designs** as current. These mislead a buyer/DPA/pen-tester worse than a missing doc, because they read as live attestations. **The single compliance-grade overclaim is the Art.30 "enforced by cleanup worker" line** — confirmed verbatim against `docs/gdpr/article-30-records.md:78`.

### NEW (not previously flagged by a slice) — the ones to act on first

| Sev | File / location | The overclaim | Reality |
|-----|-----------------|---------------|---------|
| **P1** | `auth-tenant-context.md` (title, §1) | Whole note attests **OIDC JWT + Zitadel JWKS** validation as the live edge auth. | Shipped `auth.service.ts:44-79` verifies **only** a self-minted argus EdDSA token; no Zitadel, no `createRemoteJWKSet`. Carries no decommission banner. |
| **P1** | `auth-tenant-context.md` §8 | **"Status: IMPLEMENTED"** — PKCE S256 + `oidc-client-ts` `UserManager` + `routes/Callback.tsx`. | No `oidc-client-ts` dep, no `Callback.tsx`; shipped web auth is passkey/WebAuthn-PRF. Explicit false "IMPLEMENTED." |
| **P2** | `key-model.md` (§1, §3, §6) | Lifecycle + residuals built on **passphrase / Argon2id / server-recoverable key backup**; asserts "forward secrecy holds because the artifact is identity-only." | `key-backup.ts` deleted, no backup API, `key_backups` dropped (`0040`). Defends a control that no longer ships; no superseded banner. |
| **P2** | `key-model.md` §4 #3 | **False-compliance:** "RLS upheld — `key_backups` has tenant_id + FORCE RLS + index." | The table was **dropped** (`0040_drop_key_backups.sql:3`). Attests RLS on a deleted table. |
| **P2** | `message-history.md`, `live-messaging.md`, `device-provisioning.md` | At-rest sealing described as **Argon2id 64 MiB + passphrase + `sealBackup`/`openBackup`**. | Shipped sealing is `sealWithKey`/`openWithKey` under the WebAuthn-PRF key — `keystore.ts:22` "NO passphrase and NO Argon2." Wrong KDF + wrong unlock trust boundary. |
| **P2** | `tenant-onboarding.md`, `vm-zitadel.md`, `vm-ingress.md`, `vm-deploy.md` | Describe **self-serve `POST /tenants` + Zitadel IdP + Zitadel masterkey in Key Vault** as current. | Routes removed; registration is passkey invite-redemption; Zitadel torn out of compose/secrets/deploy. Mis-sizes the attack surface and secret inventory. **The Azure-VM deploy in these notes is *not* stale — it remains the production target (`AGENTS.md:30`, `cd.yml`), with `infra/aws`/`cd-aws.yml` a deliberately parallel experiment; only the Zitadel content is the overclaim.** |
| **P2** | `rate-limiting.md` §1, §7 | "Authoritative edge rate-limit spec" lists **Stripe webhook + Zitadel `oauth/v2` + `/invites/accept` + `/backups/me`** rules. | All four surfaces decommissioned/never-built; no such controllers/ingress exist. Points the edge spec at dead endpoints. |
| **P2** | `phase-5-frontend-passkey.md` | **Recovery-code fallback** for PRF-less devices "included." | Explicitly removed (owner decision 2026-06-17, `passkey-auth.md:113-116`); `keystore.ts:25` "There is NO recovery." A reader believes a lost passkey can recover — it cannot. |

### ALREADY-FLAGGED by a slice (tracked, do not double-count)
- **The one compliance-grade overclaim:** `article-30-records.md:78` "enforced by cleanup worker" — confirmed verbatim; the control does not exist (F1/AR-1, `04-metadata-privacy.md:92`).
- `gdpr.md` — phantom `key_backups` cascade, claims email exported (code selects none), omits `friendships`, dead Zitadel-console erasure runbook (F3/GDPR-DOC-1/2, `04:95-98`).
- `multi-device-enrollment.md` T2 — equates the ~30-bit linking code with the full safety-number defense (FP-1, `03:40`).
- `session-tokens.md:125-126` — documents only the refresh-chain residual, not the ≤10-min access-token window (ST-1, `03:32`).
- `vm-deploy.md:51` / `vm-ingress.md:114` — "backups already built / data recoverable from nightly B2 backup" (BKP-1, `06`).
- `frontend-observability.md` §3 / `code-delivery-integrity.md` — "narrowly scoped connect-src" / dead Workbox-integrity claim (CSP-1/CDI-2, `05`).

**Recommendation — two doc-reconciliation PRs (no behaviour change), security-architect pass on each:**
1. **Decommission sweep** — banner or rewrite every **Zitadel/OIDC/Stripe** note to the shipped passkey + self-minted-token reality (`auth-tenant-context.md`, `tenant-onboarding.md`, `vm-zitadel.md`, `vm-ingress.md`, `vm-deploy.md`, `rate-limiting.md`, `session-tokens.md`, `phase-5/6` notes, `admin-panel.md`, `pseudonymous-identity.md`, `registration-and-tenancy.md`). **Do not rewrite the Azure-VM deploy as if AWS-EC2 were the live target** — production is the single Azure VM (`AGENTS.md:30`, `cd.yml`), and `infra/aws`/`cd-aws.yml` is a separate parallel experiment; the sweep must *separate* Azure production from the AWS experiment, not erase the live Azure runbooks (per Codex review of this PR). K8s/AKS was genuinely dropped and any remaining K8s note can be retired.
2. **Keystore-model sweep** — realign every passphrase/Argon2id/server-backup note to the PRF-sealed no-recovery lifecycle (`key-model.md`, `message-history.md`, `live-messaging.md`, `device-provisioning.md`, `device-keystore.md`).
3. **Art.30 correction is urgent and rides with the F1/AR-1 fix** — either ship the prune and keep the attestation, or change `docs/gdpr/article-30-records.md:78` to "currently unbounded" and re-clear with the GDPR owner. A false retention attestation in a record-of-processing document is the worst-failure category for a privacy product.

---

## 6. Residual-risk register

The honest "what remains and why." Each row: severity, whether it blocks beta, and the closing control.

| Risk | Sev | Blocks beta? | Why it's acceptable / not, and the closing control |
|------|-----|--------------|---------------------------------------------------|
| **BKP-1 — backups never deployed** | P1 | **YES** | A beta onboarding any real user inherits silent total data loss on disk/volume/instance loss. **Not acceptable.** Close: bundle `infra/backup`+`infra/cleanup` into both CD tars, install/enable the timer, give the worker an in-Compose-network DB path (not a published port), and a post-deploy assertion that it *connects*. |
| **FP-1 — device-linking grind** | P2-impact | **YES (close before linking is "MITM-safe")** | A malicious server — the exact adversary the OOB check exists to catch — can grind a ~30-bit collision and inject a device. Close: derive the OOB artifact from the full safety-number width (≥2⁶⁴) and add coverage. *Not* the conversation-add backdoor (that is cryptographically closed). |
| **CDI-1 + CSP-1 — active read-then-exfil chain** | P2 + P2 | **YES (land together)** | An in-origin attacker (XSS the strict `script-src 'self'` makes hard, **or** a swapped dynamic-import crypto chunk with no SRI on the edge/CDN leg) can read plaintext from heap/IndexedDB and POST it through the wildcard `connect-src`. Both halves are documented, maintainer-accepted. Close: SW manifest-sha384 fetch handler (CDI-1) + pin the exact prod bucket host and remove path-style (CSP-1). Bounded by requiring prior compromise + cosign on the build leg. |
| **F1/AR-1 — unbounded audit/session PII + ER-1 erasure gap** | P2 + P3 | **Strongly recommended before beta** | Pseudonymous metadata (probed argus-ids, refresh IPs) accumulates forever in the live DB and every backup; Art.17 erasure is actor-scoped so an erased user's argus-id survives as a *lookup target* (ER-1). Bounded in *kind* (never content/keys; invariants 2/3 hold) but not in *time*. Close: the prune job + extend erasure to scrub `targetArgusId` + correct the Art.30 record. |
| **BKP-2 — shared B2 key, no Object Lock** | P2 | No (carry with mitigation) | One leaked key erases all backups + live attachments; **confidentiality still held by client-side `age`**, so it is a *recoverability* risk, not a disclosure one. Close: two bucket-scoped keys + Object Lock on the db bucket. |
| **SUP-1 — mutable CI images** | P2 | No (fix early) | `semgrep/semgrep:latest` is a third-party-code-exec path with repo access. No live compromise; SHA-pinning actions doesn't cover it. Close: digest-pin CI images + extend Dependabot. |
| **ST-1 — ≤10-min revoked-access-token window** | P3 | No | Bounded, self-closing, admin surface live-revoked, refresh theft closed. Acceptable as a documented residual **only once written into `session-tokens.md`**. Optional close: `sid`-revocation cache in `JwtAuthGuard` or shorter TTL. |
| **INF-4 — cloudflared token at rest in Docker metadata** | P3 | No | Host-root/docker-group readable only (same tier that reads tmpfs secrets); a network-ingress credential, not an E2EE key. Close: cloudflared credentials-file mode. |
| **At-rest blast-radius single points** (single `age` recipient AR-4; B2 bucket posture un-IaC'd AR-3) | P3 | No | Conceded; neither breaks "stolen backup/blob yields only ciphertext." Close (pre-GA): second offline `age` recipient + rotation runbook; assert `bucketType==allPrivate` + lifecycle. |
| **TOFU first-contact** | accepted | No | Signal-model first-contact window with the key-change warning shipped; key-transparency log is the GA path (`01-crypto-core.md:98`). |
| **RC-1 — refresh cookie at rest** | P3 | No | ~30-day HttpOnly `argus_refresh` cookie grants auth/metadata on a stolen *device*, **no key or content**; revocable server-side. Intentional session design. |
| **Unlocked-session heap exposure (F2)** | P3 | No | While unlocked, `sessionKey` + raw MLS privates sit in React state; unavoidable in a browser, accepted, mitigated by strict CSP. Optional: lock-on-idle/hidden. |
| **Verifiability gaps** (no test pins CSP/headers — CSP-3; SRI presence — CDI-4; HSTS in no artifact — CSP-2; Alloy scrub untested — OBS-2) | P3 | No | All hold today; each would degrade *undetected* on a careless future edit. Close: header-assertion CI test, SRI build-output guard, HSTS-as-IaC, Alloy golden-line test. |

---

## 7. Verdict & conditions to ship

**Is argus's core E2EE privacy claim PROVEN? Yes — with precise caveats.** Six adversarial slices, with maxed-Opus reviewers actively trying to break each claim, established that the server is cryptographically blind to content (invariant 1), all cryptography goes through the vetted MLS library with CSPRNG-only randomness (invariant 4), tenant isolation is FORCE-RLS on all 18 tenant tables with no client-controlled tenant context (invariant 3), no admin or log path reaches content (invariants 6, 2), and the malicious-server silent-device-*add* backdoor is cryptographically closed (Slice 03). Passively at rest, the browser endpoint leaks no message plaintext or key bytes. These are genuine, evidence-anchored results, not marketing.

**The privacy core is sound; the safe-*operation* envelope is not yet closed.** Three things distinguish "the crypto is right" from "a real user is safe":

**MUST land before beta onboards a real user:**
1. **BKP-1 (P1)** — *above all else.* Until the backup actually runs and connects on the shipped target, "restorable" is vacuously false and the first user inherits silent total data loss. This is not a confidentiality issue, but it is the single most consequential finding in the campaign.
2. **FP-1** — widen the device-linking OOB artifact to the full safety-number width before the linking flow can be called MITM-safe.
3. **CDI-1 + CSP-1** — land together (SW manifest-sha384 handler + `connect-src` host pin) to close the active read-then-exfil chain.
4. **F1/AR-1** — ship the audit/session prune **and** correct the `docs/gdpr/article-30-records.md:78` "enforced by cleanup worker" attestation. The compliance misstatement must not survive into a DPA-facing record.

**Acceptable to carry as a documented beta residual** (each must actually be written into its threat-model note, not just known): ST-1 (≤10-min revoked-access window), BKP-2 (shared B2 key — confidentiality held by `age`), SUP-1 (mutable CI images), INF-4 (cloudflared token at rest), TOFU first-contact, RC-1 (refresh cookie at rest), the unlocked-session heap exposure, and the at-rest blast-radius single points (AR-3/AR-4). Plus the two doc-reconciliation PRs (decommission sweep + keystore-model sweep) so the threat-model corpus stops attesting controls that no longer ship.

**Bottom line:** argus is built to a genuinely strong E2EE design and the implementation honors it — the confidentiality promise survived a hard, adversarial break attempt. It is *provably private*. It is not yet *provably safe to operate* until BKP-1 is fixed; close that, the FP-1 / CDI-1 / CSP-1 / F1 set, and the Art.30 attestation, and the "private and safe" claim stands on evidence rather than aspiration.

---

*Source slice notes (authoritative for per-claim evidence):* `docs/reviews/01-crypto-core.md`, `docs/reviews/02-server-boundary.md`, `docs/reviews/03-auth-identity.md`, `docs/reviews/04-metadata-privacy.md`, `docs/reviews/05-client-pwa.md`, `docs/reviews/06-infra-deploy.md`. *Campaign plan:* `docs/security-review-campaign-plan.md`. *The one compliance-grade overclaim:* `docs/gdpr/article-30-records.md:78`.
