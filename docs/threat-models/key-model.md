# Threat model: the key model (consolidated) — crypto review #1

> Status: **DRAFT for ratification.** Roadmap **checkpoint 20 ("Crypto review #1")**. This is the synthesis note: now that key generation (17–18), the key directory (19), and backup/recovery (21–23) have all landed, it reviews the **whole key lifecycle end-to-end** and records the cross-cutting residuals. It does not replace the per-feature notes — `mls-integration.md`, `device-keystore.md`, `key-directory.md`, `key-backup.md` — it ties them together. Two reviewer passes back this note: **`crypto-reviewer` PASS** (client crypto/lifecycle) and **`security-boundary-auditor` PASS w/ one fixed Must-fix** (server key surface).

## 0. Checkpoint-20 gate status

Checkpoint 20's own gate (`key-directory.md` §5) is **"implement the fingerprint-verification MITM defense, not just write it."** That defense is client UX and cannot ship before the client app exists (**checkpoint 39**). Therefore **20 stays `[~]` (review + this note done; gate open)** until fingerprint/safety-number verification lands in Phase 5. This note records the review pass and the open gate honestly rather than marking 20 complete.

## 1. Feature & data flow (the lifecycle)

```
generate (18)  device → MlsEngine.generateDeviceKeys → {signature keypair (identity), one-time KeyPackage (init/hpke)}
store (18→21)  full DeviceKeys sealed at rest in IndexedDB (Argon2id + AES-256-GCM), unlocked by passphrase
publish (19)   PUBLIC KeyPackage(s) → key directory; server binds each to the authenticated uploader
claim (19)     peer fetches one PUBLIC KeyPackage one-time-use (atomic FOR UPDATE SKIP LOCKED)
backup (21–22) IDENTITY-ONLY material (signature keypair) sealed under passphrase → opaque blob → server
recover (23)   fresh device → fetch blob → passphrase → mint a FRESH KeyPackage under the restored identity → re-publish + re-join
```

The server stores/forwards **public KeyPackages** and **opaque sealed ciphertext** only. It never sees a private key, a passphrase, or plaintext. It *is* the introducer (it chooses which KeyPackage a caller receives) — the one piece of trust we must not require, addressed in §3.1.

## 2. Assets & trust boundaries

- **Assets:** the device **signature/identity private key** (long-lived identity); one-time **KeyPackage HPKE private keys** (Welcome-decryption, forward-secret); the **passphrase** and the backup ciphertext; the authenticity of the **identity ↔ public-key** binding.
- **Boundaries:** client ↔ server (server crypto-blind, but trusted-as-introducer — the gap); tenant ↔ tenant (RLS on every key table); page-JS ↔ at-rest store (XSS reads sealed ciphertext, useless without the passphrase).

## 3. Threats (STRIDE-lite, cross-cutting)

- **Spoofing — server key-substitution / active MITM (THE critical residual).** A compromised server returns its own KeyPackage for "Bob"; MLS Basic credentials don't catch it. Defense = **client-side fingerprint verification (TOFU + change-warning)**, designed in `key-directory.md` §5, **not yet built** (needs the client, 39). This is checkpoint 20's open gate.
- **Tampering — backup blob / sealed keystore.** AES-256-GCM with the full header (`v|kdf|params|salt|iv`) bound as additional-data → any bit-flip or version/param downgrade fails authentication. Identity binding on recovery: the embedded credential identity must equal the requested identity before keys are accepted (confusion check, not authenticity — see §6).
- **Information disclosure — leaked backup → history.** Closed in 23: the recovery artifact is **identity-only** (no init/hpke private keys), so a leaked backup + cracked passphrase **cannot decrypt a retained Welcome** → forward secrecy holds. Offline brute-force of a leaked blob is bounded by Argon2id (64 MiB/t3/p1, floor+ceiling) + a unique CSPRNG salt; backup-fetch rate-limiting is checkpoint 46 (audited until then).
- **Elevation — intra-tenant pool drain / cross-tenant claim.** Cross-tenant claim is closed by RLS (global UUIDs match zero rows in another tenant → 404). Intra-tenant drain (an authenticated member consuming a peer's one-time KeyPackages) is **by-design reachable**; mitigated for beta by a per-device publish cap + auditing every claim; per-(caller,target) rate-limiting is checkpoint 46.

## 4. Invariant check

- **#1 crypto-blind server** — upheld: only public KeyPackages + opaque ciphertext cross the boundary; no server-side parse/decrypt of key material. Substitution (§3.1) is the one place the invariant must be made *client-detectable*, not merely policy — tracked, not yet shipped.
- **#2 no secret logging** — upheld: zero `console`/logger in the crypto package and keystore; audit rows carry `eventType` + `actorSub` + bounded UA only; no key/ciphertext/token/Authorization/presigned-URL in any log.
- **#3 RLS on every tenant table** — upheld: `devices` and `key_packages` each have `tenant_id` + ENABLE+FORCE RLS + WITH CHECK + leading-`tenant_id` index; runtime role `argus_app` is non-bypass; tenant context comes only from the verified token claim. (`key_backups` was dropped in migration 0040 — the keystore is now WebAuthn-PRF-sealed with no server-side recoverable backup; see `device-keystore.md`.)
- **#4 no hand-rolled crypto** — upheld: all primitives via `ts-mls` + `@noble/hashes` Argon2id + WebCrypto AES-GCM; no `Math.random` in any security path (the one `crypto.subtle` outside the package is PKCE S256 OAuth plumbing, not E2EE).
- **#5 secrets via Key Vault** — N/A to this surface (no new cloud secrets).
- **#6 no admin path to content** — upheld: key/backup surfaces expose IDs/metadata only.

## 5. Decision & mitigations (what this review changed)

- **Fixed (Must-fix, server boundary):** the OpenAPI spec omitted input bounds (the real `maxLength`/`maxItems`/`pattern`/`additionalProperties:false` lived only in Zod, invisible to 42Crunch). Mirrored the bounds onto the `PublishKeyPackagesBody` + `BackupBody` DTOs and pinned `additionalProperties:false`; regenerated `openapi.json` so the documented contract matches enforcement (invariant 5).
- **Hardened (Should-improve):** added `.strict()` to `PublishKeyPackagesSchema` + `StoreBackupSchema` (reject unknown keys, fail-closed) with unit tests.
- **Gates:** `crypto-reviewer` (client crypto), `security-boundary-auditor` (server surface), Semgrep/CodeQL/gitleaks/OSV in CI, the 42Crunch audit on the refreshed spec.

## 6. Residual risk (recorded; carried forward)

1. **No identity↔key authenticity yet (TOFU gap) — the #1 residual.** Fingerprint/safety-number verification + change-warning is the MITM defense; designed, **not implemented** (Phase 5 / client). Checkpoint 20's gate stays open on it.
2. **Upload-path footgun (MUST-WIRE).** Nothing structurally stops a *future* uploader from sending the full at-rest `sealed` blob (which still holds one-time HPKE private keys) instead of the identity-only `exportRecoveryArtifact` output — both are `string`. When the backup-upload wiring lands, give the artifact a **branded type** so the backup API can only accept the identity-only blob. Until then the FS guarantee rests on convention (documented here + in `device-keystore.md` §6).
3. **Best-effort secret wiping in JS.** `wipe()`/`.fill(0)` zero the buffers we hold but can't guarantee ts-mls/V8 kept no internal copy. Accepted client limitation.
4. **Unsealed keys in memory during an active session** are XSS-readable while unlocked; reduced (not eliminated) by CSP/SRI (checkpoint 43).
5. **Passphrase is the weakest link**; a lost passphrase is unrecoverable by design (no server reset, or the server could decrypt).
6. **Backup overwrite bricks recovery.** `store` is an upsert keyed on `(tenant_id, user_id)` with no versioning; a compromised own-session can silently replace the only backup. Consider keeping N prior sealed blobs (deferred).
7. **Drain / no-GC / unbounded device count.** Intra-tenant pool drain and accumulation of claimed rows depend on checkpoint-46 rate-limiting + a future GC worker; no global per-user/tenant device cap yet. Audited, bounded, accepted for beta.
8. **Contract-vs-enforcement drift is structural.** Bounds live in local Zod, not `@argus/contracts`; track migrating these schemas into the shared package as more key endpoints land.
