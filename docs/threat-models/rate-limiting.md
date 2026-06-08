# Threat model: rate limiting (per-user request throttling)

> Status: **DRAFT for ratification.** Roadmap **checkpoint 46**. A global per-verified-user request throttle
> (`@nestjs/throttler`) with a generous baseline and tighter caps on the abuse-prone mutations earlier threat
> models deferred to this checkpoint (key-directory §3, key-backup §49, encrypted-attachments). This is a
> **defensive control**, not a data feature: it sees request *metadata* only (identity, route), never bodies.

## 1. Feature & data flow

```
request → JwtAuthGuard (sets req.auth = {tenantId, sub} from the verified token)
        → UserThrottlerGuard
            ├─ shouldSkip: true for non-HTTP (WS) and @Public (health/version) → no HTTP throttle
            └─ getTracker: key = `u:<tenantId>:<sub>`  (verified identity, never client input)
                            `ip:<ip>` is a defensive default only — see scope note below
        → in-memory fixed-window counter per (key, route) → over limit ⇒ 429 + Retry-After
        → handler

WS frame `subscribe` → RealtimeGateway.onSubscribe (own per-socket rate limit; HTTP throttler can't see ws frames)
                       ├─ already in room → ACK, NO DB lookup (dedup; idempotent)
                       └─ new room → fixed-window cap (120/60s/socket) → over ⇒ `error: rate limited`
                                     else messaging.isMember (DB) → join

Two layers: a **global default** (120 req / 60 s / user) applied to every HTTP route, and per-route
`@Throttle` **overrides** on the abuse-prone mutations. The guard reads only the request's verified identity
and the matched route — it never touches the body, so it stays crypto-blind. Counters are in-memory
(single-VM deployment = one API process); a Redis store is the multi-instance / restart-safe upgrade and is
noted in the constants (Redis is already wired for the realtime bus).

**Scope — authenticated abuse only.** This guard runs **after** `JwtAuthGuard`, which rejects a
missing/invalid token before the throttler is reached. So it bounds *authenticated* abuse (the app-specific
risks: pool drain, storage flood) — it does **not** see, and does not bound, **unauthenticated** request
floods. That is deliberate: a pre-auth IP throttle can't tell an authed user from an attacker before auth
runs, so it would penalise legitimate NAT'd office traffic; and this API has **no password/login endpoint**
(auth is OIDC-delegated to Zitadel), so "pre-auth brute-force" is really a generic HTTP flood against a cheap
token-rejection path. Unauthenticated-flood protection is therefore delegated to the **edge** (Caddy
`rate_limit` / WAF), part of the VM deploy track (§6). The `ip:` key is only a degradation default so the
guard never crashes if `req.auth` is somehow absent.

Per-route caps (one source of truth: `rate-limit.constants.ts → SENSITIVE_LIMITS`):

| Route | Cap/min | Threat closed |
|---|---|---|
| `POST /users/:id/key-package/claim` | 30 | intra-tenant KeyPackage pool drain (key-directory §3) |
| `POST /devices/me/key-packages` (publish) | 12 | KeyPackage storage flood (key-directory) |
| `POST /devices/me/key-packages/revoke` | 12 | own-device delete hammering (key-directory) |
| `PUT /backups/me` (store) | 12 | sealed-backup write/churn abuse (key-backup) |
| `GET /backups/me` (fetch) | 20 | repeated-restore exfil / brute-force (key-backup §49) |
| `POST /attachments` (upload grant) | 30 | upload/storage abuse (encrypted-attachments) |
| `POST /attachments/download-url` (download grant) | 60 | presigned-URL minting churn; looser than upload — read-only, membership-gated, no storage write |

Everything else rides the 120/min baseline. Two row-creation paths are **consciously left at the baseline**:

- **Message send** (`POST /conversations/:id/messages`) — 120/min = 2 req/s is above any human typing burst.
- **Welcome delivery** (`POST /conversations/:id/welcomes`) — the client fans this out **one call per added
  member** when building a group (up to 256 members), so a tight per-minute cap would throttle legitimate
  group creation. Welcome-spam at a victim is instead bounded by membership gating (caller must be a member),
  the recipient's bounded pending-welcome list, and the 120/min baseline; a finer cap is a follow-up if abuse
  appears.

## 2. Assets & trust boundaries

- **Asset:** *availability* — finite server resources (DB rows, blob storage, KeyPackage pools) and one
  tenant/user's fair share of them. The control itself holds no secret; its job is to bound consumption.
- **Boundaries:** authenticated user ↔ server (an authenticated caller is the threat actor here — a valid
  member draining another member's pool); tenant ↔ tenant (one tenant must not spend another's budget). The
  unauthenticated client ↔ server boundary (request floods before a token exists) is **out of this guard's
  scope** — handled at the edge (§1 scope note, §6).

## 3. Threats (STRIDE-lite)

- **Denial of service (the primary risk).** An authenticated caller iterates user-ids to drain KeyPackage
  pools, floods publish/backup writes, or mints upload grants to churn storage. → Per-user per-route caps
  far below any drain rate but above legitimate bursts; the global baseline bounds everything else.
- **DoS via WebSocket `subscribe` frames.** The HTTP throttler can't see `ws` frames, and each new-room
  `subscribe` triggers a `messaging.isMember` DB lookup — an authenticated socket spamming distinct UUIDs
  could hammer the DB outside the HTTP caps. → The gateway carries its **own** per-socket limit: a
  re-subscribe to an already-joined room ACKs with **no** DB lookup (dedup), and new-room subscribes are
  capped at 120/60s/socket (far above any reconnect burst) before the lookup runs.
- **Spoofing the tracking key.** If the limit keyed on client-supplied input (an IP header, a body field),
  an attacker would rotate it to reset their counter. → The key is the **verified token's** `tenantId:sub`,
  set by `JwtAuthGuard` *before* this guard runs (guard order is fixed in `auth.module.ts`); never a header.
  The `ip:` fallback is unreachable for protected routes (auth runs first) — a degradation default, not a
  control (see §1 scope note).
- **Elevation / cross-tenant budget theft.** A shared (e.g. IP-based) bucket would let one tenant exhaust
  another's allowance, or lump many users behind one NAT. → Keying on `tenant:sub` isolates every user's
  budget; NAT-safe and tenant-safe by construction.
- **Information disclosure via 429.** A different limit/response on a missing vs. present resource could be
  an existence oracle. → The throttle is identity+route-keyed, not resource-keyed; it fires identically
  regardless of whether the target user/conversation exists, so it leaks nothing the route didn't already.

## 4. Invariant check

- **#1 crypto-blind** — upheld: the guard inspects identity + route only, never the request body/ciphertext.
- **#2 no secret logging** — upheld: the tracking key is `tenant:sub` (ids), never a token or header value;
  no throttler log statement emits the `Authorization` header or any secret. A 429 carries `Retry-After`
  only. (Verified: the guard builds the key from `req.auth`, not from `req.headers`.)
- **#3 RLS** — N/A (no table; in-memory counters). The limits *protect* tenant-scoped tables from drain.
- **#4 no hand-rolled crypto** — N/A (no crypto). `@nestjs/throttler` is a maintained, justified dep.
- **#5 secrets via Key Vault** — N/A (no secret).
- **#6 no admin content path** — N/A (no admin surface; control is uniform across users).

## 5. Decision & mitigations

- `ThrottlerModule.forRoot(DEFAULT_THROTTLE)` (120/min) + `UserThrottlerGuard` (global `APP_GUARD`, registered
  **after** `JwtAuthGuard` so `req.auth` exists when the key is built). `getTracker` → `tenant:sub` / IP
  fallback; `shouldSkip` → non-HTTP + `@Public`, mirroring the auth guard's exemptions so the two stay in
  lockstep.
- Per-route `@Throttle(perMinute(SENSITIVE_LIMITS.*))` on the six routes in §1. Numbers centralised in
  `SENSITIVE_LIMITS` so the threat model, the guard test, and the code reference one value.
- OpenAPI: `429` added to the shared `STD_ERROR_RESPONSES` (documented on every operation); spec regenerated.
- Gate: **`security-boundary-auditor`** review (key not from client input, no secret in logs, exemptions
  match auth); unit test `user-throttler.guard.spec.ts` (verified-user key, IP fallback, WS/@Public skip);
  42Crunch re-audit of the regenerated spec.

## 6. Residual risk

- **Unauthenticated request floods are not bounded by this guard.** Because `JwtAuthGuard` runs first and
  rejects a missing/invalid token before the throttler, failed-auth requests never reach it — so the app
  layer does not throttle the pre-auth/JWKS-verification path. This is an accepted, deliberate boundary: a
  pre-auth IP throttle would penalise legitimate NAT'd traffic, and the API has no password endpoint to
  brute-force (OIDC-delegated). **Resolution:** unauthenticated-flood throttling is the **edge's** job —
  Caddy `rate_limit` (per-IP, connection-level) / WAF, landing with the VM deploy track. If app-layer
  coverage is ever needed, the correct hook is the **auth-failure path** (count only failed verifies by IP),
  not a blanket pre-auth IP guard. Token verification itself is cheap (jose, cached JWKS, no DB), so the
  un-throttled surface is a generic HTTP flood, not a credential oracle.
- **In-memory counters reset on restart / aren't shared across instances.** A pod restart clears windows, and
  a future scale-out (>1 API process) would give each its own counters (effective limit ×N). Acceptable for
  the single-VM beta; the upgrade is the **Redis store** (`@nestjs/throttler` storage adapter) — Redis is
  already deployed for the realtime bus. Flagged in `rate-limit.constants.ts`.
- **Fixed-window burst at the boundary.** A caller can send up to 2× the cap across a window edge (end of one
  window + start of the next). Standard for fixed-window; the caps are set with that 2× slack in mind, well
  below any drain rate. A sliding-window/Redis store tightens this later.
- **Coarse-grained, not per-(caller,target).** The claim cap is per-caller, not per-(caller, victim) — a
  caller still gets 30 claims/min to spread across victims. Combined with **per-claim audit**
  (`keydir.key_package_claimed`) drains stay detectable; finer per-target limiting is a follow-up.
- **WS subscribe limit is per-socket, not per-user-aggregate.** A user opening many sockets multiplies their
  subscribe budget. Each socket still requires a valid token (attributable) and counts against connection
  limits, and `isMember` is an indexed lookup — so the unbounded single-socket amplification is closed.
  Per-user-aggregate + max-connections-per-user caps ride the realtime hardening / edge follow-up.
- **DDoS / L7 volumetric** (many IPs, pre-auth) is **out of scope** for app-layer throttling — that belongs at
  the edge (Caddy/WAF/CDN), part of the VM deploy track.
