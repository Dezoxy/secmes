# Phase 2 — Device keys & recovery (crypto foundation)

> Part of the [build roadmap](README.md). Legend: `[ ]` todo · `[~]` in progress · `[x]` done · 🔒 security-gated.

**Progress:** 9/9 done.

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
