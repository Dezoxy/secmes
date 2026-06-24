# Threat model: user privacy settings

**Feature:** Per-user privacy preference toggles — read receipts, typing indicators, link previews — persisted server-side and synced across devices.

## What is stored

Three boolean values on the `users` row:

| Column | Default | Meaning |
|--------|---------|---------|
| `privacy_read_receipts` | `true` (NULL) | Whether to send/display read watermarks |
| `privacy_typing_indicators` | `true` (NULL) | Whether to send/display typing events |
| `privacy_link_previews` | `true` (NULL) | Whether the client generates link previews |

This is user-preference metadata — no content, no keys, no PII beyond what is already on the `users` row. Invariant #1 (crypto-blind server) is unaffected.

## Trust boundary

- A user can read and write only their own settings. The `GET /me/settings/privacy` and `PUT /me/settings/privacy` endpoints key on the caller's verified `userId + tenantId`; there is no `userId` parameter exposed to the caller.
- RLS on `users` (tenant-isolation policy, FORCE RLS) enforces the tenant boundary at the database level as a second line of defence.
- No admin path exposes another user's settings. The admin controller is metadata-only and does not proxy these endpoints.

## Enumeration / oracle

No risk: the endpoints return the caller's own settings, not a lookup of another user's preferences. A correct `GET` for a user whose row does not exist returns the defaults (same shape as a found row) so no existence oracle is created.

## `linkPreviews` client-only enforcement

The server never fetches URLs on behalf of users. `linkPreviews` is honoured client-side only: when `false`, the client suppresses preview generation before sending any URL to a third-party fetch service. The server stores and forwards the setting but has no enforcement role, which is consistent with invariant #1.

## Rate limiting

`PUT /me/settings/privacy` shares the `updateProfile` per-minute budget (20 req/min per verified user). This caps bulk preference-churn without touching normal use.

## Audit

Every `PUT /me/settings/privacy` call is written to the audit log with `eventType: 'users.privacy_settings_updated'` and `metadata: { fieldsUpdated: [...] }`. Field names only — never values — consistent with the audit-logging invariant (no sensitive values in metadata).

## GDPR

The three boolean preferences are included in the GDPR Art. 20 data-portability export under `profile.privacySettings`. On account deletion (Art. 17), the settings are deleted as part of the `users` row cascade — no separate cleanup step is needed.

## Invariant check

| # | Invariant | Status |
|---|-----------|--------|
| 1 | Server crypto-blind | ✅ Booleans are preferences, not content |
| 2 | No plaintext in logs | ✅ Audit records field names only |
| 3 | tenant_id + RLS on tenant tables | ✅ Columns added to `users`, existing RLS covers them |
| 4 | No hand-rolled crypto | ✅ No cryptography involved |
| 5 | Secrets from Key Vault | ✅ No secrets |
| 6 | No admin path to content | ✅ Admin surface unchanged |
