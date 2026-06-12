# Threat model: G3 Admin panel

**Scope:** `GET /admin/devices`, `DELETE /admin/devices/:deviceId`, `GET /admin/audit`  
**PR:** feat/g3-admin-panel  
**Invariant checklist**

| # | Invariant | How it's met |
|---|-----------|-------------|
| 1 | Server is crypto-blind | No message content, no key material, no ciphertext blobs returned. Devices endpoint returns only public-key prefix (12 chars, non-reversible identifier). Audit endpoint returns event types and OIDC subs — metadata only. |
| 2 | Never log plaintext/keys/tokens | `device.revoked` audit event records only `actorSub` + `tenantId`. No presigned URLs in responses. IP is returned to the **admin of the same tenant** — this is intentional (security/forensics). |
| 3 | tenant_id + RLS on every table | All queries run inside `withTenant(auth.tenantId, …)` which sets `app.tenant_id`; FORCE RLS on `devices` and `audit_events` provides a second enforcement layer independent of application logic. |
| 4 | No hand-rolled crypto | Not applicable — no crypto in this feature. |
| 5 | Secrets from Key Vault | Not applicable — no new secrets. |
| 6 | No admin path to content | Confirmed: no message text, no attachment blobs, no content keys are reachable through these endpoints. |

## Auth & authorisation

- `AdminGuard` enforces `users.role = 'admin'` (active) against the verified token's tenant. Applied at the controller level (`@UseGuards(AdminGuard)`), so every handler in `AdminController` is gated.
- `JwtAuthGuard` (global) validates the JWT and sets `req.auth`; `AdminGuard` re-reads the user row — double enforcement independent of the JWT claims.
- Non-admins (including members of the same tenant) receive 403. Cross-tenant requests are impossible: `withTenant` + RLS bind every query to the verified `tenantId`.

## Device revoke

- Hard-delete of the `devices` row cascades to `key_packages` (FK `ON DELETE CASCADE`).
- Effect: the device loses its one-time KeyPackage pool. It cannot receive new MLS Welcomes and cannot be added to new conversations. Existing sealed MLS group state on the client device is still present locally but is orphaned — the server will not serve it new material.
- Admin can revoke their own device (edge case; they simply re-provision on next login).
- Audit event `device.revoked` is written after the DELETE succeeds.

## Audit log exposure

- The `ip` column (inet) is shown to tenant admins for forensic purposes. It is not exposed to members or external parties.
- `actorSub` is the verified OIDC subject (an opaque identifier, not a session token).
- `actorDisplayName` is resolved via LEFT JOIN on `users.external_identity_id` within the same RLS context — a deleted/revoked user resolves to `null`.
- Cursor encoding: `base64url(JSON({ createdAt, id }))` — no secret data, tamper-tolerant (a malformed cursor returns from the beginning).

## Rate limits

| Endpoint | Limit |
|----------|-------|
| GET /admin/devices | 60/min (default baseline) |
| DELETE /admin/devices/:id | 12/min (`adminDeviceRevoke`) |
| GET /admin/audit | 60/min (default baseline) |
