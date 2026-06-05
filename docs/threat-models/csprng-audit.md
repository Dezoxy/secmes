# Threat model: CSPRNG audit (randomness sources)

> Status: **DRAFT for ratification.** Roadmap **checkpoint 24 ("CSPRNG audit — no `Math.random` in security paths; Semgrep rule green")**. A point-in-time enumeration of every randomness source in the codebase, confirming each is a CSPRNG, plus the lint rule that keeps it that way.

## 1. Why this matters

In an E2EE system, predictable randomness is a full break: a guessable key, nonce, salt, IV, or token defeats the cryptography regardless of the algorithm. `Math.random()` is a non-cryptographic PRNG (seedable, predictable) and must never touch a security path. This audit proves no security-relevant value derives from a weak source, and pins a Semgrep rule so a regression fails CI.

## 2. Randomness inventory (audited)

Every randomness source in `apps/` + `packages/` (excluding `node_modules`, build output, and the throwaway spike), and its mechanism:

| Where | Use | Source | CSPRNG? |
|---|---|---|---|
| `packages/crypto/src/key-backup.ts:109–110` | backup **salt** (16 B) + **IV** (12 B) | `crypto.getRandomValues` (WebCrypto) | ✅ |
| `packages/crypto` (via `ts-mls`) | MLS signature/HPKE key generation, KeyPackages | `@noble/*` → WebCrypto | ✅ |
| `apps/web/src/lib/auth.ts:20` | PKCE code **verifier** (32 B) | `crypto.getRandomValues` | ✅ |
| `apps/web/src/lib/auth.ts:37` | OAuth **state** | `crypto.randomUUID()` (WebCrypto) | ✅ |
| `apps/api` DB primary keys (`schema.ts` `defaultRandom()`, migrations `gen_random_uuid()`) | row IDs incl. tenant/device/key-package/backup IDs | PostgreSQL `pgcrypto` `gen_random_uuid()` | ✅ |

**Findings:** no `Math.random`, no `nanoid`/`uuid` userland generators, no Node `crypto.pseudoRandomBytes`, no `new Date()`/timestamp used as entropy. All key/nonce/salt/IV/ID/token material comes from a CSPRNG (WebCrypto, `@noble`, or pgcrypto). **Audit result: PASS.**

## 3. Enforcement (the Semgrep rule)

`.semgrep/secmes.yml` → **`secmes-no-insecure-random`** (severity ERROR), run in CI by `sast-semgrep` (`semgrep scan --config .semgrep --config auto --error --quiet`):

- Bans `Math.random` — matched as a **bare member access**, not `Math.random()`, so aliasing (`const r = Math.random; r()`) is caught too, not just direct calls.
- Bans Node's `crypto.pseudoRandomBytes(...)` / destructured `pseudoRandomBytes(...)` (an insecure PRNG that looks crypto-ish).
- **Total ban — no test/spec exclusion.** Tests must use crypto-grade randomness as well; there are zero current uses to grandfather.

A complementary rule, `secmes-crypto-only-in-crypto-package`, keeps cryptographic primitives confined to `packages/crypto`, so new randomness in a security path is steered to the vetted wrapper.

## 4. Invariant check

Upholds invariant **#4 (no hand-rolled crypto / CSPRNG only)**. No tension with the other five. The one `crypto.subtle` use outside `packages/crypto` (`apps/web/src/lib/auth.ts`, PKCE S256) is OAuth transport plumbing, not E2EE protocol crypto, and is CSPRNG-based — acceptable and annotated.

## 5. Decision & mitigations

- Hardened `secmes-no-insecure-random` (aliasing + `pseudoRandomBytes`, total ban) and recorded the inventory above. Gate: `sast-semgrep` in CI (`--error` fails the build on any match). Reviewer: `crypto-reviewer` informally confirmed "no `Math.random`" during crypto review #1 (`key-model.md`).

## 6. Residual risk

- **Third-party code** (`ts-mls`, `@noble`, drizzle, pgcrypto) is trusted to use CSPRNGs internally — verified by reputation/audit, not re-derived here; OSV/Trivy track known CVEs.
- **Semgrep can't run locally in this environment**, so the rule's behavior is verified in CI, not pre-commit; the rule is syntactically validated and the repo has zero matches. A `semgrep --test` fixture (under an excluded path) is a possible future enhancement to assert the rule *catches* a violation, not just that the repo is clean.
- The audit is **point-in-time**; the Semgrep rule is what makes it durable. New randomness must route through a CSPRNG or it fails CI.
