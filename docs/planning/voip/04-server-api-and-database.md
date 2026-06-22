# 04 — Server API & Database

> Part of the argus VoIP plan. Siblings: [00 — Overview & Goals](./00-overview-and-goals.md) · [01 — Architecture & E2EE Crypto Model](./01-architecture-and-crypto-model.md) · [02 — Signaling Protocol & Call State Machine](./02-signaling-protocol-and-state-machine.md) · [03 — Infrastructure: TURN/coturn & Networking](./03-infrastructure-turn-and-networking.md) · [05 — Frontend, PWA & WebRTC Client](./05-frontend-pwa-and-webrtc.md) · [06 — Threat Model & Privacy](./06-threat-model-and-privacy.md) · [08 — Roadmap & Delivery Slices](./08-roadmap-and-delivery-slices.md) · [09 — Decision Log & Open Questions](./09-decision-log-and-open-questions.md)

This file specifies the **server-side surface** for 1:1 calling: the new REST endpoints, the WebSocket signaling additions, the relay-only preference, authorization (friends-gated, no IDOR, presence-oracle handling), and abuse controls. It is concrete enough that each section maps to a PR-sized slice.

The governing principle throughout: **the server learns who-called-whom-and-when, never what was said or any media key.** Media is E2EE browser-to-browser via DTLS-SRTP; coturn relays opaque SRTP (see [01](./01-architecture-and-crypto-model.md) and [03](./03-infrastructure-turn-and-networking.md)). Everything below carries IDs and metadata only — invariants 1, 2, and 6.

---

## 0. V1 scope cut — read this first

The consilium re-cut V1 to an **audio-first core** (see [00 §4](./00-overview-and-goals.md) for the full rationale and [08](./08-roadmap-and-delivery-slices.md) for the slice graph). For *this* file the cut is load-bearing, so it is stated up front and enforced section by section:

| Capability | V1 (this file's core) | V1.1 (explicitly deferred) |
|---|---|---|
| Media | **Audio only** | Video |
| Transport | **Relay-only** (forced TURN) | Direct-P2P opt-in default before video |
| Receivability | **Foreground ring only** — both apps open | Push-wake banner / tap-to-join banner; missed-call ledger |
| Devices | **Single device per user** | Multi-device ring-all + "answered-elsewhere" fan-out |
| Reconnection | **None** — a dropped call is a failed call | ICE-restart / reconnection |
| **Persistence** | **NONE.** No `call_sessions` table, no `argus_call_prune` role, no prune worker | The metadata ledger + prune chain (this whole apparatus) lands in V1.1 |

The single most important consequence: **V1 ships zero new tables and zero new DB roles.** A V1 call is a wholly *ephemeral* event — a REST `invite` that creates no row, a burst of WS signaling frames the gateway forwards crypto-blind and never persists, and a terminal frame. Nothing about a V1 call survives a process restart, and nothing about it is ever written to Postgres.

Why the ledger waits for V1.1: a metadata-only call ledger is only *useful* once there is something it powers — the **missed-call list** — and a missed-call list is only meaningful once the callee can be rung while backgrounded (push-wake). Both of those are V1.1. Building the table, the dedicated prune role, the window-scoped RLS, and the systemd reaper in V1 would be persistence with no consumer: pure speculative surface, exactly the over-engineering the engineering contract forbids. So §4 and §5 below specify the ledger as a **V1.1 design**, fully worked out, but **not built in the audio core**.

Sections [§1](#1-design-posture-what-is-rest-what-is-ws-what-is-ephemeral)–[§3](#3-websocket-gateway-additions-signaling--presence), [§6](#6-relay-only-preference-default-on)–[§8](#8-rate-limiting--call-spam-abuse-controls) are V1. Sections [§4](#4-v11--call_sessions-table-metadata-only-ledger)–[§5](#5-v11--retention--ttl-alignment) are V1.1. [§9](#9-required-artifacts--dod-checklist)–[§10](#10-pr-sized-slice-map) cover both, labelled.

---

## 1. Design posture: what is REST, what is WS, what is ephemeral

| Concern | Channel | Persisted? | Phase | Why |
|---|---|---|---|---|
| TURN credentials | REST `POST /calls/turn-credentials` | No (stateless HMAC) | V1 | Short-lived, derived on demand; nothing to store |
| Call invite / ring | REST `POST /calls/:friendUserId/invite` → WS `CallRingEvent` | No (in-memory ring state only) | V1 | Real-time, ephemeral; a dropped ring just fails the call |
| Offer/Answer/ICE (SDP) | WS `call.signal` (single opaque frame; phase encrypted inside) | **Never** | V1 | SDP/ICE are metadata-revealing; relay only, never on disk |
| Hangup / decline / busy | WS `call.signal` (encrypted inner type) | No | V1 | Transient control |
| Relay-only preference | DB column on `users` | Yes | V1 | A durable per-user setting (the one durable thing V1 adds) |
| Call ledger (start/answer/end, reason) | DB `call_sessions` | **Yes**, metadata only | **V1.1** | Missed-call list + abuse forensics; no content, no keys |

The split mirrors what already exists in the repo: messages are durable-then-notify; commits/welcomes are push-pings whose bytes are fetched separately. **Call signaling is the first genuinely transient WS payload** — it is emitted straight onto the realtime bus from the inbound handler, never written to the DB. That is a deliberate departure from the message path and is documented in the threat-model note (§9).

The one durable thing V1 touches is a single boolean preference column on `users` (§6) — it reuses the existing `users` table's RLS and grants, so it is **not** a "new table" and does not trigger the new-table RLS procedure.

---

## 2. REST endpoints

All routes live in a new Nest module `apps/api/src/calls/` (`calls.module.ts`, `calls.controller.ts`, `calls.service.ts`), wired like `apps/api/src/friends/`. Every route is **guarded** (the platform's default auth guard — same posture as the messaging and friends controllers), validated with Zod at the boundary, documented in `apps/api/openapi.json`, and pinned by a controller spec (two-tier rule below).

### 2.1 Endpoint table (V1 set)

| Method & path | Auth | Request (Zod) | Response | Status contract | Purpose |
|---|---|---|---|---|---|
| `POST /calls/turn-credentials` | Guarded | `TurnCredentialsRequest` `{ }` (empty) | `TurnCredentialsResponse` | `200` ok; `401` no auth; `403` requester has no accepted friend (coarse Q7 floor); `429` throttled | Mint ephemeral relay-only TURN creds for a requester with **≥1 accepted friend** — coarse-gated, **not** call-scoped (bounded by TTL + per-user quota; see §2.2) |
| `POST /calls/:friendUserId/invite` | Guarded | `CreateCallRequest` | `CreateCallResponse` `{ callId }` | `202` accepted (uniform); `401`; `429` | Mint a transient `callId` + emit ring; uniform 202 = no presence oracle. **No DB write in V1.** |
| `GET /calls/settings` | Guarded | — | `CallSettingsResponse` `{ relayOnly }` | `200`; `401` | Read relay-only preference |
| `PUT /calls/settings` | Guarded | `UpdateCallSettingsRequest` `{ relayOnly }` | `CallSettingsResponse` | `200`; `401` | Update relay-only preference |

> **Uniform 202 vs. server-issued `callId` — no oracle.** `invite` **always** returns `202` with a syntactically-valid `callId`, regardless of whether the friendship gate passed or the callee is reachable. Only a **gate-passing** invite registers that `callId` as **active** in the in-memory call-authorization map (§3.2a) and emits `CallRingEvent`; a no-op invite returns a fresh **inactive** `callId` (never registered, never rung). The body is thus byte-indistinguishable (no friendship/presence oracle — §7) and the fake id is inert, because the WS handlers (§3.2) **silently drop** any `callId` absent from the live call-authorization map (§3.2a) — and, crucially, `turn-credentials` is **not** call-scoped (§2.2), so it cannot be used to probe whether a `callId` is real either. Implementers must mint the active id **only after** the gate, and must never withhold or reshape the field on failure. Retries are **indistinguishable** too: every invite — active or no-op, first or repeated — returns a **fresh** `callId`; a live ring is deduped server-side and **never re-exposed** as a stable id, so a caller cannot send two invites and compare the responses to detect a real ring (§8).

> **Deferred to V1.1:** `POST /calls/:callId/end` (ledger finalize) and `GET /calls/missed` (missed-call list). Both depend on the `call_sessions` table, which is V1.1 (§4). In the V1 audio core, a call **ends** purely over WS (a terminal signal inside `call.signal`, §3.2) with no server-side finalize step, because there is no row to finalize.

> **Why a REST `invite` at all, given WS does signaling?** Two reasons that hold even without a ledger. (1) The invite must be **server-trusted**: the tenant, the two parties, and the **friendship check** (§7) belong on an authenticated REST handler, not in the WS inbound path. (2) It mints a stable `callId` (a server-generated UUID) that the subsequent WS `call.signal` frames reference, so the gateway can correlate signaling frames to one logical call. In V1 the `callId` lives only in the gateway's in-memory call-authorization map (§3.2a); in V1.1 it becomes the `call_sessions` primary key. The SDP itself never touches REST — only the WS relay carries it.

### 2.2 `POST /calls/turn-credentials` — ephemeral TURN creds

The single most important endpoint. It returns **time-limited, HMAC-derived** TURN credentials following the long-standing TURN REST API convention that coturn implements via `use-auth-secret` / `static-auth-secret` ([TURN REST API draft, Uberti](https://www.ietf.org/proceedings/87/slides/slides-87-behave-10.pdf); [coturn turnserver wiki](https://github.com/coturn/coturn/wiki/turnserver)):

- **username** = `"<expiry-unix>:<userId>"`. The `userId` is the OIDC `sub` — already known to the server, not secret. Expiry is `now + TTL`.
- **credential** = `base64( HMAC-SHA1( username, static-auth-secret ) )`.
- **TTL**: short. **Default 600 s (10 min)** — the confirmed Q6 ruling ([09](./09-decision-log-and-open-questions.md)). Long enough to set up and ride a call, short enough that a leaked credential is near-useless. The client re-fetches per call attempt; it must not cache across calls.

The shared `static-auth-secret` is delivered to **both** the API container and the coturn container as a Key Vault credential **file** (invariant 5) — see [03 §secrets](./03-infrastructure-turn-and-networking.md). The API reads it via `*_FILE` env, exactly like `SESSION_SIGNING_KEY_FILE`. It is **never logged** (invariant 2 — the derived `credential` is a secret-equivalent; logs carry only a request id).

**Issuance is gated on a coarse friendship floor — but NOT call-scoped (per D6 / Q7-A in [09](./09-decision-log-and-open-questions.md)).** The endpoint takes no `callId` and never references the callee: a requester must have **≥1 accepted friend** to mint creds — the cheapest bandwidth-abuse choke (a friendless spammer gets nothing, per D6). Crucially this floor is **requester-only and per-pair-blind**: it reflects only the caller's own friend-count (self-knowledge), never whether they are friends with a specific callee or whether a given call is real — so it is **not** the presence/friendship oracle that per-`callId` scoping would create (a `callId`-bound `200`-vs-`403` would let a caller probe a uniform-202 invite id). Beyond the floor, relay abuse is bounded the standard WebRTC-TURN way: **short TTL (600 s)** + the **per-user HTTP throttle** + **per-user coturn quotas** (session/bandwidth caps in `turnserver.conf` — see [03](./03-infrastructure-turn-and-networking.md)); a *specific-pair* friendship is re-checked at `invite` (Q7-A defense-in-depth). The credential is a generic time-limited coturn secret; coturn never learns any `callId`.

**Relay-only enforcement happens here.** In the V1 audio core relay-only is unconditional — the locked IP-privacy default is the *only* mode V1 ships (direct-P2P opt-in is V1.1, before video). The response's `iceServers` and an explicit `iceTransportPolicy` hint reflect that:

```ts
// packages/contracts/src/index.ts  (shared) + apps/api server-local mirror
export const TurnCredentialsRequestSchema = z.object({}).strict();

export const IceServerSchema = z.object({
  urls: z.array(z.string().min(1)).min(1),     // e.g. ["turns:turn.4rgus.com:5349?transport=tcp"]
  username: z.string().min(1).optional(),       // "<expiry>:<sub>"  — present for TURN, absent for STUN
  credential: z.string().min(1).optional(),     // base64 HMAC-SHA1; SECRET-equivalent, never logged
});

export const TurnCredentialsResponseSchema = z.object({
  iceServers: z.array(IceServerSchema).min(1),
  iceTransportPolicy: z.enum(['relay', 'all']),  // 'relay' in V1 → forces TURN, hides peer IP
  ttlSeconds: z.number().int().positive(),       // mirrors the credential expiry; client re-fetches before it lapses
});
```

When `relayOnly` is true (V1: always; V1.1: per the user's preference — §6), the server:
1. sets `iceTransportPolicy: 'relay'`, and
2. omits any `stun:` server from `iceServers` (a STUN server would let the client gather `srflx` host-reflexive candidates and leak its public IP into the SDP).

This is belt-and-suspenders: the client also sets `RTCConfiguration.iceTransportPolicy = 'relay'`, but the server refusing to hand out STUN means even a tampered client can't gather a non-relay candidate that the *honest* peer would accept — and because both peers are relay-only in V1, neither offers a routable host candidate to the other. RFC 8827 explicitly frames this trade: a callee "can avoid revealing their location and even presence status" at the cost of forcing TURN and delaying ICE ([RFC 8827 §4.4](https://www.rfc-editor.org/rfc/rfc8827)).

> **OpenAPI**: annotate with the guarded security scheme, the empty request body, and the response schema above. Mark `credential` with a description noting it is sensitive and must not be cached/logged. Run the 42Crunch audit (target 90+) per the DoD — this endpoint returns secret-equivalent material, so 42Crunch's "no sensitive data in examples" rules apply; keep examples synthetic.

### 2.3 `POST /calls/:friendUserId/invite` — mint callId + ring

```ts
export const CreateCallRequestSchema = z.object({
  conversationId: z.string().uuid(),             // the existing 1:1 MLS group for these two
  media: z.literal('audio'),                     // V1 audio-only; widens to z.enum(['audio','video']) in V1.1
}).strict();

export const CreateCallResponseSchema = z.object({
  callId: z.string().uuid(),
}).strict();
```

Handler logic (in `CallsService`, under `withTenant` / RLS for the friendship lookup):
1. Resolve the **server-verified** caller `sub` from the guard — never from the body.
2. **Authenticated-sender prerequisite (hard Phase-0 gate).** Before any call can *connect*, the callee must be able to verify *who* sent the ring — this is the MITM defense for the call signal. That is **not** a free reuse of existing MLS: `packages/crypto`'s `decrypt()` today returns a bare string and surfaces **no sender identity**. A **new, crypto-reviewer-gated authenticated-sender decrypt path** must land in `packages/crypto` first ([01](./01-architecture-and-crypto-model.md), [06](./06-threat-model-and-privacy.md)). The `invite` handler stamps the ring with the caller's authenticated identity material so the callee's client can bind the ringing party to the conversation's MLS membership. This is a **hard Phase-0 predecessor of the first connecting call** — it is not new primitives, but it *is* a new code path through the crypto package and must pass `crypto-reviewer`.
3. **Authorization gate (§7)**: assert an *accepted* friendship exists between caller and `:friendUserId` (reuse `FriendsService.canonicalPair` + an `accepted`-only lookup). Also assert the caller is a member of `conversationId` (reuse `MessagingService.isMember`). Either failing → **uniform `202`** with no body distinction (see oracle handling, §7).
4. Mint a `callId` (UUID) and record the transient ring in the gateway's **in-memory** ring map (V1) keyed by `callId` → `{ tenant, caller-sub, callee-sub, conversationId, armed-at }`, with a fixed ring-timeout timer. **No DB write in V1.**
5. Emit a `CallRingEvent` onto the realtime bus targeted at the callee's `(tenant, sub)` (identity-based routing, §5/§3). In V1 this produces a **real foreground ring** only if a callee socket is connected; there is **no push-wake** (that, with the wake-banner / tap-to-join-banner distinction, is V1.1 — see [05](./05-frontend-pwa-and-webrtc.md)).
6. Return `{ callId }` with **`202 Accepted`** regardless of whether the callee is online, exists-as-a-friend, or is busy. The 202 is a *uniform* "your intent was accepted," not a delivery confirmation — same anti-enumeration posture as the friends `send-request` 202.

### 2.4 Controller-spec note (two-tier rule)

Per the DoD, each new/changed controller gets a spec with **both** tiers, using `apps/api/src/common/testing/route-meta.ts` (services faked, no DB):

- **Tier 1 — contract (`reflectRouteMeta`)**: assert every route is **guarded** (not `@Public`), and pin the status contract: `turn-credentials`→200, `invite`→202, `settings`→200. (V1.1 adds `end`→204, `missed`→200.)
- **Tier 2 — behaviour (direct instantiation, faked `CallsService`/`FriendsService`)**:
  - `turn-credentials`: takes no `callId` (coarse ≥1-accepted-friend gate, **not** call-scoped — §2.2); a requester with no accepted friend gets `403`; never returns a `stun:` server; `iceTransportPolicy==='relay'`; the `credential` field is present and the handler does **not** pass it to any logger (assert via a spy on the logger).
  - `invite`: returns **202 with an identical body** whether the friendship is accepted, absent, or the callee is offline (no oracle); never throws a 403/404 that distinguishes those cases; performs **no DB write** in V1 (assert no repository/insert call on the faked service).
  - `settings`: `PUT` round-trips `relayOnly`; `GET` reflects the stored value.

---

## 3. WebSocket gateway additions (signaling + presence)

All in `apps/api/src/realtime/`, following the insertion points already mapped in grounding.

### 3.1 New bus events (`realtime-bus.ts` + both implementations)

Add interfaces + Zod schemas alongside `MessageCreatedEvent`:

| Event | Direction | Payload (metadata/opaque only) | Routing |
|---|---|---|---|
| `CallRingEvent` | server→callee | `{ callId, conversationId, callerUserId, media }` | identity `(tenant, callee-sub)` → callee's (single, V1) device |
| `CallSignalEvent` | peer↔peer relay | `{ callId, conversationId, envelope: string /* opaque MLS ciphertext — the offer/answer/ice discriminant lives INSIDE it; the gateway never sees the call phase */ }` | conversation room `roomKey(tenant, conversationId)` |
| `CallEndEvent` | **server→client only** | `{ callId, conversationId, reason }` — `reason` limited to **server-known** lifecycle (`timeout`, `peer-gone`; V1.1: `answered-elsewhere`). Client-initiated decline/busy/cancel/hangup do **not** use this — they ride encrypted inside `call.signal`. | identity / conversation room |

`CallSignalEvent.envelope` is a `z.string()` the gateway forwards verbatim — same crypto-blind treatment as `message.ciphertext`. The `offer`/`answer`/`ice` discriminant is encrypted **inside** that envelope (per [02 §2](./02-signaling-protocol-and-state-machine.md)), so neither the gateway nor the Redis backplane learns the call phase — they observe only that *a* signal was relayed (coarse timing/volume), never whether it was setup or ICE. SDP/ICE is **not** persisted and **not** parsed server-side. For `RedisRealtimeBus`, add a `CALL_CHANNEL` constant beside `CHANNEL`/`COMMIT_CHANNEL` and a `safeParse` branch in `onPayload`; fire-and-forget publish (`enableOfflineQueue:false`) like the others — if Redis is down the signal drops and the call simply fails to connect, which is the correct fail-closed mode (see the failure-modes treatment in [06 §11](./06-threat-model-and-privacy.md)).

### 3.2 Inbound frames (the genuinely new shape)

Today the gateway only accepts inbound `auth` and `subscribe`. Calling needs **client→server→peer relay**, so add `@SubscribeMessage` handlers:

- A **single** opaque relay frame **`call.signal`** for all peer-to-peer signaling — it carries the encrypted `envelope`; **every** signal type (offer, answer, ICE, **and termination — decline/busy/cancel/hangup**) is an encrypted inner discriminant, so the gateway/Redis cannot tell setup from ICE from hang-up, and there is deliberately **no** per-phase relay frame ([02 §2](./02-signaling-protocol-and-state-machine.md)).
- The **only** other inbound frame is a minimal **`call.release{callId}`** server-state control (no reason, no SDP) that lets the server promptly release the call-authorization entry (§3.2a). It is **not** a relay and reveals only end-of-call lifecycle the server already tracks from `invite` — so it adds no phase/timing the server couldn't already infer.

The **`call.signal`** relay handler:
1. Derives identity from the **server-verified** socket binding (`VerifiedAuth.{sub,tenantId}`) — never from the frame.
2. Validates membership of the referenced `conversationId` via `MessagingService.isMember` (same authz as `onSubscribe`; non-members get the indistinguishable `conversation not found`).
3. Validates the `callId` against the **live call-authorization map** (§3.2a) and that the sender is a participant — a frame for an unknown/expired call, or from a non-participant, is **silently dropped** (no error response, so it cannot become an oracle). The server-issued `callId` is the authorization token; a client cannot fabricate one to relay into a call it was never part of.
4. Re-emits the matching bus event. **No DB write** (true in V1; remains true in V1.1 — the ledger is written by REST `invite`/`end`, not by the signaling fast-path).
5. Is subject to the per-socket inbound rate limit (see §8) — these frames are *not* covered by the HTTP throttler, so reuse/extend the existing `allowSubscribe` token-bucket pattern.

**`call.release` is a separate, non-relay path** — it carries only `{callId}` (no `conversationId`), so it does **not** run the steps above. The handler looks up the call-authorization entry by `callId`, verifies the socket's authenticated `sub` is one of the entry's **stored participants**, **drops the entry** (§3.2a), and **publishes nothing** — no bus event, no fan-out. It is bound by the same per-socket rate limit.

> **How a call ends.** The peer-to-peer hang-up / decline / busy / cancel is an encrypted inner type inside `call.signal`; the receiving client tears down. Separately, the client sends a minimal cleartext **`call.release{callId}`** so the server promptly drops the call-authorization entry (§3.2a) — the server never reads the encrypted reason, and release is **not** tied to the long-lived chat socket. The only server→client end notifications are the **server-known** events in `CallEndEvent` (§3.1).

> **In-call signaling is fragile by design — surface it (S1 / [06 §11](./06-threat-model-and-privacy.md)).** A WS-gateway restart **kills in-call signaling** (mute/hangup/renegotiation can no longer relay) while the **media stream survives** (DTLS-SRTP is peer-to-peer over the TURN relay, independent of the gateway). The in-call UI must therefore show an explicit **"signaling lost"** state rather than pretending the call is healthy. There is no auto-recovery in V1; ICE-restart / reconnection is V1.1.

### 3.2a Call-authorization lifecycle (the `callId` map)

The server keeps a small in-memory map `callId → { tenant, conversationId, callerSub, calleeSub, phase }` — the **authorization state** the relay handler (§3.2 step 3) checks. Its lifecycle is deliberately **not** a single ring timer:

- **Created** by a gate-passing `invite` (phase `ringing`). A no-op invite creates **no** entry (it returned an inert `callId`).
- **Pre-answer:** a **ring-timeout** (~45 s) releases the entry if the callee never engages.
- **Active:** the callee's **first relayed `call.signal`** on that `callId` (the encrypted answer/ICE — the server sees only the `callId` + the authenticated sender, never the contents) flips the entry to `active`. Its lifetime is then bound to a **call-signaling activity window** + a **max-call-duration cap** — never the ring timer, and never the shared long-lived chat socket — so a long, answered call keeps authorizing later ICE / renegotiation / hang-up frames instead of having its authz silently deleted mid-call (the bug this lifecycle exists to prevent).
- **Released**, in priority order: (1) an explicit minimal **`call.release{callId}`** the client sends on hang-up/decline (no reason, no SDP — the encrypted hang-up still goes peer-to-peer inside `call.signal`); (2) a **call-signaling inactivity timeout** if a client vanishes without releasing; (3) the **max-call-duration cap**. It is deliberately **not** tied to the shared, long-lived chat WebSocket (`apps/web/src/features/chat/useLiveConversations.ts` stays connected for messaging long after a call ends) — chat-socket loss is only a backstop, never the primary signal.

None of this is observable to a prober: invalid-`callId` frames are silently dropped (§3.2 step 3) and TURN creds are per-user, not `callId`-scoped (§2.2).

### 3.3 Per-device routing — V1 single-device, V1.1 ring-all

`VerifiedAuth` has **no `deviceId`**; routing is per `(tenant, sub)`.

- **V1 (single device per user):** a `CallRingEvent` fans to the callee's `(tenant, sub)`, which in the single-device model is exactly one live socket. No "answered-elsewhere" coordination is needed because there are no other devices to silence. This sidesteps the multi-device-MLS prerequisite entirely (see [00 §4](./00-overview-and-goals.md)).
- **V1.1 (multi-device ring-all):** a `CallRingEvent` fans to **all** of the callee's connected devices, and an answer on one device must **cancel the ring on the others**. Because the answer rides *inside* the opaque `call.signal`, the gateway cannot infer it — so ring-all needs **one explicit, minimal control signal** (e.g. a cleartext `call.accepted{callId}` the answering device sends *solely* to release sibling rings, carrying no SDP). This is an **intentional, documented metadata exception** — the server already knows the call exists and is being established — scoped to the sibling-cancel only and recorded in the threat model as "server learns a call was answered." The server then emits `CallEndEvent{reason:'answered-elsewhere'}` to the callee's *other* sockets. Per-device *addressing* (call-transfer, group calls) is a still-later concern. **All of this is V1.1; V1 is single-device and needs none of it.**

### 3.4 Presence — minimal, derived, not stored

There is **no presence system today** and neither V1 nor V1.1 should build a general one (that is its own privacy surface). Calling needs exactly one presence fact: *is the callee reachable right now?* — and even that must not become an oracle (§7). Approach:

- **Do not** add a presence table, last-seen, or a `GET /presence` endpoint. Presence is **never queried ahead of a call.**
- Reachability is discovered *by attempting the call*: the caller always gets a 202, always sees "ringing…", and learns the outcome only from what the callee's device does (answer / decline / timeout). An unreachable callee yields a timeout — indistinguishable from an online-but-ignoring callee. (In V1, "unreachable" includes "app not in the foreground," because there is no push-wake; this is the honest receivability limit documented in [00](./00-overview-and-goals.md) and [05](./05-frontend-pwa-and-webrtc.md).)
- The gateway already tracks live sockets in-memory for routing (`conns`); that is sufficient to decide whether to fan a `CallRingEvent` and is never exposed.

---

## 4. (V1.1) `call_sessions` table — metadata-only ledger

> **Phase: V1.1, not V1.** The audio core ships no ledger (see §0). This section is the worked-out V1.1 design so the table lands correctly when push-wake + the missed-call list arrive. Nothing here is built in the V1 slices.

A new tenant-scoped table built from the `0042_friendships.sql` / `0044_messages_prune_role.sql` template. **No SDP, no keys, no content** (invariants 1 & 6). It exists to power the missed-call list (which itself only becomes meaningful once a backgrounded callee can be wake-banner'd / shown a tap-to-join banner — V1.1) and to give abuse forensics a metadata trail.

### 4.1 Ephemeral vs persisted — the V1.1 decision

| Option | Verdict |
|---|---|
| **Pure Redis TTL, no DB** | Rejected for V1.1. Loses the missed-call record across a Redis restart; no durable abuse trail. |
| **Persist every call as a metadata row in `call_sessions`** | **Chosen for V1.1.** Durable missed-call list, abuse forensics, retention-aligned with messages. Metadata-only, so no content-exposure risk. |
| **Hybrid: Redis/in-memory for the *live ring state* + DB for the durable ledger** | **Chosen as the pair (V1.1).** The transient "ringing now" state lives in the gateway's in-memory map (already true in V1); the **durable** row is in `call_sessions`. The missed-call record is simply a `call_sessions` row whose `answered_at IS NULL` and whose `end_reason ∈ {missed, declined, cancelled, busy}` — no separate table. |

### 4.2 Migration sketch (`0045_call_sessions.sql`) — V1.1

Follows the canonical RLS block, the `to argus_app` scoping that is load-bearing (the #262 bypass lesson), the `nullif` empty-string guard, composite FKs for tenant pinning, and a leading-`tenant_id` index. A **dedicated prune role** (`argus_call_prune`) is added per the per-table-auditability rule rather than reusing `argus_msg_prune`. (Migration number `0045` is illustrative — it lands after whatever messaging/retention migrations precede it when V1.1 is scheduled.)

```sql
-- 0045_call_sessions.sql   (V1.1 — NOT part of the V1 audio core)
-- Metadata-only call ledger. NO SDP, NO keys, NO content (invariants 1 & 6).
-- down: drop table call_sessions cascade; drop role argus_call_prune;

create table if not exists call_sessions (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  conversation_id   uuid not null,
  initiator_user_id uuid,             -- nullable: pseudonymized to NULL on this party's GDPR erasure
  callee_user_id    uuid,             -- nullable: pseudonymized to NULL on this party's GDPR erasure
  media             text not null check (media in ('audio','video')),
  state             text not null default 'ringing'
                      check (state in ('ringing','answered','ended')),
  end_reason        text check (end_reason in
                      ('hangup','declined','missed','busy','failed','cancelled','answered-elsewhere')),
  relay_used        boolean,                           -- best-effort client report; null = unknown
  started_at        timestamptz not null default now(),
  answered_at       timestamptz,
  ended_at          timestamptz,
  -- composite-FK tenant pinning (defence-in-depth beneath RLS)
  constraint call_conv_fk   foreign key (tenant_id, conversation_id)
                            references conversations (tenant_id, id) on delete cascade,
  -- party FKs do NOT cascade: erasing one user must not delete the counterpart's call history.
  -- gdpr.service pseudonymizes the erased party's column to NULL first (then the user delete succeeds).
  constraint call_init_fk   foreign key (tenant_id, initiator_user_id)
                            references users (tenant_id, id) on delete no action,
  constraint call_callee_fk foreign key (tenant_id, callee_user_id)
                            references users (tenant_id, id) on delete no action,
  -- a row is either live or terminal-consistent
  constraint call_terminal_ck check (
    (state <> 'ended') or (ended_at is not null and end_reason is not null)
  )
);

alter table call_sessions enable row level security;
alter table call_sessions force  row level security;

drop policy if exists call_sessions_tenant_isolation on call_sessions;
create policy call_sessions_tenant_isolation on call_sessions
  to argus_app                                          -- scoped, NOT public (the #262 lesson)
  using      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- leading tenant_id index (invariant 3) + an age-ordered index the prune scan can use
create index if not exists call_sessions_tenant_idx
  on call_sessions (tenant_id, started_at desc);
create index if not exists call_sessions_started_at_idx
  on call_sessions (started_at);                        -- cross-tenant, age-ordered prune scan

grant select, insert, update, delete on call_sessions to argus_app;

-- ── least-privilege prune role (30-day TTL retention; see §5) ────────────
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'argus_call_prune') then
    create role argus_call_prune nologin nosuperuser nobypassrls noinherit;
  end if;
end $$;

-- window-scoped policies: the prune role can ONLY see/delete rows past the 30-day ceiling.
drop policy if exists call_sessions_prune_select on call_sessions;
create policy call_sessions_prune_select on call_sessions
  for select to argus_call_prune
  using (started_at < now() - interval '30 days');

drop policy if exists call_sessions_prune_delete on call_sessions;
create policy call_sessions_prune_delete on call_sessions
  for delete to argus_call_prune
  using (started_at < now() - interval '30 days');

-- column-scoped: the prune role can never read a meaningful payload (there is none, but stay tight)
grant select (id, started_at), delete on call_sessions to argus_call_prune;
```

Notes:
- **App-layer party predicate**, not a second RLS policy (the friendships convention): every `CallsService` query adds `and (initiator_user_id = :me or callee_user_id = :me)`. RLS only enforces tenant isolation; "caller is a party" is app logic → wrong caller → 0 rows → uniform 404.
- **No `device_id` columns.** The V1.1 ledger stays single-dimensioned on users; per-device addressing is a later concern (§3.3). Adding device columns only when ring-all/transfer needs them avoids dead schema.
- **30-day prune key is `started_at`** (not `created_at`): aligns the ledger's age semantics with the call's real start; the dedicated `started_at` btree (non-tenant-leading) is what the cross-tenant prune scan needs, exactly as `0044` adds a plain `created_at` index for messages.
- **GDPR erasure preserves the counterpart (Art. 17 / Art. 20).** The two party FKs are `on delete no action` (**not** `cascade`) and the party columns are nullable: erasing one user **pseudonymizes** their `initiator_user_id` / `callee_user_id` to `NULL` in `gdpr.service` (the same null-the-reference pattern messages use) so the other party's missed-call/history row survives; the table is also added to `gdpr.service.exportAccount` so a user's own call metadata rides their Art. 20 export. A row with both parties erased is anonymous metadata that ages out under the 30-day prune.

---

## 5. (V1.1) Retention / TTL alignment

> **Phase: V1.1.** No retention apparatus exists in V1 because no rows exist in V1.

Calling retention plugs into **Track 4** (`docs/planning/improvements/04-message-retention-and-pruning.md`; threat model `docs/threat-models/message-retention.md`) and the merged `0044` pattern:

- **30-day hard ceiling** — the confirmed Q3 ruling ([09](./09-decision-log-and-open-questions.md)) — expressed as the literal floor in the window-scoped policy (above). The TTL constant lives in the policy; the worker passes a matching `interval '30 days'` and can never delete a newer row. This 30 days is also the retention figure that must appear in the ROPA retention row (§9, GDPR bundle).
- **Slice ordering** mirrors Track 4: the `call_sessions` migration is the **boundary slice** (role + window policies + grants, no deletion, no worker). The TTL worker is a **separate slice** — `infra/retention/prune-call-sessions.sh` + a systemd `.service`/`.timer`, granting `argus_call_prune` LOGIN-NULL on the local socket and batch-reaping, exactly like the messages prune worker design.
- **No content prerequisites.** Unlike messages (which needed prune-safe cursors and commit-contiguity preservation), `call_sessions` is metadata-only and has no backfill/epoch coupling — so the worker can ship as soon as the boundary migration lands.
- **Missed-call UX vs retention**: 30 days is far longer than any missed-call list needs; the client typically shows the last N. The ceiling is a *privacy floor* (forget old metadata), not a feature limit.

---

## 6. Relay-only preference (default ON) — V1

**Where stored:** a single boolean column on `users` — **no settings table** (there is none today, and "simple first / no premature abstraction" applies):

```sql
-- a small V1 migration touching the existing users table (NOT a new table → no new-table RLS step)
alter table users add column if not exists call_relay_only boolean not null default true;
grant update (call_relay_only) on users to argus_app;   -- keep the update surface tight
```

- **Default `true`** — conforms to the locked IP-privacy decision (relay-only is the default; peers never learn each other's IP). The column inherits the existing `users_tenant_isolation` RLS and `argus_app` grants; the scoped `UPDATE (call_relay_only)` keeps the app's write surface minimal.
- **V1 behaviour:** the toggle is **exposed and stored** in V1, but `POST /calls/turn-credentials` ignores any `false` value and always shapes a relay-only response (§2.2) — V1 has **no direct-P2P path at all**. Storing the preference in V1 means the setting (and its honest UI copy) is in place before V1.1 flips on the direct-P2P opt-in, which becomes the *default transport-selection* before video ships (the confirmed Q1 (d) progression — [09](./09-decision-log-and-open-questions.md)).
- **Exposed to the client** via `GET /calls/settings` → `{ relayOnly }` and toggled via `PUT /calls/settings`. (A dedicated `/calls/settings` pair is cleaner for the controller-spec boundary than folding it into `/me`, and is the recommended default.)

> **Mutual-consent subtlety to flag for the client work (V1.1; see [05](./05-frontend-pwa-and-webrtc.md)):** relay-only is most robust when treated as "I will not expose *my* IP." Once direct-P2P opt-in exists, if A is relay-only and B is direct-OK, A offers only relay candidates; B offers host/srflx too, but A won't use them — so media still relays and A's IP stays hidden, while B's IP rode in B's offer and *was* visible to A. If hiding B's IP from A also matters, B must be relay-only too. The honest UI framing: "relay-only hides **your** IP from the other person." In V1 this subtlety is moot because both peers are always relay-only.

---

## 7. Authorization, IDOR, and the presence oracle

### 7.1 Friends-gated calling (reuse, don't reinvent) — V1

Only **accepted friends** may call each other. Reuse the friendships graph:

- `CallsService` calls into `FriendsService` (or a shared helper) to check an **accepted** `friendships` row for `canonicalPair(me, friendUserId)`. Pending/absent → not allowed.
- This is the *first* feature to actually gate contact on friendship — grounding confirms messaging does **not** currently require a friendship. So this gate is **new logic specific to calls**; it does not retroactively change messaging. Document it as such.
- Authz is **app-layer**, matching the friendships convention (RLS = tenant isolation only; "is a party / is a friend" lives in WHERE clauses and service guards). No second RLS policy.

### 7.2 No IDOR

- **V1:** the only call-scoped identifier is the transient `callId` in the gateway's in-memory ring map. WS frames referencing a `callId` are validated against the socket's verified identity + the conversation membership check (§3.2); a frame for a `callId` the sender isn't a party to is dropped as `conversation not found`.
- **V1.1 (ledger):** every `call_sessions` access is filtered by `(initiator_user_id = me OR callee_user_id = me)`. Wrong caller → 0 rows → **uniform 404** (`/calls/:callId/end`, `/calls/missed`). Same no-oracle posture as friends.
- `:friendUserId` and `:callId` are server-validated against the caller's identity and tenant; never trusted as authz input.

### 7.3 The presence / online oracle (the subtle one) — V1

Calling inherently risks leaking *"is this person online right now"* — a presence oracle even when no call connects. Mitigations, layered:

1. **Uniform 202 on invite.** `POST /calls/:friendUserId/invite` returns the **same 202 + same body** whether the callee is online, offline, not-an-accepted-friend, or busy. The caller cannot distinguish these from the HTTP response. (Mirrors the friends `send-request` uniform 202.)
2. **No presence endpoint.** There is no `GET /presence`, no last-seen, no typing indicator. Reachability is *only* discoverable by ringing — and a rung-but-unanswered call is indistinguishable from offline (both → timeout).
3. **Friendship gate limits the blast radius.** Only accepted friends can even trigger a ring, and crucially the **gate result is not surfaced**: a non-friend's invite still gets a 202 and silently no-ops (the server doesn't emit the ring), so the non-friend learns nothing about the target's existence or presence.
4. **Ring timeout is fixed, not presence-derived.** The server arms a fixed ring timeout (~45 s) regardless of whether a socket exists, so even timing doesn't leak "no device was connected vs. device ignored."

Residual, accepted risk: a *friend* who calls repeatedly can infer answer-vs-ignore patterns. That is inherent to any calling product and is bounded by the friendship consent + rate limits (§8). Captured in the threat-model note and in the extended `docs/threat-models/metadata-exposure.md` rows (§9).

---

## 8. Rate limiting & call-spam abuse controls — V1

Calling is a notification amplifier (every invite can ring a device), so it needs tighter limits than messaging.

| Surface | Control | Rationale |
|---|---|---|
| `POST /calls/turn-credentials` | HTTP throttler, e.g. **30/min/user** | Credential minting is cheap but a leaked-creds farm shouldn't be free; generous enough for retry |
| `POST /calls/:friendUserId/invite` | **Per-(caller→callee) cooldown** + global per-caller cap (e.g. 1 active ring per callee at a time; ≤ N invites/min/caller) | Stops ring-spam / "missed-call bombing" |
| WS `call.signal` / `call.release` | Per-socket token bucket (extend `allowSubscribe`) | Inbound signaling isn't covered by the HTTP throttler; ICE can be chatty — bound it but allow trickle-ICE bursts |
| Invite to a non-friend | Silent no-op (still 202) | No oracle, no notification |
| Repeated invites to same callee while a ring is live | **Per-(caller,callee) rate limit** + server-side dedup to one live ring; **every response still returns a fresh random `callId`** — a live ring is never re-exposed as a stable id | Prevents ring-spam **without** an oracle: reused IDs would let a caller compare retries to detect a live ring (§2.1) |

- Reuse the project's existing HTTP throttler (the same one the friends/messaging routes use) for REST; reuse/extend the gateway's per-socket bucket for WS.
- **Block list (future-friendly, optional):** unfriending already hard-deletes the friendship row, which immediately removes call ability (the §7 gate fails) — so "block" is covered transitively by unfriend. A dedicated block list is Enterprise-optional.

---

## 9. Required artifacts & DoD checklist

### 9.1 V1 (audio core)

Per AGENTS.md Definition of Done, the V1 slice must ship with:

- [ ] **Threat-model note** under `docs/threat-models/` (e.g. `voip-call-signaling.md`) written **before** coding — covers: signaling-over-Redis with no persistence (best-effort drop = call-fails-closed); the **authenticated-sender decrypt path** as the MITM defense and its `packages/crypto` dependency; presence-oracle mitigations (§7); TURN credential as secret-equivalent (no-log); relay-only-always in V1; the WS-restart "signaling lost" failure mode. Verify against the 6 invariants.
- [ ] **No new tables, no new DB roles in V1.** The only DB change is the `call_relay_only` boolean on the existing `users` table (inherits its RLS + grants).
- [ ] **OpenAPI**: the four V1 routes in `apps/api/openapi.json` with guard posture + tight typed schemas; `credential` flagged sensitive; **42Crunch audit ≥ 90**.
- [ ] **Controller specs** (two-tier): contract via `reflectRouteMeta` (guard + status), behaviour via direct instantiation (relay-only shaping, uniform-202 no-oracle, no-DB-write-on-invite, settings round-trip).
- [ ] **Zod schemas** in `@argus/contracts` (shared) mirrored in the server-local `apps/api/src/calls/*.schemas.ts` (the deliberate-duplication convention), `.strict()`, validated at every boundary.
- [ ] **No banned log patterns**: no SDP, no ICE, no TURN credential, no auth tokens in logs — IDs only.

### 9.2 Phase-0 GDPR artifact-update bundle (V1, before the first connecting call)

Calling adds new personal-data processing (call graph, call timing, relay-relayed peer IPs, and — in V1.1 — APNs/FCM push sub-processors). The Phase-0 DoD includes an **explicit, named** update to four canonical repo artifacts (echoed in [00](./00-overview-and-goals.md) process note, [06 §12](./06-threat-model-and-privacy.md) checklist, and [08](./08-roadmap-and-delivery-slices.md) P0-TM):

- [ ] **Revise `docs/gdpr/data-residency.md`** — add the **coturn relay** row (EU-pinned relay host; SRTP transits but is never decrypted; what metadata the relay process can observe).
- [ ] **Revise `docs/gdpr/article-30-records.md`** — add the new **processing activity** (1:1 calling), the new **personal-data category** (call metadata / relayed peer IP), the **APNs/FCM sub-processor** entry (V1.1, when push-wake lands), and the **retention row** (call ledger = **30 days**, V1.1).
- [ ] **Extend `docs/threat-models/metadata-exposure.md`** — add the **call-graph**, **call-timing**, and **relay-observable peer-IP** rows.
- [ ] **Create `docs/gdpr/dpia-voip-calling.md`** — the DPIA, stating the **legal basis per processing activity** (calling, ledger, push).

### 9.3 V1.1 additions

- [ ] **`call_sessions`**: `tenant_id` + RLS (ENABLE+FORCE, `to argus_app`) + leading `tenant_id` index + `started_at` prune index + composite FKs (**party FKs `on delete no action`, party columns nullable**) + dedicated `argus_call_prune` role with 30-day window-scoped policies. (`/db-migration` skill scaffolds this.)
- [ ] **GDPR wiring for `call_sessions`**: extend `apps/api/src/users/gdpr.service.ts` to (a) **pseudonymize** the erased user's `initiator_user_id` / `callee_user_id` to `NULL` (preserving the counterpart's row) before the user delete, and (b) include the user's own call metadata in `exportAccount`; add specs for both.
- [ ] **`POST /calls/:callId/end` + `GET /calls/missed`** in OpenAPI (guarded; `end`→204, `missed`→200) + their controller-spec rows (404-no-IDOR on `end`, metadata-only serialization on `missed`).
- [ ] **`argus_call_prune` TTL worker** (`infra/retention/prune-call-sessions.sh` + systemd timer).

---

## 10. PR-sized slice map

### 10.1 V1 (audio core)

| Slice | Scope | Gated by |
|---|---|---|
| **P0-crypto** | Authenticated-sender decrypt path in `packages/crypto` (MITM defense for the call signal) | **crypto-reviewer** (hard predecessor of the first connecting call) |
| **P0-GDPR** | The four-artifact bundle (§9.2): revise data-residency + article-30, extend metadata-exposure, create dpia-voip-calling | TM / GDPR review |
| **S1** | Threat-model note (`docs/threat-models/voip-call-signaling.md`) | — (docs first) |
| **S2** | `call_relay_only` boolean on `users` (no new table) + `GET/PUT /calls/settings` | DB review (column-grant scope) |
| **S3** | `calls` module: `POST /calls/turn-credentials` (**per-user**, relay-only shaping, HMAC creds, no-log) + secret wiring in fetch script | crypto/boundary review |
| **S4** | `POST /calls/:friendUserId/invite` (friendship gate, authenticated-sender stamp, uniform 202 with an inactive `callId` on no-op, in-memory **call-authorization map**, no DB write) | boundary review |
| **S5** | WS gateway: bus events + inbound `call.*` handlers + identity/room routing + per-socket rate limit + "signaling lost" surfacing | boundary review |
| **S6** | OpenAPI refresh + 42Crunch ≥ 90 + controller specs (both tiers) | DoD gate |

Critical path: **P0-crypto → S4 (invite + call-authorization map) → S5 (gateway relay, which validates `call.signal` against that map)**. P0-GDPR and S1 are docs-first and can land in parallel. S2 and S3 (per-user TURN creds) are independent and can land early. S6 finalizes S3–S5. This is the ~9-item audio core that [08](./08-roadmap-and-delivery-slices.md) draws its dependency graph around.

### 10.2 V1.1 (deferred)

| Slice | Scope | Gated by |
|---|---|---|
| **V1.1-a** | `0045_call_sessions.sql` boundary migration (table + RLS + `argus_call_prune` role + 30-day window policies, no worker) | DB review, RLS check |
| **V1.1-b** | `POST /calls/:callId/end` + `GET /calls/missed` (ledger write/read) + OpenAPI + controller specs | boundary review |
| **V1.1-c** | `argus_call_prune` TTL worker (`infra/retention/prune-call-sessions.sh` + systemd timer) | infra review |
| **V1.1-d** | Multi-device ring-all + "answered-elsewhere" fan-out (§3.3) | boundary review + multi-device-MLS prereq |
| **V1.1-e** | Push-wake (wake-banner / tap-to-join banner) + APNs/FCM sub-processor + article-30 update | boundary + GDPR review |
| **V1.1-f** | Video media + direct-P2P opt-in becoming the default transport selection (Q1 (d)) | full review pass |

---

## Sources

- [RFC 8827: WebRTC Security Architecture](https://www.rfc-editor.org/rfc/rfc8827) — presence/location not revealed before answer; relay-only as the privacy lever; identity vs. signaling trust.
- [TURN REST API draft (Uberti, behave WG)](https://www.ietf.org/proceedings/87/slides/slides-87-behave-10.pdf) — ephemeral `timestamp:userid` username + base64(HMAC-SHA1) credential; no long-term secret on the wire.
- [coturn turnserver wiki](https://github.com/coturn/coturn/wiki/turnserver) — `use-auth-secret` / `static-auth-secret` time-limited credential mechanism.
- [Let's talk about TURN authentication (L7mp)](https://medium.com/l7mp-technologies/lets-talk-about-turn-authentication-c2767514bc0c) — long-term vs. REST/ephemeral credential trade-offs.
