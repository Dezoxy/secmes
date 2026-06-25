# Threat model: POST /calls/turn-credentials

**PR**: feat/voip-p0-api (PR 9/14)  
**Invariants checked**: 1 (crypto-blind), 2 (no secrets in logs), 4 (no hand-rolled crypto), 5 (secrets from Key Vault)

---

## What this endpoint does

Mints short-lived, HMAC-SHA1-derived TURN relay credentials for WebRTC peer connection setup. The coturn relay forwards opaque DTLS-SRTP media — it never learns call content, participant identities beyond the credential expiry, or call IDs. The API mints creds without knowing who the callee is; coturn consumes them without knowing the call context.

## Trust boundaries

| Component | Trusts | Does NOT trust |
|---|---|---|
| API | Its own Key Vault-derived HMAC key + the verified JWT (auth guard) | Caller-supplied body (empty; ignored) |
| coturn | The HMAC-SHA1 credential as proof of API authorization | Anything inside the DTLS-SRTP stream (crypto-blind, invariant 1) |
| Client | The API's ICE server config | Each other's IP addresses (relay-only forces TURN, never direct) |

## Threats and mitigations

### T1 — Credential as relay-abuse vector (unauthenticated spam)
An attacker without an account tries to open unlimited TURN relay channels.
**Mitigation**: bearer JWT required (JwtAuthGuard + global deny-by-default). No token → 401 before any credential work.

### T2 — Credential farming by an authenticated but friendless account
An authenticated user with no friends mints many short-lived credentials to abuse the relay.
**Mitigation**: coarse friendship gate (≥1 accepted friend). Per-pair-blind: the check is `count(accepted friendships for me) ≥ 1` — it reveals nothing about who the callee is or whether a specific callId is real (no oracle). 403 on failure.

### T3 — Relay bandwidth exhaustion (authenticated, has friends)
A legitimate user mints creds rapidly and opens many relay channels.
**Mitigation**: per-user HTTP throttle (30/min, `UserThrottlerGuard`); coturn `user-quota=6` (max 6 simultaneous relay sessions per credential); coturn `max-bps=128000` (128 kbps cap per session); credential TTL 600 s limits how long each channel can run without re-auth.

### T4 — Credential interception / replay after expiry
An attacker intercepts a TURN credential from a TLS-protected response.
**Mitigation**: TTL 600 s. An intercepted credential is useless after 10 minutes. Clients re-fetch per call attempt — no persistent tokens. The credential grants only relay channel access, not API access.

### T5 — HMAC key compromise (coturn side)
The `static-auth-secret` leaks from the coturn host.
**Mitigation**: Key Vault delivery (invariant 5); secret is a file mount (`/run/secrets/turn_shared_secret`), never in env or logs. Rotation: update Key Vault, restart both api and coturn services; previously minted credentials expire within 600 s.

### T6 — TURN server used as SSRF proxy
A credential holder directs coturn to relay to private RFC 1918 / link-local addresses.
**Mitigation**: `denied-peer-ip` rules in `turnserver.conf` block all RFC 1918, 100.64/10, and loopback ranges. `no-tcp-relay` removes the TCP relay surface entirely (V1 is UDP DTLS-SRTP only).

### T7 — Presence / friendship oracle via credential response shape
Returning 403 vs 200 based on a specific callee reveals whether two users are friends.
**Mitigation**: the gate is requester-only (`count(my accepted friends) ≥ 1`) — the callee is never consulted. The 403 reveals only that the requester has zero friends, which is self-knowledge, not peer-knowledge.

### T8 — Credential in logs (invariant 2)
The `credential` field (base64 HMAC digest) is SECRET-EQUIVALENT — a bearer of it can open relay channels until expiry.
**Mitigation**: the controller is a thin pass-through that never accesses `iceServers` or `credential`; the service never logs the credential or the HMAC key; `calls.config.ts` never logs the raw key. Verified by the controller spec's Proxy-based no-log test.

## Invariant compliance

1. **Crypto-blind**: the API mints credentials without knowing the callee or the call content. coturn relays DTLS-SRTP opaquely. ✓
2. **No secrets in logs**: HMAC key and derived credential are never passed to any logger. ✓
4. **No hand-rolled crypto**: HMAC-SHA1 runs inside `packages/crypto#mintTurnCredential` (audited, not inline). ✓
5. **Secrets from Key Vault**: `TURN_SHARED_SECRET_FILE` is a Docker secret file derived from `argus-turn-shared-secret` in Key Vault; never in env at rest. ✓
