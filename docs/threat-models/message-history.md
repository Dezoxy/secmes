# Threat model: persisted message history (local sealed message log)

> One page. Written before code. Slice 5 persists only the MLS **ratchet state**, so a reload shows an empty
> thread — only NEW messages reappear (older ciphertext sits at an already-consumed generation; own sends
> aren't re-derivable at all). This feature adds a local **message log** so conversations survive a reload,
> stored **sealed at rest** under a per-unlock **session key**. Client-local only — no server/API/schema change.

## 1. Feature & data flow

- **Append:** when a message is shown (local echo on send, or decrypted on fetch/WS receive) the client
  appends an entry — `{ serverId, senderId, plaintext, timestamp, status }` — to that conversation's log and
  re-seals it. The log holds **plaintext** (the only place message text lives at rest), so it is sealed with
  **AES-256-GCM** under a **session key** before it touches IndexedDB.
- **Session key:** derived **once at unlock** — `Argon2id(passphrase, perProfileSalt)` → 32 bytes → an
  AES-256-GCM `CryptoKey` held **in memory only** (never persisted). Per-message persistence is then cheap
  AES-GCM (no per-message Argon2). The salt is random per profile, stored in the clear (a salt is not secret).
- **Rehydrate:** on unlock the session key opens each conversation's sealed log → history renders.
- **Server sees nothing new:** the server is untouched — it still only ever stores/forwards opaque ciphertext
  + metadata. This feature never sends plaintext anywhere; it only persists it **locally, encrypted**.

## 2. Assets & trust boundaries

- **Assets:** message **plaintext** (now at rest, sealed); the **session key** (in memory); the device
  **passphrase** (the root of both the device seal and the session key).
- **Boundaries:** **at-rest** (the sealed log blob ↔ the unsealed entries in memory — the passphrase is the
  gate); **client↔server** (unchanged — crypto-blind, opaque ciphertext only); **profile↔profile** on a
  shared browser (the log is identity- + signature-key-bound and sealed under a profile-specific key).

## 3. Threats (STRIDE-lite)

- **Information disclosure (at rest) — the headline:** the log is plaintext message content, so a stolen
  IndexedDB blob is the worst-case leak. **Mitigation:** sealed with AES-256-GCM under the Argon2id-derived
  session key — a blob without the passphrase reveals nothing; a wrong passphrase derives the wrong key and
  GCM auth fails closed. Never logged, never transmitted.
- **Tampering (at rest):** AES-GCM is authenticated — a tampered blob fails to open and is treated as
  "no history for this conversation," never silently mis-decrypted.
- **AEAD nonce reuse (the crypto-correctness risk):** the session key is fixed for the session, so every seal
  MUST use a **fresh CSPRNG 96-bit IV**. The whole per-conversation log is re-sealed on each append with a new
  random IV; `(key, IV)` is never reused. (`Math.random` is banned — `crypto.getRandomValues` only.)
- **Session-key / passphrase exposure:** the session key lives in memory for the session, no more exposed than
  the already-resident device + group-state secret keys; an attacker with JS-heap access already holds those.
  Cleared on lock / account reset.
- **Spoofing / Elevation:** N/A — no new server surface, no authz/RLS change, no admin path; the log is the
  user's own local store, identity-bound so another profile on the same browser can't open it.

## 4. Invariant check

- **#1 crypto-blind server:** upheld — no server/API/schema change; plaintext is still never sent. This only
  persists, **encrypted**, what the client already holds in memory.
- **#2 never persist plaintext / secrets:** the server invariant is upheld (server untouched). Client-side we
  DO persist message plaintext — but **sealed at rest** (AES-256-GCM under a passphrase-derived key), exactly
  like the existing sealed device + `group-state` stores. The session key + plaintext are never logged. This
  is the deliberate, reviewed tension below; the encrypted-at-rest form is the mitigation.
- **#3 RLS:** N/A — no server table; local IndexedDB only.
- **#4 no hand-rolled crypto:** upheld — Argon2id (existing `@argus/crypto` KDF) + WebCrypto AES-256-GCM,
  added to `@argus/crypto` (primitives stay in the crypto package). CSPRNG IVs only.
- **#5 secrets via Key Vault / #6 no admin content path:** N/A / untouched.

## 5. Decision & mitigations

- **`@argus/crypto`:** session-key helpers next to `sealBackup`/`openBackup` — `deriveSessionKey(passphrase,
  salt, params) → CryptoKey` (Argon2id + `crypto.subtle.importKey`), `sealWithKey(key, bytes, context?) →
  {iv, ct}` and `openWithKey(key, {iv, ct}, context?)` (AES-256-GCM, fresh CSPRNG IV per seal). The optional
  `context` binds a blob to its slot (the keystore passes the conversationId) so it can't be relocated. No
  primitives leak outside the package. The keystore stores the Argon2 **params alongside the salt** (like
  `SealedBackup` self-describes) so a future `DEFAULT_ARGON2` bump re-derives the same key instead of silently
  dropping history.
- **Keystore (IndexedDB v5, additive):** a `message-log` store keyed by conversationId, identity- +
  signature-key-bound, value = the sealed `{iv, ct}` over the entries; a stored per-profile session-key salt.
  Methods: `appendMessages` / `loadMessageLog` / cleared by `clearDevice`. Re-seal the whole per-conversation
  log on append (small for v1 1:1), under a **monotonic version + readwrite-tx CAS** so concurrent cross-tab
  appends don't clobber: a lost CAS means another tab appended — re-read its newer log, re-merge our entries,
  retry (so neither tab's plaintext history is dropped; the in-memory serializer only orders within a tab).
- **DeviceContext:** derive + hold the session key at unlock; clear on reset. **ChatScreen:** seed history
  from `loadMessageLog` on rehydrate; append on send / fetch-backfill / WS receive (dedup by serverId).
- **Tests:** round-trip (append → reload → decrypt renders history); wrong passphrase fails closed; two seals
  of the same data differ (fresh IV); identity-binding skip; clear-on-reset.
- **Reviewer:** **`crypto-reviewer`** (session-key derivation, IV uniqueness, key lifetime/wipe, no
  hand-rolled crypto, fail-closed).

## 6. Residual risk

- **Plaintext history at rest (sealed) vs. MLS forward secrecy:** retaining decrypted history indefinitely is
  inherently at odds with the ratchet's forward secrecy — but it's a deliberate product choice (usable history
  in an E2EE app, as Signal's local DB does). Gated by the passphrase; a leaked blob without it is useless. A
  future retention / disappearing-messages policy can prune the log. Documented, accepted for v1.
- **Whole-log re-seal on append is O(n):** fine for v1 1:1; append-only encrypted segments are the scale
  follow-up.
- **Second Argon2 at unlock** (device unseal + session-key derive) adds ~one KDF pass to unlock latency —
  acceptable; deriving the session key from a distinct salt keeps domain separation.
- **Group-state seal still uses per-save Argon2** (the 5B perf residual): migrating it onto this session key is
  a clean follow-up, out of scope here to avoid re-touching the just-merged 5A/5B store.
