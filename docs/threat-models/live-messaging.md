# Threat model: live messaging (Slice 5)

> One page. Written before code. The last slice of the live message loop: persist MLS group state durably so
> conversations survive a reload, then send (encrypt → POST ciphertext), back-fill history (GET → decrypt),
> and receive live over the WebSocket gateway. Split: **PR-5A group-state persistence** (this note's focus) →
> 5B send + fetch → 5C WebSocket + reconnect/sync. The server half (send/fetch/sync/WS) already exists.

## 1. Feature & data flow

- **Persist (PR-5A):** MLS group state ratchets on every `encrypt`/`decrypt`/`addMember`, so it must be
  saved durably or a reload desyncs the group. The client serializes the ts-mls `GroupState`
  (`encodeGroupState`) and stores it **sealed** (AES-256-GCM under the per-passkey PRF unlock key — the same
  key that seals the device) per conversation in IndexedDB. On unlock it rehydrates conversations from the store; once a join's group
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
- **Boundaries:** at-rest (the sealed group-state blob ↔ unsealed in-memory state — the PRF unlock key is the
  gate); client↔server (crypto-blind — opaque ciphertext only); WS handshake (token authenticates the
  socket); tenant↔tenant (RLS, server-enforced).

## 3. Threats (STRIDE-lite)

- **Information disclosure (persisted ratchet state):** the group-state blob holds live secret key material,
  so it is **sealed at rest** exactly like the device + pool (AES-256-GCM under the PRF unlock key, identity-
  and signature-key-bound). A leaked at-rest blob (without the in-memory unlock key) reveals nothing; a wrong
  unlock key fails the GCM auth. Never logged or transmitted. The **save-side** serialized plaintext (a fresh copy from
  `encodeGroupState`) is wiped after sealing; the **load-side** unsealed bytes are deliberately retained —
  `decodeGroupState` returns views over them, so they ARE the live in-memory group state (as resident as the
  device keys), not a transient copy.
- **Rollback / nonce reuse (the headline correctness risk):** persisting a STALE group state behind a
  ratchet advance would break decryption or, worse, let a future `encrypt` reuse an AEAD nonce. Two distinct
  races, two guards:
  - **Same instance** (snapshot in the op mutex but seal + write outside it → two close saves reorder when the
    async seal lets an older write land last): `Conversation.persistVia(persister)` runs the snapshot
    AND the persister's seal + write **inside** the per-conversation op mutex (`opQueue`), so saves are
    totally ordered with ratchet ops and with each other. A concurrency test fires interleaved encrypt+save
    and asserts the reload is the newest generation.
  - **Across instances** (two tabs / a double-unlock each rehydrate their OWN `Conversation` with an
    independent `opQueue`, so the mutex can't order them): the `group-state` store carries a monotonic
    `version`; `saveConversationState` commits only via a single readwrite-tx **compare-and-swap** (the seal
    runs before the tx; IndexedDB serializes the tx against the other tab's), so a stale instance's write is
    rejected with `GroupStateConflict` rather than rolling the durable ratchet back. A cross-instance test
    proves the stale save is refused and the persisted state stays the newest. **Bound:** CAS keeps the
    *durable* state monotonic; it does NOT stop two tabs *sending* concurrently (each advances its own
    in-memory ratchet and could emit the same generation). Eliminating that needs **single-writer send
    coordination** (a `navigator.locks` writer lock gating `encrypt`), which lands with the send path (5B)
    — `GroupStateConflict` is the typed signal a follower uses to stop sending + rehydrate. Until then v1 is
    single-active-tab; concurrent multi-tab sending is the documented residual below.
  PR-5A lands the codec, the ordered + CAS-guarded sealed store, and `persistVia`; 5B wires the persist as the
  in-mutex hook on the ops that ratchet (send/decrypt) and adds the writer lock.
- **Crypto-blind violation:** only opaque ciphertext + ids + metadata cross the wire (send/fetch/sync/WS).
  The server stores ciphertext only (append-only `messages` table, RLS) and never decrypts.
- **WS auth (5C):** the token authenticates the socket in the **first app frame**, never in the URL or a
  query string (so it can't land in a proxy/access log); tenant + membership scoping is server-enforced.
- **Ordering / replay:** dedup by the **server** `message.id` across fetch + WS + sync; `clientMessageId`
  gives send-side idempotency (a retry returns the existing row, no double fan-out).

## 4. Invariant check

- **#1 crypto-blind server:** upheld — ciphertext + metadata only; the server never sees plaintext or keys.
- **#2 no secret logging:** upheld — group state / keys / unlock key / plaintext never logged or sent; the
  sealed blob is the only at-rest form; transient plaintext wiped.
- **#3 RLS:** upheld — the messages/sync/WS paths are tenant- + member-scoped server-side; **no new server
  table** (the messaging schema exists). The new client `group-state` store is local IndexedDB only.
- **#4 no hand-rolled crypto:** upheld — persistence uses ts-mls `encodeGroupState`/`decodeGroupState`; the
  seal reuses `@argus/crypto` `sealWithKey`/`openWithKey` (AES-256-GCM under the PRF unlock key); encrypt/decrypt
  stay in `@argus/crypto`. CSPRNG only.
- **#5 secrets via Key Vault / #6 no admin content path:** untouched.

## 5. Decision & mitigations

- **PR-5A (`@argus/crypto` + keystore):** `Conversation.serialize()` (= `encodeGroupState(state)`) +
  `Conversation.persistVia(persister)` (snapshot + persister run in the op mutex, so saves are ordered with
  ratchet ops — see Rollback above) + `MlsEngine.deserializeConversation(bytes)` (`decodeGroupState` →
  re-attach `defaultClientConfig` → `new Conversation`). Keystore: a sealed, identity+signature-bound
  **`group-state`** store (IndexedDB v4, additive) keyed by conversationId, written through `persistVia`;
  wipe transients. Reviewer: **`crypto-reviewer`** (FS of persisted state, the codec, atomicity). Perf note:
  every save is cheap AES-GCM under the in-memory PRF unlock key — there is no per-save or per-message KDF.
- **PR-5B (send + fetch) — DONE:** `api.ts` `sendMessage`/`fetchMessages` (typed, ciphertext + metadata
  only); cross-conversation `/sync` lands in 5C with its reconnect caller. `lib/messaging.ts`:
  `sendLiveMessage` does **encrypt → persist → POST** and
  `backfillConversation` does **fetch → decrypt (peer only) → persist**, both under a per-conversation
  **single-writer lock** (`lib/locks.ts`, Web Locks with an in-process fallback) — this is the lock promised
  in PR-5A's rollback note, gating the ratchet ops across tabs. The join flow now **persists → consumes →
  prunes** (closing the Slice-4 deferral). `DeviceContext` retains the in-memory PRF unlock key to seal
  advances and rehydrates conversations on unlock (`loadConversations`); `ChatScreen` routes live sends/opens
  through these and drops the demo loopback for live conversations. Reviewer: **`security-boundary-auditor`**
  (ciphertext-only client, no secret logging). Perf: each save is cheap AES-GCM under the in-memory PRF unlock
  key — no per-action KDF.
- **PR-5C (WebSocket) — DONE:** `lib/ws.ts` `createMessageSocket` — a reconnecting client that authenticates
  in the **first app frame** (`{event:'auth',data:{token}}`, never a token in the URL/query), subscribes each
  live conversation, and surfaces pushed envelopes. `lib/messaging.ts` `receiveLiveMessage` decrypts +
  persists one push under the conversation lock (skips self/undecryptable). On every (re)connect the socket
  re-auths + re-subscribes; the per-conversation **catch-up back-fill** then runs on each `subscribed` ACK —
  i.e. only after the gateway has actually joined the socket to the room, so no message can slip between the
  catch-up's fetch and the live subscription (it reuses 5B's `backfillConversation` from each keyset cursor —
  no `/sync` needed). Dedup across push + fetch is by the server message id. Exponential reconnect backoff.
  `ChatScreen` owns one socket; `addLive` subscribes new conversations. Dev: a Vite `/ws` proxy. Reviewer:
  **`security-boundary-auditor`** (WS auth, token-not-in-URL, no secret logging).
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
- **No persisted plaintext history:** 5B persists the sealed *ratchet state*, never message **plaintext**.
  So after a reload a conversation opens empty and back-fill shows only messages NEWER than the rehydrated
  ratchet — older ciphertext is at an already-consumed generation and is skipped (undecryptable). Own sent
  messages are never re-derivable from MLS state at all (the sending secret is consumed on `encrypt`), so
  back-fill skips self; they appear via local echo only for the session that sent them. A local **sealed
  message log** (plaintext at rest under the PRF unlock key) now makes history durable — shipped in Slice 5
  (see `message-history.md`).
- **Reconnect catch-up cost (5C):** live messages now arrive over the WebSocket push; on (re)connect the
  client catches up with a **per-conversation** back-fill (one keyset fetch per live conversation). A device
  in many conversations makes N calls; the server's cross-conversation `GET /sync` (single paginated stream)
  is the future optimization, deferred until N is large enough to matter. Attachments are still not
  transmitted on live conversations (only the text body is encrypted + sent); blob storage is a later feature.
- **Multi-tab concurrent send:** the per-conversation single-writer lock (5B) serializes ratchet ops across
  tabs, and the version/CAS keeps the *durable* state monotonic (a stale write is refused, never a rollback).
  What remains is the in-memory window where two tabs each `encrypt` from the same loaded state before either
  takes the lock+persists (each reloads its in-memory group only on its next op, not on the other tab's
  write) — an in-memory generation reuse the lock alone can't close. The complete fix is true leader election
  (one tab owns the group; followers go read-only on `GroupStateConflict` and rehydrate). For v1 we treat the
  app as single-active-tab; documented, not fully eliminated.
- **Group chat / PCS rekey:** v1 is 1:1, single-epoch; multi-member commits + PCS fan-out are deferred (B1).
