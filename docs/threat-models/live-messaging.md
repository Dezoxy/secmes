# Threat model: live messaging (Slice 5)

> One page. Written before code. The last slice of the live message loop: persist MLS group state durably so
> conversations survive a reload, then send (encrypt → POST ciphertext), back-fill history (GET → decrypt),
> and receive live over the WebSocket gateway. Split: **PR-5A group-state persistence** (this note's focus) →
> 5B send + fetch → 5C WebSocket + reconnect/sync. The server half (send/fetch/sync/WS) already exists.

## 1. Feature & data flow

- **Persist (PR-5A):** MLS group state ratchets on every `encrypt`/`decrypt`/`addMember`, so it must be
  saved durably or a reload desyncs the group. The client serializes the ts-mls `GroupState`
  (`encodeGroupState`) and stores it **sealed** (Argon2id + AES-256-GCM, the same passphrase as the device)
  per conversation in IndexedDB. On unlock it rehydrates conversations from the store; once a join's group
  is persisted, **consuming the Welcome + pruning the spent private** (deferred from Slice 4) become safe.
- **Send (5B):** `conversation.encrypt(text)` → opaque wire bytes → `POST /conversations/:id/messages`
  (`{ clientMessageId, ciphertext: base64, alg, epoch }`). Idempotent on `clientMessageId`.
- **Fetch / sync (5B/5C):** `GET …/messages?after=` (keyset) and `GET /sync?after=` → opaque ciphertext the
  client `decrypt`s in order. **Live (5C):** the `/ws` gateway pushes `{ event:'message', … }` frames.

The server only ever sees ids, metadata (`alg`, `epoch`, `clientMessageId`), and **opaque base64
ciphertext** — never plaintext, never keys. All MLS work is client-side.

## 2. Assets & trust boundaries

- **Assets:** the persisted **MLS group state** — it carries `signaturePrivateKey`, `privatePath` HPKE path
  secrets, the `keySchedule`/`secretTree` ratchet secrets — **as sensitive as the device keys**; message
  plaintext (only ever in memory); the WS auth token.
- **Boundaries:** at-rest (the sealed group-state blob ↔ unsealed in-memory state — the passphrase is the
  gate); client↔server (crypto-blind — opaque ciphertext only); WS handshake (token authenticates the
  socket); tenant↔tenant (RLS, server-enforced).

## 3. Threats (STRIDE-lite)

- **Information disclosure (persisted ratchet state):** the group-state blob holds live secret key material,
  so it is **sealed at rest** exactly like the device + pool (Argon2id 64 MiB + AES-256-GCM, identity- and
  signature-key-bound). A leaked at-rest blob (no passphrase) reveals nothing; a wrong passphrase fails the
  GCM auth. Never logged or transmitted. The **save-side** serialized plaintext (a fresh copy from
  `encodeGroupState`) is wiped after sealing; the **load-side** unsealed bytes are deliberately retained —
  `decodeGroupState` returns views over them, so they ARE the live in-memory group state (as resident as the
  device keys), not a transient copy.
- **Rollback / nonce reuse (the headline correctness risk):** persisting a STALE group state behind a
  ratchet advance would break decryption or, worse, let a future `encrypt` reuse an AEAD nonce. The race is
  concrete: if the snapshot is taken in the op mutex but the **seal + DB write run outside it**, two close
  saves can reorder (a slow Argon2 seal lets an older snapshot's write land after a newer one's) and roll the
  stored state back. **Mitigation:** `Conversation.persistVia(persister)` runs the snapshot AND the
  persister's seal + write **inside** the per-conversation op mutex (`opQueue`), so saves are totally ordered
  with ratchet ops and with each other — a later op's state can never be overwritten by an earlier one.
  `keystore.saveConversationState` is built on `persistVia`; a concurrency test fires interleaved
  encrypt+save and asserts the reload is the newest generation (a rollback would replay a consumed generation
  and fail the peer's decrypt). PR-5A lands the codec, the ordered sealed store, and `persistVia`; 5B wires it
  as the in-mutex hook on the ops that ratchet (send/decrypt).
- **Crypto-blind violation:** only opaque ciphertext + ids + metadata cross the wire (send/fetch/sync/WS).
  The server stores ciphertext only (append-only `messages` table, RLS) and never decrypts.
- **WS auth (5C):** the token authenticates the socket in the **first app frame**, never in the URL or a
  query string (so it can't land in a proxy/access log); tenant + membership scoping is server-enforced.
- **Ordering / replay:** dedup by the **server** `message.id` across fetch + WS + sync; `clientMessageId`
  gives send-side idempotency (a retry returns the existing row, no double fan-out).

## 4. Invariant check

- **#1 crypto-blind server:** upheld — ciphertext + metadata only; the server never sees plaintext or keys.
- **#2 no secret logging:** upheld — group state / keys / passphrase / plaintext never logged or sent; the
  sealed blob is the only at-rest form; transient plaintext wiped.
- **#3 RLS:** upheld — the messages/sync/WS paths are tenant- + member-scoped server-side; **no new server
  table** (the messaging schema exists). The new client `group-state` store is local IndexedDB only.
- **#4 no hand-rolled crypto:** upheld — persistence uses ts-mls `encodeGroupState`/`decodeGroupState`; the
  seal reuses `@argus/crypto` `sealBackup`/`openBackup` (Argon2id + AES-GCM); encrypt/decrypt stay in
  `@argus/crypto`. CSPRNG only.
- **#5 secrets via Key Vault / #6 no admin content path:** untouched.

## 5. Decision & mitigations

- **PR-5A (`@argus/crypto` + keystore):** `Conversation.serialize()` (= `encodeGroupState(state)`) +
  `Conversation.persistVia(persister)` (snapshot + persister run in the op mutex, so saves are ordered with
  ratchet ops — see Rollback above) + `MlsEngine.deserializeConversation(bytes)` (`decodeGroupState` →
  re-attach `defaultClientConfig` → `new Conversation`). Keystore: a sealed, identity+signature-bound
  **`group-state`** store (IndexedDB v4, additive) keyed by conversationId, written through `persistVia`;
  wipe transients. Reviewer: **`crypto-reviewer`** (FS of persisted state, the codec, atomicity). Perf note:
  PR-5A seals per explicit save (one-shot Argon2 is fine); 5B's per-message persistence should derive a
  session key once at unlock rather than re-running Argon2 on every message.
- **PR-5B (send + fetch):** `api.ts` `sendMessage`/`fetchMessages`/`fetchSync`; wire the join flow to
  persist → consume → prune; the in-mutex persist hook on `encrypt`/`decrypt`; rehydrate on unlock.
  Reviewer: **`security-boundary-auditor`** (ciphertext-only client, no secret logging).
- **PR-5C (WebSocket):** a reconnecting `ws` client (first-frame auth, never token-in-URL) + subscribe +
  decrypt-on-message + reconnect→`/sync`→dedup. Reviewer: **`security-boundary-auditor`** (WS auth).
- **Tests:** the persistence round-trip — `encrypt → serialize → seal → reload → deserialize → decrypt
  continues` against a real second-device ciphertext; keystore seal/unseal/CAS; (5B) a 2-device end-to-end
  through the real envelope; (5C) the WS handshake + reconnect-dedup.

## 6. Residual risk

- **Decrypt-then-crash re-processing:** `decrypt` advances state + returns plaintext; if the tab dies before
  the seal, a reload re-fetches + re-decrypts the same ciphertext against the older state. For v1 single-epoch
  1:1 this is a benign re-derive; the durable `messages` table is the source of truth and the client tolerates
  re-processing (dedup by `id`). Documented, not eliminated in v1.
- **Group-state migration:** Slice 4 left joined conversations in memory only; the first run after Slice 5
  persists them on next join (the still-pending Welcome re-joins, then persists). No data loss.
- **Group chat / PCS rekey:** v1 is 1:1, single-epoch; multi-member commits + PCS fan-out are deferred (B1).
