# Threat model: realtime delivery (WebSocket gateway)

> Status: **DRAFT for ratification.** Roadmap **checkpoint 28** — an authenticated WebSocket gateway that pushes **ciphertext** to connected conversation members in real time. Single-pod, in-memory fan-out; cross-pod delivery via a Redis backplane is checkpoint 29. Offline queue/catch-up is 30 (today a reconnecting client back-fills via `GET /conversations/:id/messages`).

## 1. Feature & data flow

```
connect:   client opens a WebSocket → sends {event:'auth', data:{token}} as the FIRST frame
           gateway verifies the JWT (same AuthService as HTTP) → binds {sub, tenantId} to the socket
subscribe: client sends {event:'subscribe', data:{conversationId}} → gateway checks MEMBERSHIP → joins
deliver:   POST /…/messages stores ciphertext → emits 'message.created' on an in-process bus →
           gateway pushes {event:'message', data:{…ciphertext envelope…}} to that conversation's
           subscribed sockets IN THE SAME TENANT
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
- **Subscribe = membership-gated** (`MessagingService.isMember`, under RLS). **Delivery = tenant+conversation-keyed** in-process fan-out; the HTTP send path emits on a `RealtimeBus` (Node `EventEmitter`) — no module cycle, no extra dependency.
- Gate: **`security-boundary-auditor`** review; gateway unit tests with mock sockets prove auth-required, subscribe-authz, and tenant/conversation-scoped delivery deterministically.

## 6. Residual risk

- **Metadata to the operator** — connection presence + which conversations a socket subscribes to are visible server-side (inherent to a delivery server). Disclosed in plan §14/§15.
- **No per-IP/per-socket caps yet** — connection/subscription flooding is bounded only by the auth deadline until checkpoint 46 (rate-limiting). Accepted for beta.
- **Single-pod fan-out** — delivery only reaches sockets on the same pod until the Redis backplane (29). A reconnecting client never loses messages: the DB is the source of truth and the client back-fills via REST fetch (cursor).
- **Authenticated-then-revoked token** — a long-lived socket keeps its identity until disconnect even if the token is later revoked; bounded by token lifetime. A periodic re-auth / max socket lifetime is a later hardening.
