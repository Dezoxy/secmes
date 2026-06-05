# Threat model: tenant-scoped audit logging

> Status: **DRAFT for ratification.** Covers roadmap checkpoint 16 — an append-only `audit_events` log of authentication/security events. Builds on `rls-tenant-isolation.md` (tenant scoping) and `auth-tenant-context.md` (where the verified actor/tenant come from).

## 1. Feature & data flow

A protected request (already through the JWT guard, so tenant + `sub` are **verified**) triggers an audit write: `auth.login` on `POST /auth/session`, `auth.logout` on `DELETE /auth/session`. `AuditService.record()` inserts one row inside `withTenant(verifiedTenantId)` — so the write is RLS-scoped to the actor's tenant. A row holds **IDs + metadata only**: `event_type`, verified `actor_sub`, source `ip`, `user_agent`, a small non-sensitive `metadata` jsonb, `created_at`. **No message content, tokens, keys, passphrases, or `Authorization` headers ever enter the log.** The server remains crypto-blind; audit data is metadata, never plaintext.

## 2. Assets & trust boundaries

- **Assets:** the integrity of the audit trail (it must be trustworthy for forensics) and the metadata it holds (actor ids, IPs = personal data under GDPR).
- **Boundaries:** tenant↔tenant (one tenant must never see another's audit rows); app-code↔database (even a compromised app role must not be able to *rewrite history*); subject↔retention (PII must not linger past its purpose).

## 3. Threats (STRIDE-lite)

1. **Tampering — log forgery / cover-up (primary).** A bug or a compromised `secmes_app` role edits or deletes audit rows to hide activity. → **Append-only by grant:** `secmes_app` gets `SELECT`+`INSERT` only — **no `UPDATE`/`DELETE`**. Mutation/retention runs out-of-band (owner/maintenance role). Tested with a negative case (app role update/delete must fail).
2. **Information disclosure — cross-tenant audit read.** Tenant A reads B's audit trail. → `tenant_id` + `ENABLE`/`FORCE` RLS + `WITH CHECK`, same as every tenant table; writes only via `withTenant`.
3. **Information disclosure — sensitive data in the log.** Someone logs a token/content/PII into `metadata` or a free field. → Hard rule + review: `metadata` is **non-sensitive context only**; no token/header/content/key fields exist on the table; the service never receives the raw token.
4. **Spoofing — forged actor.** An attacker records events as another user/tenant. → `actor_sub` and `tenant_id` come **only** from the verified token (never request body), via the same guard as `/me`.
5. **Elevation / DoS — unbounded growth or audit flooding.** → 90-day **retention** (per-tenant worker prune); `(tenant_id, created_at desc)` index keeps reads + prune cheap. Rate-limiting of the session endpoints is deferred to checkpoint 46.

## 4. Invariant check

- **#1 crypto-blind / #6 no admin content:** upheld — audit holds metadata only, never content; nothing here exposes message text.
- **#2 no secret logging:** the core design — no tokens/keys/passphrases/headers in any column.
- **#3 RLS:** `audit_events` has `tenant_id` + FORCE RLS + policy + leading index.
- **#4 no hand-rolled crypto / #5 Key Vault:** N/A (no crypto, no secrets). No tension with any invariant.

## 5. Decision & mitigations

- Table: `audit_events(id, tenant_id, event_type, actor_sub, ip, user_agent, metadata, created_at)`; `ENABLE`+`FORCE` RLS; `WITH CHECK` on `current_setting('app.tenant_id')`; index `(tenant_id, created_at desc)`.
- **Grants: `SELECT, INSERT` only to `secmes_app`** (append-only). Retention `DELETE` is a maintenance-role job.
- `actor_sub`/`tenant_id` from the verified token; writes only via `withTenant`.
- **GDPR (EU):** auth-event metadata (incl. IP) is processed under legitimate interest for security; **90-day retention** bounds it; goes into the `privacy-model.md` processing record (USER decision pending — 90d is the working default).
- **Reviewer:** `security-boundary-auditor`. **Tests:** insert+readback under tenant; cross-tenant audit read returns zero; **append-only negative** (app role `UPDATE`/`DELETE` fails); login/logout endpoints record the right event with no sensitive fields.

## 6. Residual risk

- **Append-only is enforced by grant, not by storage** — an owner/superuser (migrations, DBA) can still rewrite rows. True write-once (e.g. an external WORM sink) is out of scope for beta; the grant model stops the *application* from tampering, which is the realistic threat.
- **IP is personal data** retained 90 days; accepted under legitimate interest, revisit in the GDPR pass.
- **No pre-auth failure auditing** (failed logins have no verified tenant, so they can't be tenant-scoped) — those belong in a separate security log, deferred.
