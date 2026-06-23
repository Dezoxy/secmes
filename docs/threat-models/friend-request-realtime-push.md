# Threat model: friend-request realtime delivery + push notification

## Feature

When user A sends a friend request to user B:
- B receives a live WebSocket nudge so the Friends badge updates without a reload.
- A push notification fires if B's app is backgrounded or closed.

## Trust boundary

The notification path is purely server-to-recipient. The sender (A) gets no signal about delivery
outcome; the HTTP response remains a uniform 202 regardless of whether the row was written, the
socket was reachable, or push was configured (R-friends-3).

## Invariants checked

| # | Invariant | Status |
|---|-----------|--------|
| 1 | Server is crypto-blind | ✓ — WS frame carries `{}`, push payload carries `{type:'friend_request'}` only. No content, no sender id, no argus-id. |
| 2 | No secrets/tokens/content in logs | ✓ — `notifyFriendRequest` logs nothing. `notifyUser` logs only internal subscription row id on error. |
| 3 | Tenant isolation | ✓ — event carries `tenantId`; gateway matches verified `(tenantId, sub)` before delivery. |
| 4 | No hand-rolled crypto | ✓ — no crypto in this path. |
| 5 | Secrets from Key Vault | ✓ — VAPID config injected from existing `VapidConfig` (no new secrets). |
| 6 | No admin path to content | ✓ — no admin surface touched. |

## Sender oracle (R-friends-3)

The notify fires **only when `.returning({ id })` returns a row** — i.e. when a genuinely new or
revived pending row was written. A re-send against a live-pending or accepted pair is a Drizzle
ON-CONFLICT no-op and returns no rows; no event or push is emitted. This means:

- A cannot use repeated sends to infer whether B accepted (push silence ≠ accepted).
- A cannot spam B's notifications by re-sending the same request.

## Recipient-scoped delivery

The WS event carries only `tenantId + recipientSub`. The gateway iterates **all connected sockets**
and matches on the verified `(tenantId, sub)` stored at authentication time — never client-supplied
input. Two subs are emitted (`externalIdentityId` and `argusid:<argusId>`) so sockets authenticated
under either token family receive the nudge (copied from the Welcome-delivery pattern).

The push notification fan-out uses the recipient's internal `userId` to query `push_subscriptions`
within a `withTenant` transaction (RLS active), preventing cross-tenant reads.

## Denial-of-service surface

A malicious sender can cause at most one push notification per recipient per accepted-request or
expired-then-renewed-request (notify-only-on-new-row gate above). This is bounded by the existing
friend-request send-rate limit on the HTTP layer and the 14-day TTL on pending rows.

## Metadata exposure

The push payload `{type:'friend_request'}` confirms to an attacker with access to the push service
that a friend request event occurred for this subscription. This matches the existing `new_message`
push posture (confirmed in `docs/threat-models/web-push.md`): the push service sees only an opaque
delivery, and the payload type is the minimal signal needed for the client to display a useful OS
notification.
