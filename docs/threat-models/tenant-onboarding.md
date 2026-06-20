# Threat model: tenant onboarding (G1)

> ⚠️ **SUPERSEDED IN PART (2026-06-17, #223 / `phase-6-decommission.md`).** **Self-serve org
> creation was removed.** There is no `POST /tenants` create-org route and no anonymous tenant
> self-registration: `apps/api/src/tenants/tenants.controller.ts` exposes only **admin-guarded**
> invite management (`POST /tenants/invites`, list/revoke, member-role). The shipped onboarding
> path is **admin mints a single-use invite code → invitee registers with a passkey** and is bound
> to the tenant in the WebAuthn verify transaction (`registration-and-tenancy.md` T1–T9), not via a
> bearer-token `accept` call. The **still-current** core of this note is the trust model of
> `user_tenant_index` (INSERT-only, server-controlled `sub` binding, RLS) and the invite-token
> threats (entropy, single-use, email binding, log hygiene); the `POST /tenants` create-org path
> and the "brand-new Zitadel user" framing are historical. Read `registration-and-tenancy.md` for
> the live flow.

> Covers the invite flow (`POST /tenants/invites` / `revoke`) and `user_tenant_index` (the binding
> table). Companion to `session-tokens.md` (token edge) and `rls-tenant-isolation.md` (DB layer).

## 1. Feature & data flow

A brand-new Zitadel user has a verified `sub` claim but no tenant assignment. Two paths
bind them to a tenant:

1. **Create org**: `POST /tenants { name }` — mints a server-side UUID, inserts the
   tenant row + admin user row + `user_tenant_index` entry atomically.
2. **Accept invite**: `POST /tenants/invites/accept { token }` — looks up an admin-issued
   invite by `SHA-256(token)`, validates it, and inserts the user + index entry.

After either path, `AuthService.verify()` finds the `user_tenant_index` row on the next
request and returns a bound `tenantId`. No token refresh required — verify() hits the DB
on every request.

## 2. Assets & trust boundaries

- **user_tenant_index**: the authoritative sub→tenant binding. Immutable from the app
  role (SELECT + INSERT only; no UPDATE/DELETE). Binding can only be created by the two
  code paths above.
- **tenant_invites**: capability tokens granting join access to one specific tenant.
  Admin-scoped write; consume is single-use and atomic.
- **Invite token plaintext**: returned once in the API response; never stored. The
  `token_hash` (SHA-256) is what persists.

## 3. Threats

1. **Spoofing: user creates a binding for someone else's `sub`.**
   → The JWT guard validates the bearer token; `sub` comes from the verified claim only.
   The `POST /tenants` path binds `auth.sub` (verified). The `accept` path also binds
   `auth.sub` from the verified token — the invitee cannot impersonate another `sub`.

2. **Elevation: user joins a tenant they were not invited to.**
   → `accept` requires a valid `token_hash` match in `tenant_invites`. A 32-byte random
   token has 256 bits of entropy — brute-force infeasible. The row also checks
   `expires_at`, `accepted_at IS NULL`, `revoked_at IS NULL`.

3. **Link forwarding: invite used by wrong person.**
   → Admin may set `invitee_email`. On accept, the verified `email` claim is checked
   (case-folded) against the stored hint; mismatch → 403. Without email binding, any
   bearer of the link can join (by design — admin chose link-only invite).

4. **Token harvest from logs (invariant #2).**
   → The plaintext token is returned once in the create response and never logged. The
   stored `token_hash` is not reversible to the token. Tests grep-assert that the raw
   token never appears in log output.

5. **Replay: accept the same invite twice.**
   → The `accepted_at` column is updated atomically in the same transaction that inserts
   the user row. Concurrent accepts: the `user_tenant_index.sub` PRIMARY KEY rejects a
   duplicate binding; the first committer wins, the loser gets 409/403 (uniform error).

6. **Tenant squatting: attacker pre-registers a UUID to block a victim.**
   → Tenant UUIDs are server-minted (`crypto.randomUUID()`), never client-supplied. The
   `POST /tenants` body carries only `name`. No client input can influence the id.

7. **Unbound-state escape: attacker calls normal API while unbound.**
   → `JwtAuthGuard` rejects requests with `tenantId === null` with 403 Forbidden unless
   the route carries `@AllowUnbound()`. Only `POST /tenants`, `POST /tenants/invites/accept`,
   and `GET /me` carry the decorator. All other routes remain behind the full guard.

8. **WS unbound socket.**
   → The realtime gateway closes an unbound first-frame token with ws code 4403. No
   subscription is possible without a tenant binding.

9. **Privilege escalation: member grants themselves admin.**
   → `PATCH /tenants/members/:userId/role` is guarded by `AdminGuard`, which queries
   `users.role` inside `withTenant` (RLS-scoped). A `member` cannot call this endpoint.

10. **Last-admin lockout.**
    → Role change that would leave zero admins in the tenant is rejected (service-layer
    check before the UPDATE).

11. **Cross-tenant invite lookup.**
    → The `accept` path uses `withRouting()` (role `argus_app`, no `app.tenant_id`) to
    look up `tenant_invites` by `token_hash`. The SELECT is scoped to non-sensitive
    columns (id, tenant_id, expires_at, accepted_at, revoked_at, invitee_email). Once the
    invite's `tenant_id` is known, all further writes use `withTenant(found.tenantId)`.

12. **Flooding: mass tenant creation.**
    → Per-`sub` rate limit (5 creates/min). A global circuit breaker alerts if
    tenants-created-per-hour exceeds a threshold (monitoring, not a hard block).

## 4. Invariant check

- **#2 (no secret logging):** invite token plaintext never logged; token_hash is not
  a secret (useless without the pre-image). Verified by test grep-assert.
- **#3 (tenant context from verified binding):** `user_tenant_index` is the sole
  authority; populated only by the two code paths above; `sub` is IdP-signed.
- **#1/#6 (server crypto-blind, no admin content path):** onboarding handles no message
  content. Untouched.
- **#5 (secrets via Key Vault):** invite tokens are ephemeral in-memory values; no new
  secrets added to the config surface.

## 5. Decision: DB lookup replaces JWT claim

The Zitadel `tenant_id` claim is **removed** (Action deleted, claim read dropped from
`AuthService`). Tenant assignment is DB-authoritative. Rationale and rejected alternatives
are recorded in `auth-tenant-context.md` §3 threat-4 (updated). The previous carry-forward
requirement for a production multi-org Zitadel Action (§9 of that document) is superseded
by this design — no Action is needed.

## 6. Residual

- **True offboarding** (remove a member and their binding): v1 marks `users.status =
  'revoked'` but does not delete the `user_tenant_index` row (the app role has no DELETE
  grant). A revoked user cannot act (role checks fail at the service layer), but the index
  row persists. Full offboarding requires an owner-role migration step; deferred, documented.
- **Multi-tenant users** (one `sub` in two tenants): not supported by this design.
  `user_tenant_index.sub` is a PRIMARY KEY — one binding per identity. This is an
  intentional constraint for v1; if needed later it requires a schema change and a
  rethink of the unbound/bound guard semantics.
- **GlitchTip purge of expired invite rows**: expired invites accumulate; cleanup worker
  (pattern from attachment GC) is a follow-up.
