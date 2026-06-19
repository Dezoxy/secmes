# Review 01 — Crypto core & key lifecycle

> **Slice 1** of the security review campaign (`docs/security-review-campaign-plan.md`).
> **Date:** 2026-06-19 · **Reviewed against `main` @ `4282df25`** (post-#250).
> **Method:** ultracode workflow — 16 `crypto-reviewer` subagents (Opus, max effort): 1 recon + 6 adversarial
> finders (one per claim, each trying to *break* it) + a skeptic refutation pass on every finding.
> **Result:** all six claims **PROVEN**. No P1/P2. 5 confirmed findings, all **P3** (defense-in-depth / hygiene);
> 4 candidate findings **refuted** by the skeptic pass.

## Claims in scope (proves invariants 1 & 4)

| # | Claim | Verdict |
|---|---|---|
| leak-logging | No plaintext content or key material (private/session/message keys, PRF unlock key, seeds, salts) reaches a log, error, exception, telemetry, or the wire in clear. | ✅ PROVEN |
| csprng | All randomness in security paths is CSPRNG; no `Math.random`, Date-as-entropy, or weak/seeded PRNG anywhere in keys/nonces/IVs/salts/tokens. | ✅ PROVEN |
| keystore-prf | All six `SECRET_STORES` are sealed under a **non-extractable** AES-256-GCM unlock key with a unique IV per seal; no recovery; no server-side recoverable secret (0040 dropped `key_backups`). | ✅ PROVEN |
| envelope-aead | The envelope uses AEAD correctly: unique nonce per encryption, AAD binds context, integrity verified before use, no malleability/downgrade. | ✅ PROVEN |
| key-substitution | A malicious server cannot swap a claimed KeyPackage / device key undetected; trust is anchored on the MLS-validated embedded key + client safety-number check. | ✅ PROVEN |
| no-handrolled | All primitives come from the vetted crypto/MLS library; no ad-hoc constructions outside `packages/crypto`. | ✅ PROVEN |

## Evidence (highlights — full per-claim evidence in the workflow transcript)

- **leak-logging.** `rg console.*` over the crypto surface returns nothing; the only interpolated throws are MLS
  protocol enum tags (`index.ts:101,180,666,672,704,712`), never key/plaintext bytes; AES-GCM failures are opaque
  (`seal.ts:92,153`, `keystore.ts:688,949`). Message-path `console.warn`s log id + epoch + opaque error only
  (`messaging.ts:181,225,294`). Server-bound bodies carry only `{ciphertext, alg, epoch, clientMessageId}`
  (`messaging.ts:79-84`, `contracts index.ts:279-286`). PRF unlock key is stripped from the WebAuthn response
  (`stripPrfResults`, `prf.ts:82-104`) **before** any verify POST. Defense-in-depth redaction allowlists in
  `telemetry.ts:28-74` and `error-tracking.ts:64`.
- **csprng.** Every key/nonce/IV/salt/token traced to a CSPRNG (`crypto.getRandomValues`, `crypto.randomUUID`,
  node `randomBytes`/`randomInt`, `@noble` `randomSecretKey` which throws if `getRandomValues` is absent — no
  fallback). `Math.random` has **zero** functional uses repo-wide (two ban-comments only). No seeded PRNG, no
  third-party id libs, no Date-as-entropy. Enforced by Semgrep `argus-no-insecure-random` (ERROR, no excludes).
- **keystore-prf.** `importUnlockKey` (`seal.ts:50-53`) imports with `extractable=false`; PRF secret wiped after
  (`prf.ts:96-103`). `sealWithKey` uses a fresh 12-byte CSPRNG IV per call (`seal.ts:64`), AES-256-GCM, domain-
  separated AAD. Every `.put()` in all six stores carries a `sealed: SealedBlob` and no plaintext column
  (device/pool/group/**msglog**/pending/verified-peers); `StoredMessage.content` is in-memory only, sealed before
  the MSGLOG put with `conversationId` bound into AAD. v7 upgrade wipes all stores on the passphrase→PRF cutover.
  `0040_drop_key_backups.sql` drops the server table; no live `key_backups`/`backup` field remains.
- **envelope-aead.** Message AEAD delegated to ts-mls (`createApplicationMessage`), nonce derived from the
  per-message ratchet generation; a per-conversation mutex (`index.ts:470,478-485`) serializes ops and the ratchet
  is persisted *before* the ciphertext is sent, so a crash can't roll back into nonce reuse. Decrypt rejects
  trailing bytes / wrong wireformat and assigns state only after a valid `applicationMessage` (`index.ts:702-715`).
  Suite pinned `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`; the wire `alg` tag is never read to select a cipher.
- **key-substitution.** Server stores only PUBLIC/opaque material under RLS; `publish` binds KeyPackages to the
  verified caller's device, `claim` is atomic one-time-use. The safety number is derived from the KeyPackage's
  **embedded** `leafNode.signaturePublicKey` (`index.ts:177-208`), never the server's loose routing field, so a
  byte-swap shifts the number and trips the out-of-band check. `confirm()` (add-member) is structurally
  unreachable until the user confirms "they match" per device (`StartConversation.tsx:141-191`). The joiner side
  is MLS-validated (`validateRatchetTree` verifies parent hashes + every leaf signature) and warns on key change
  (`onPeerKeyChanged` → amber banner), anchored by the sealed `VERIFIED_PEERS_STORE`.
- **no-handrolled.** Outside `packages/crypto` the only primitive uses are `createHash('sha256')` for opaque-token
  digests, `createHash('sha384')` for build SRI, and breakglass Argon2id — all non-E2EE server-auth, pre-cleared
  in `breakglass-admin.md` / `session-tokens.md`. `@noble` is confined to `packages/crypto/device-proof.ts` (the
  audited Ed25519 import) and `apps/api/src/auth` (Argon2id). No `crypto.subtle`/`createCipheriv`/`createHmac`/
  `pbkdf2`/`scrypt` outside the boundary. Codified by Semgrep `argus-crypto-only-in-crypto-package`.

## Findings — all P3 (none block; none are confidentiality/integrity defects)

| # | Title | File | Note |
|---|---|---|---|
| F1 | Stale `backup` comments after `key_backups` was dropped | `apps/api/src/openapi.ts:30,44` | Doc hygiene only (skeptic re-rated **N/A** security weight). **Fixed in this PR.** |
| F2 | Random-IV nonce budget (~2³² per key) documented, not enforced; MSGLOG re-seals whole log per append | `apps/web/src/lib/keystore.ts:663-668,743-791` | Comfortably within budget at current scale (would need ~4×10⁹ appends under one PRF key). Revisit if multi-device sync / server history lands. **Tracked residual.** |
| F3 | Attachment AEAD passes no AAD — objectKey/conversation binding enforced by the envelope, not GCM | `packages/crypto/src/seal.ts:127` | Not exploitable (content key is fresh CSPRNG inside the MLS envelope; blob-swap fails GCM auth). Defense-in-depth: bind `objectKey` (+`conversationId`) as AAD. **Spun off as a follow-up.** |
| F4 | Verified-peer record keyed by server-set `senderUserId` | `apps/web/src/features/chat/useLiveConversations.ts:281-300` | Metadata-integrity nuisance only; cannot bypass key-substitution detection (safety number comes from the MLS ratchet tree, not `senderUserId`). Fails safe. **Tracked residual.** |
| F5 | Semgrep crypto-boundary rule omits `createHash` / `@noble` / `@hpke` | `.semgrep/argus.yml:26` | Enforcement-net gap, not a current violation. **Partially fixed in this PR** (`@noble`/`@hpke` import guard added); the `createHash` portion is left as a tracked recommendation (it has legitimate non-crypto uses needing path-aware carve-outs). |

### Refuted by the skeptic pass (4)
- *Merged-log buffer not zeroed* — it's decrypted **content**, not key material, and the same plaintext lives in
  longer-lived un-wipeable copies; zeroing one transient buffer adds nothing.
- *MSGLOG uses "bare" conversationId as AAD* — misread: `sessionAad()` always prepends the constant
  `argus-session 1` + `0x1f` domain prefix, so MSGLOG and group-state are domain-separated identically.
- *TOFU first-contact window* — documented, accepted beta residual with the change-warning shipped (Signal model).
- *No server-side leaf-key↔column binding* — the server is **forbidden** from parsing MLS blobs (invariant 1/4);
  all client trust uses the embedded key, so the absent check is the mandated design, not a gap.

## Guards added (this PR)
Two Semgrep rules turn the prose allowlist into enforced, module-precise rules (closing the high-value part of
F5; both run in pre-commit + CI like the other `.semgrep/` rules, verified 0 findings on current source):
- **`argus-no-vetted-crypto-libs-outside-boundary`** — bans `@noble/curves` / `@hpke/*` anywhere outside
  `packages/crypto/**`. Deliberately does **not** exempt `apps/api/src/auth` — a stray protocol-crypto import
  there must still trip (per Codex review of this PR).
- **`argus-argon2id-only-in-auth`** — confines `@noble/hashes` (the Argon2id breakglass exception) to
  `packages/crypto/**` + `apps/api/src/auth/**`; banned everywhere else.

## Residual risk (accepted for this phase)
- **F2** nonce budget: accepted — unreachable at single-user/multi-tab scale; flagged for re-evaluation when
  multi-device sync or server-side history arrives (Slice 4/later).
- **F4** trust-record attribution by `senderUserId`: accepted — degrades safely (worst case: a spurious
  re-verify prompt); hardening (anchor on credential-attested identity) noted for later.
- **F5** `createHash` enforcement: accepted gap — no current violation; a path-aware rule extension is recommended
  but deferred to avoid false-positives on the legitimate opaque-token digests.
- **TOFU first-contact**: accepted beta posture; the planned key-transparency log is the path to close it.
