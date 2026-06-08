# Threat model: realtime delivery (WebSocket gateway)

> Status: **DRAFT for ratification.** Roadmap **checkpoints 28 + 29** — an authenticated WebSocket gateway that pushes **ciphertext** to connected conversation members in real time, with a **Redis backplane** (29) as the realtime bus. The deploy is a single API container on the VM, so the backplane isn't needed for cross-pod fan-out today, but it stays as the realtime bus (and the future throttler store). Offline queue/catch-up is 30 (today a reconnecting client back-fills via `GET /conversations/:id/messages`).

## 1. Feature & data flow

```
connect:   client opens a WebSocket → sends {event:'auth', data:{token}} as the FIRST frame
           gateway verifies the JWT (same AuthService as HTTP) → binds {sub, tenantId} to the socket
subscribe: client sends {event:'subscribe', data:{conversationId}} → gateway checks MEMBERSHIP → joins
deliver:   POST /…/messages stores ciphertext (COMMITS) → emits 'message.created' on an in-process bus →
           gateway pushes {event:'message', data:{conversationId, message:{…ciphertext envelope…}}} to
           that conversation's subscribed sockets IN THE SAME TENANT (conversationId so a multiplexed
           socket knows which conversation each frame belongs to)
```

The gateway only ever forwards the **opaque ciphertext envelope** (the same fields the REST fetch returns: `ciphertext`, `alg`, `epoch`, ids, `createdAt`). It never sees plaintext or keys. The token is sent in the **first application frame**, not the handshake URL/headers, so it can't land in a proxy/access log.

## 2. Assets & trust boundaries

- **Assets:** the bearer token (handshake auth); message **ciphertext** in flight (already E2EE — the WS only moves it); the socket↔identity binding; tenant isolation of the fan-out.
- **Boundaries:** client ↔ gateway (must authenticate before doing anything; transport is WSS/TLS at the ingress); tenant ↔ tenant (a socket may only receive its own tenant's conversations); member ↔ non-member (subscribe requires membership).

## 3. Threats (STRIDE-lite)

- **Spoofing — unauthenticated or impersonating socket.** A socket does nothing until it sends a valid token; an **auth deadline** closes sockets that don't authenticate in time. Identity (`sub`, `tenantId`) comes only from the **verified** JWT, never from client-supplied fields. You cannot subscribe as another user.
- **Information disclosure — receiving another conversation's / tenant's messages.** Subscribe is gated by a **membership check** (the same `requireMembership` used by REST); delivery is keyed by `(tenantId, conversationId)` and a socket's `tenantId` is fixed at auth — so a fan-out can never cross tenants or reach a non-member. The payload is ciphertext regardless (E2EE backstop).
- **Tampering / replay.** The gateway does not mutate or persist; ordering/integrity of message content is the MLS layer's job. The DB remains the source of truth (REST fetch).
- **DoS — connection/subscription floods.** Auth deadline + (future) per-IP connection caps and per-socket subscription caps. Noted as residual for beta; rate-limiting lands with checkpoint 46.

## 4. Invariant check

- **#1 crypto-blind** — upheld: only the opaque ciphertext envelope crosses the socket; the gateway never decrypts.
- **#2 no secret logging** — the token is verified and discarded; it is NEVER logged (it arrives in an app frame, not a header). No ciphertext/token in any gateway log.
- **#3 RLS / tenant isolation** — the membership check at subscribe runs under `withTenant` (RLS); the fan-out map is tenant-keyed; a socket's tenant is fixed from its verified claim.
- **#4 hand-rolled crypto / #5 Key Vault / #6 admin content** — N/A here (no crypto, no secrets, no admin content); upheld.

## 5. Decision & mitigations

- **Native `ws`** (`@nestjs/platform-ws`), not socket.io: browser-native client (no client lib, smaller PWA bundle, no long-poll fallback), and a custom Redis backplane (29) keeps us off socket.io's protocol.
- **First-frame token auth** (not handshake subprotocol/query) so the token never appears in a URL/header a proxy might log. An **auth deadline** closes silent sockets.
- **Subscribe = membership-gated** (`MessagingService.isMember`, under RLS). **Delivery = tenant+conversation-keyed** fan-out; the HTTP send path emits on a `RealtimeBus` **after the insert commits** (no phantom delivery / read-your-writes race).
- **Redis backplane (29):** `RealtimeBus` is abstract — `InProcessRealtimeBus` (single container / dev / tests) or `RedisRealtimeBus` (when `REDIS_URL` is set). The Redis impl **publishes** each event to a channel and every subscriber **subscribes** and fans out to its local sockets. On the single-container VM deploy the in-process bus suffices; the Redis backplane stays as the realtime bus (and the future throttler store), and would also enable cross-instance fan-out if the API ever ran more than one container. **Only the opaque ciphertext envelope crosses Redis** (same `FetchedMessage` as REST) — never plaintext or keys, and the `tenantId`/`conversationId` keying is preserved, so delivery is still tenant- and member-scoped. Incoming events are **Zod-validated** before fan-out (a malformed/poisoned payload is dropped, never crashes the gateway).
- Gate: **`security-boundary-auditor`** (boundary) + **`infra-reviewer`** (compose/backplane); gateway unit tests prove auth/authz/scoped-delivery deterministically; a live-Redis test proves backplane fan-out + malformed-payload rejection.

## 6. Residual risk

- **Metadata to the operator** — connection presence + which conversations a socket subscribes to are visible server-side (inherent to a delivery server). Disclosed in plan §14/§15.
- **No per-IP/per-socket caps yet** — connection/subscription flooding is bounded only by the auth deadline until checkpoint 46 (rate-limiting). Accepted for beta.
- **Redis is in the trust boundary for ciphertext + metadata** — the backplane carries the opaque ciphertext envelope and routing metadata (tenant/conversation/sender ids). It must be **private and authenticated** (network-isolated on the VM's Docker network; AUTH via the connection string; never a public endpoint) — same posture as the database. Redis never sees plaintext or keys. A compromised Redis could observe metadata or inject events, but injected events are tenant/conversation-keyed and Zod-validated, and the payload is undecryptable ciphertext (E2EE backstop). The `REDIS_URL` (which carries auth) is delivered to the API container as a **credential file from Key Vault** (the VM's Managed Identity) — never a plaintext value committed to the repo.
- **Catch-up consistency under concurrent sends (not just a `/sync` property).** `/sync` (and `GET /conversations/:id/messages`) paginate by a `(created_at, id)` keyset. `created_at` is assigned before commit, so a message that commits *after* a page was read but carries an earlier `created_at` (concurrent sends / lock delays) can fall *behind* the cursor and be skipped by the next page. The no-loss guarantee is therefore the **client connect protocol + the WS path**, not the keyset alone: on (re)connect the client **(1)** subscribes to its conversations FIRST (so any message committing thereafter is delivered live via the gateway's **post-commit** fan-out), **(2)** `/sync`s from its last-confirmed cursor to fill the offline gap, **(3)** **deduplicates by message `id`** across the WS and sync streams, and **(4)** overlaps the cursor (re-syncs from slightly before its last *contiguous* point) so a boundary message can't be permanently missed. This is the standard catch-up model for store-and-forward E2EE feeds (Signal/Matrix-style); the server endpoints are correct building blocks and the DB remains the source of truth. An enterprise-grade alternative that makes `/sync` self-sufficient is a **commit-order watermark** (snapshot `xmin` / a contiguously-committed sequence high-water-mark) — tracked as a future enhancement. The client-side protocol lands with the client app (#39).
- **Backplane availability** — if Redis is down, real-time fan-out stalls; messages are still durably stored (DB source of truth) and delivered on the client's next REST fetch / reconnect. ioredis auto-reconnects; a transient error doesn't crash the pod. Operational alerting on Redis is a later observability concern.
- **Restart/redeploy drops WebSockets** — a deploy (`az vm run-command` recreating the API container) terminates open sockets; clients auto-reconnect and back-fill via REST. On the single-container VM there's no scale-down churn; if the API is ever scaled to multiple instances, WS-aware load balancing is a later refinement.
- **Authenticated-then-revoked token** — a long-lived socket keeps its identity until disconnect even if the token is later revoked; bounded by token lifetime. A periodic re-auth / max socket lifetime is a later hardening.
