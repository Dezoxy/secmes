# Threat model — Web Push notifications (roadmap #40)

> Scope: `PUT /push/subscription`, `DELETE /push/subscription`, `PushService.notifyConversationMembers()`, the `push_subscriptions` table, and the client-side SW push handler + `lib/push.ts`.

---

## 1. What this feature does

After a message is stored the server fans a **content-free VAPID push** to every conversation member who has a push subscription (except the sender). The notification is a **wake-up ping**: no message content, no sender, no conversation id — just `{"type":"new_message"}`. The client wakes, re-connects via WebSocket, and fetches ciphertext as normal. The server's crypto-blind invariant (#1) is preserved: the push payload carries zero plaintext.

---

## 2. Assets and trust boundaries

| Asset | Where | Threat |
|---|---|---|
| **VAPID private key** | Azure Key Vault → `/run/argus/secrets/vapid-private-key` (credential file) | Leaking it lets an attacker impersonate the server to push services |
| **Push subscription endpoint** | `push_subscriptions.endpoint` (DB) | Reveals a push service URL per device (Apple/GCM/etc.) — metadata, not content |
| **p256dh / auth keys** | `push_subscriptions` (DB) | Transport-level encryption keys (RFC 8291); lets the holder encrypt payloads TO this device. Our payload is `{"type":"new_message"}` — content-free — so leaking these keys lets an attacker send fake wake-up pings, not decrypt messages |
| **Push payload** | In-flight (browser push service) | Any push service (Apple, Google, Mozilla) learns "a message event occurred for device X" |

---

## 3. Invariant checks

| # | Invariant | How it holds |
|---|---|---|
| 1 | Server is crypto-blind | Push payload is `{"type":"new_message"}` — no ciphertext, no sender id, no conversation id |
| 2 | No secrets/tokens/content in logs | `notifyConversationMembers` logs only device ids on push error; endpoint/p256dh/auth never logged |
| 3 | Tenant isolation (RLS) | `push_subscriptions` has ENABLE+FORCE RLS + tenant-isolation policy; subscription is only written/read within the caller's tenant |
| 4 | No hand-rolled crypto | `web-push` handles VAPID JWT + RFC 8291 ECDH payload encryption; we pass opaque subscription objects |
| 5 | Secrets from Key Vault | `VAPID_PRIVATE_KEY_FILE` sourced from Key Vault credential file; never an env var at rest |
| 6 | No admin path to content | Push endpoint stores no content; the admin plane never sees push payloads |

---

## 4. Attack surface

### 4.1 Subscription endpoint spoofing (SSRF via endpoint)
A malicious or compromised client could register an `endpoint` pointing to an internal service (e.g., `http://169.254.169.254/` — AWS IMDS; `http://metadata.google.internal/`). When `notifyConversationMembers` calls `webpush.sendNotification()`, the server would make an HTTP request to that URL.

**Mitigation:**
- `web-push` only sends to the registered push endpoint; the payload is tiny + VAPID-signed
- Reject `endpoint` values that are not `https://` (validated via Zod `.url()` on the contract, plus server-side HTTPS-only enforcement in `PushService.upsert`)
- The IMDS and metadata services are not reachable from the Azure VM by default (Azure IMDS is on the VM's link-local `169.254.169.254` — reachable only from within the VM, but Argus already runs there). **Added mitigation:** reject endpoint hostnames in the RFC 1918 / link-local / loopback ranges in `PushService.upsert` before storing.

### 4.2 Push-flood via message spam
An attacker in the same tenant sends a high volume of messages → triggers a push per message per member.

**Mitigation:**
- The global per-user HTTP rate limit (120/min) already caps how fast a tenant member can call `POST /conversations/:id/messages`
- The push fan-out is fire-and-forget (errors are caught; no user-visible feedback) — flooding the push service is the push provider's rate-limit to enforce

### 4.3 Subscription hijack (another tenant member registers under victim's device id)
`PUT /push/subscription` requires auth + the caller's own verified `user_id` is set from the token, not the request body. A member cannot write a subscription for another user's device — the upsert keys on `(tenant_id, device_id)`, and the composite FK `(tenant_id, device_id) → devices(tenant_id, id)` rejects a device the caller doesn't own… but this FK only proves the device exists for the tenant, not that it belongs to the caller.

**Mitigation (additional):** before upsert, verify `devices.user_id = resolved_caller_user_id` — reject with 403 if the device belongs to a different tenant member. This prevents A from registering a push subscription on B's device (so A gets notified when B has a message, which would reveal "B received a message" to A).

### 4.4 Subscription removal (silent unsubscribe another member)
`DELETE /push/subscription` removes the subscription for the VERIFIED caller's device (keyed by `user_id` from token, not client input). A member cannot unsubscribe another member.

### 4.5 Push metadata leakage to push provider
The push service (Apple APNs, Google FCM, Mozilla Autopush) learns: the endpoint (=the device it routes to) received a push at a given time. This is the same trade-off Signal and WhatsApp accept. The payload is `{"type":"new_message"}` (encrypted with RFC 8291 ECDH — only the device can decrypt), so the push service sees zero content.

**Accepted:** EU-based push providers are possible (Apple and Google have EU-residency options), but we don't control what push service each browser uses. The privacy disclosure in the product's security page (G7) should note this.

### 4.6 Stale subscriptions (device cleared, new device same user)
On device provisioning the client calls `PUT /push/subscription` (upsert). On logout/device-clear, `DELETE /push/subscription` removes it. If `DELETE` isn't called (crash, network failure), the stale subscription remains. `web-push` returns a 410 Gone from the push service when the subscription has expired — `PushService` should delete the row on 410 so stale rows are self-healing.

---

## 5. Key decisions

- **Content-free payload**: `{"type":"new_message"}` — zero metadata beyond "something happened".
- **VAPID private key in Key Vault**: same pattern as `S3_SECRET_ACCESS_KEY_FILE`.
- **HTTPS-only endpoint enforcement**: reject `http://` + private/loopback IPs before storing.
- **Caller-owns-device check**: verify `devices.user_id = caller` before upsert.
- **Self-healing 410**: on a 410 response from the push service, delete the subscription row.
- **Non-blocking fan-out**: a push send failure never surfaces to the caller; errors are logged with device id only.
