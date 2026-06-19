# Threat model: CSPRNG audit (randomness sources)

> Status: **DRAFT for ratification.** Roadmap **checkpoint 24 ("CSPRNG audit — no `Math.random` in security paths; Semgrep rule green")**. A point-in-time enumeration of every randomness source in the codebase, confirming each is a CSPRNG, plus the lint rule that keeps it that way.

## 1. Why this matters

In an E2EE system, predictable randomness is a full break: a guessable key, nonce, salt, IV, or token defeats the cryptography regardless of the algorithm. `Math.random()` is a non-cryptographic PRNG (seedable, predictable) and must never touch a security path. This audit proves no security-relevant value derives from a weak source, and pins a Semgrep rule so a regression fails CI.

## 2. Randomness inventory (audited)

Every randomness source in `apps/` + `packages/` (excluding `node_modules`, build output, and the throwaway spike), and its mechanism:

| Where | Use | Source | CSPRNG? |
|---|---|---|---|
| `packages/crypto/src/seal.ts:64` | seal **IV** (12 B) | `crypto.getRandomValues` (WebCrypto) | ✅ |
| `packages/crypto/src/seal.ts:121–122` | attachment **key** (32 B) + **IV** (12 B) | `crypto.getRandomValues` (WebCrypto) | ✅ |
| `packages/crypto` (via `ts-mls`) | MLS signature/HPKE key generation, KeyPackages | `@noble/*` → WebCrypto | ✅ |
| `apps/web/src/lib/ws.ts:255` | reconnect backoff **jitter** | `crypto.getRandomValues` (WebCrypto) | ✅ |
| `apps/web/src/**` (`useMessageSending.ts`, `lib/messaging.ts`, `lib/conversations.ts`, `lib/enroll.ts`, `features/device/DeviceContext.tsx`, `features/settings/argus-profile.ts`) | non-secret client **correlation IDs** (message/attachment/conversation/commit/profile) | `crypto.randomUUID()` (WebCrypto) | ✅ |
| `apps/api/src/auth/session-token.service.ts:42,75,140` | session **refresh tokens** (32 B → hex) | `node:crypto` `randomBytes` | ✅ |
| `apps/api/src/auth/webauthn.service.ts:126,324` (+ `@simplewebauthn` `generateRegistration/AuthenticationOptions`) | WebAuthn **challenges** (32 B) | `node:crypto` `randomBytes` | ✅ |
| `apps/api/src/auth/breakglass.service.ts:118–119,474` (+ `scripts/hash-admin-password.ts:32`) | Argon2id **salts** + dummy-hash inputs (16/32 B) | `node:crypto` `randomBytes` | ✅ |
| `apps/api/src/tenants/tenants.service.ts:30` | tenant **invite codes** (32 B → base64url) | `node:crypto` `randomBytes` | ✅ |
| `apps/api/src/users/argus-id.ts:16,18` + `handle-words.ts:424–425` | argus-id + pseudonymous **handles** | `node:crypto` `randomInt` (rejection-sampled, unbiased) | ✅ |
| `apps/api/src/messaging/attachments.service.ts:42` | attachment **object key** | `node:crypto` `randomUUID` | ✅ |
| `apps/api` DB primary keys (`schema.ts` `defaultRandom()`, migrations `gen_random_uuid()`) | row IDs incl. tenant/device/key-package/backup IDs | PostgreSQL `pgcrypto` `gen_random_uuid()` | ✅ |

**Findings:** no `Math.random`, no `nanoid`/`uuid` userland generators, no Node `crypto.pseudoRandomBytes`, no `new Date()`/timestamp used as entropy. All key/nonce/salt/IV/ID/token material comes from a CSPRNG (WebCrypto, `@noble`, Node `node:crypto`, or pgcrypto). **Audit result: PASS.**

## 3. Enforcement (the Semgrep rule)

`.semgrep/argus.yml` → **`argus-no-insecure-random`** (severity ERROR), run in CI by `sast-semgrep` (`semgrep scan --config .semgrep --config auto --error --quiet`):

- Bans `Math.random` — matched as a **bare member access**, not `Math.random()`, so aliasing (`const r = Math.random; r()`) is caught too, not just direct calls.
- Bans Node's `crypto.pseudoRandomBytes(...)` / destructured `pseudoRandomBytes(...)` (an insecure PRNG that looks crypto-ish).
- **Total ban — no test/spec exclusion.** Tests must use crypto-grade randomness as well; there are zero current uses to grandfather.

A complementary rule, `argus-crypto-only-in-crypto-package`, keeps cryptographic primitives confined to `packages/crypto`, so new randomness in a security path is steered to the vetted wrapper.

## 4. Invariant check

Upholds invariant **#4 (no hand-rolled crypto / CSPRNG only)**. No tension with the other five. Since the OIDC/PKCE path was decommissioned (#223, passkey-only auth), there is no longer any `crypto.subtle` use in **production** code outside `packages/crypto` (the one remaining `crypto.subtle.generateKey` is a test fixture, `apps/web/src/lib/messaging.spec.ts:156`, which the `argus-crypto-only-in-crypto-package` Semgrep rule excludes by design); the remaining web randomness is CSPRNG-based correlation IDs and reconnect jitter (non-secret), and all key/nonce/IV material lives in `packages/crypto`.

## 5. Decision & mitigations

- Hardened `argus-no-insecure-random` (aliasing + `pseudoRandomBytes`, total ban) and recorded the inventory above. Gate: `sast-semgrep` in CI (`--error` fails the build on any match). Reviewer: `crypto-reviewer` informally confirmed "no `Math.random`" during crypto review #1 (`key-model.md`).

## 6. Residual risk

- **Third-party code** (`ts-mls`, `@noble`, drizzle, pgcrypto) is trusted to use CSPRNGs internally — verified by reputation/audit, not re-derived here; OSV/Trivy track known CVEs.
- **Semgrep can't run locally in this environment**, so the rule's behavior is verified in CI, not pre-commit; the rule is syntactically validated and the repo has zero matches. A `semgrep --test` fixture (under an excluded path) is a possible future enhancement to assert the rule *catches* a violation, not just that the repo is clean.
- The audit is **point-in-time**; the Semgrep rule is what makes it durable. New randomness must route through a CSPRNG or it fails CI.
