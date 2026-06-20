# Threat model: the key model (consolidated) — crypto review #1

> Status: **Ratified (2026-06-19); keystore + backup sections realigned to the PRF model.** Roadmap **checkpoint 20 ("Crypto review #1")**. This synthesis note reviews the **whole key lifecycle end-to-end** and records the cross-cutting residuals; it ties together the per-feature notes — `mls-integration.md`, `device-keystore.md`, `key-directory.md`, `prf-keystore-unlock.md` — rather than replacing them.
>
> **Supersession (PR #233 / migration `0040_drop_key_backups.sql`).** The original checkpoints 21–23 designed a **passphrase / Argon2id / server-stored `key_backups`** backup-and-recovery scheme. That whole surface was **removed**. The keystore is now sealed directly under a **per-passkey WebAuthn-PRF key** (no passphrase, no Argon2, no server backup), and there is **no recovery** — a lost passkey is a fresh start (the admin mints a new registration code). The authoritative current design is [`prf-keystore-unlock.md`](prf-keystore-unlock.md); the at-rest sealing primitives live in `packages/crypto/src/seal.ts` (`importUnlockKey`/`sealWithKey`/`openWithKey`). Every backup/recovery claim below has been struck or rewritten to match shipped code.

## 0. Checkpoint-20 gate status

Checkpoint 20's own gate (`key-directory.md` §5) was **"implement the fingerprint-verification MITM defense, not just write it."** That defense — per-device **safety-number verification** plus a **key-change warning** — has since **shipped** with the client (Phase 5: `apps/web/src/features/chat/VerifySecurity.tsx`, the sealed `verified-peers` keystore store, and the `onPeerKeyChanged` warning path). The safety number derives from the KeyPackage's *embedded* `leafNode.signaturePublicKey` (never a server routing field), so a server key-substitution shifts the number and trips the out-of-band check. The residual is the **TOFU first-contact window** (no prior key to compare on the very first exchange) and the absence of a **key-transparency log** (the GA path) — both carried as accepted beta residuals (`docs/reviews/00-attestation.md`).

## 1. Feature & data flow (the lifecycle)

```
generate (18)  device → MlsEngine.generateDeviceKeys → {signature keypair (identity), one-time KeyPackage (init/hpke)}
store          full DeviceKeys sealed at rest in IndexedDB under the per-passkey PRF UNLOCK KEY
               (AES-256-GCM, non-extractable CryptoKey; NO passphrase, NO Argon2) — apps/web/src/lib/keystore.ts
publish (19)   PUBLIC KeyPackage(s) → key directory; server binds each to the authenticated uploader
claim (19)     peer fetches one PUBLIC KeyPackage one-time-use (atomic FOR UPDATE SKIP LOCKED)
(no backup)    there is NO server-side key backup and NO recovery — a lost passkey / wiped keystore is a fresh start
```

The server stores/forwards **public KeyPackages**, opaque MLS message wire bytes, and — for offline delivery (`conversation_welcomes`) — the **Welcome** (HPKE-sealed to the recipient device's KeyPackage; ciphertext) plus the **`ratchet_tree`** (public MLS tree data: group public keys + membership, i.e. metadata, **not** ciphertext). Both are opaque to the server and FORCE-RLS tenant-scoped. It never sees a private key or plaintext, and (since the `key_backups` removal) holds **no server-stored device-key backup/escrow**. It *is* the introducer (it chooses which KeyPackage a caller receives) — the one piece of trust we must not require, addressed in §3.

## 2. Assets & trust boundaries

- **Assets:** the device **signature/identity private key** (long-lived identity); one-time **KeyPackage HPKE private keys** (Welcome-decryption, forward-secret); the **per-passkey PRF unlock key** that seals the at-rest keystore; the authenticity of the **identity ↔ public-key** binding.
- **Boundaries:** client ↔ server (server crypto-blind, but trusted-as-introducer — the gap, mitigated by safety-number verification); tenant ↔ tenant (RLS on every key table); page-JS ↔ at-rest store (XSS reads sealed ciphertext, useless without the in-memory PRF unlock key — which is non-extractable and never persisted).

## 3. Threats (STRIDE-lite, cross-cutting)

- **Spoofing — server key-substitution / active MITM.** A compromised server returns its own KeyPackage for "Bob"; MLS Basic credentials don't catch it at the protocol layer. Defense = **client-side safety-number verification + key-change warning** (shipped, Phase 5; §0). The safety number keys off the *embedded* signature public key, so a substitution is detectable out-of-band. Residual: the TOFU first-contact window + no key-transparency log.
- **Tampering — sealed keystore.** Every at-rest blob is AES-256-GCM with a domain-separation AAD per store (`device`, `key-package-pool`, `group-state:<id>`, `pending-commit:<id>`, the bare conversationId for the log, `verified-peers:<id>`) → any bit-flip or cross-slot relocation fails authentication (`seal.ts`, `keystore.ts`). On unseal, the identity embedded in the decrypted KeyPackage must equal the requested identity (confusion check, not authenticity — see §6).
- **Information disclosure — leaked at-rest keystore.** Forward secrecy holds because **there is no recoverable artifact to leak**: the keystore is sealed under a non-extractable PRF unlock key that lives in memory only and is never persisted or transmitted, and a discarded device's private key is unrecoverable, so nothing sealed to it can be opened later. The former passphrase-cracking surface (a leaked server-stored backup brute-forced offline) is gone with the `key_backups` removal.
- **Elevation — intra-tenant pool drain / cross-tenant claim.** Cross-tenant claim is closed by RLS (global UUIDs match zero rows in another tenant → 404). Intra-tenant drain (an authenticated member consuming a peer's one-time KeyPackages) is **by-design reachable**; mitigated for beta by a per-device publish cap + auditing every claim; per-(caller,target) rate-limiting is checkpoint 46.

## 4. Invariant check

- **#1 crypto-blind server** — upheld: public KeyPackages, the HPKE-sealed Welcome ciphertext, and the public `ratchet_tree` (group public keys + membership metadata) cross the boundary; the server holds **no device-key backup/escrow** (the `key_backups` surface was removed) and never parses/decrypts key material. Substitution (§3) is made *client-detectable* via safety-number verification, not merely policy.
- **#2 no secret logging** — upheld: zero `console`/logger in the crypto package and keystore; audit rows carry `eventType` + `actorSub` + bounded UA only; no key/ciphertext/token/Authorization/presigned-URL in any log.
- **#3 RLS on every tenant table** — upheld: `devices` and `key_packages` each have `tenant_id` + ENABLE+FORCE RLS + WITH CHECK + leading-`tenant_id` index; runtime role `argus_app` is non-bypass; tenant context comes only from the verified token claim. The `conversation_welcomes` table (the HPKE-sealed Welcome + the public `ratchet_tree`) is likewise `tenant_id` + FORCE-RLS. *(The former `key_backups` device-key-backup table was dropped in `0040_drop_key_backups.sql`.)*
- **#4 no hand-rolled crypto** — upheld: MLS via `ts-mls`, device proofs via `@noble` Ed25519, at-rest sealing via WebCrypto AES-256-GCM under the PRF unlock key. **No Argon2 in the key/keystore path** — the PRF output is already uniformly-random 256 bits, so a memory-hard KDF buys nothing (`seal.ts:1`). Argon2id remains only on the unrelated breakglass-admin password surface (a pre-cleared invariant-#4 exception), not in the E2EE key model. No `Math.random` in any security path.
- **#5 secrets via Key Vault** — N/A to this surface (no new cloud secrets).
- **#6 no admin path to content** — upheld: key surfaces expose IDs/metadata only; the breakglass admin has no MLS device and no keystore.

## 5. Decision & mitigations (what this review changed)

- **Fixed (Must-fix, server boundary):** the OpenAPI spec omitted input bounds (the real `maxLength`/`maxItems`/`pattern`/`additionalProperties:false` lived only in Zod, invisible to 42Crunch). Mirrored the bounds onto the `PublishKeyPackagesBody` DTO and pinned `additionalProperties:false`; regenerated `openapi.json` so the documented contract matches enforcement (invariant 5). *(The original review also bounded a `BackupBody` DTO; that endpoint was later removed with the `key_backups` surface.)*
- **Hardened (Should-improve):** added `.strict()` to `PublishKeyPackagesSchema` (reject unknown keys, fail-closed) with unit tests.
- **Gates:** `crypto-reviewer` (client crypto), `security-boundary-auditor` (server surface), Semgrep/CodeQL/gitleaks/OSV in CI, the 42Crunch audit on the refreshed spec.

## 6. Residual risk (recorded; carried forward)

1. **TOFU first-contact window — the #1 residual.** Safety-number verification + key-change warning ship (§0), but the very first exchange has no prior key to compare against; a key-transparency log is the GA path. Accepted beta residual.
2. **No recovery by design.** A lost passkey or wiped browser keystore is unrecoverable — the admin mints a new registration code and the device starts fresh (decisions #6/#7; `prf-keystore-unlock.md`). This is the deliberate replacement for the removed server-backup scheme: no server-held secret means no server-side decryption path, so confidentiality never rests on a passphrase or a server-stored blob.
3. **Best-effort secret wiping in JS.** `.fill(0)` zeroes the buffers we hold but can't guarantee ts-mls/V8 kept no internal copy. Accepted client limitation.
4. **Unsealed keys in memory during an active session** are XSS-readable while unlocked; reduced (not eliminated) by CSP/SRI (checkpoint 43). The PRF unlock key itself is non-extractable and never persisted.
5. **Drain / no-GC / unbounded device count.** Intra-tenant pool drain and accumulation of claimed rows depend on checkpoint-46 rate-limiting + a future GC worker; no global per-user/tenant device cap yet. Audited, bounded, accepted for beta.
6. **Contract-vs-enforcement drift is structural.** Bounds live in local Zod, not `@argus/contracts`; track migrating these schemas into the shared package as more key endpoints land.
