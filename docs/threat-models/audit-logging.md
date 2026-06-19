# Threat model: tenant-scoped audit logging

> Status: **RATIFIED 2026-06-19.** Covers roadmap checkpoint 16 — an append-only `audit_events` log of authentication/security events. Builds on `rls-tenant-isolation.md` (tenant scoping) and `auth-tenant-context.md` (where the verified actor/tenant come from). Ratification was gated on the retention prune (review finding F1/AR-1), now shipped: the `argus_prune` role + the `argus-audit-prune` systemd timer (migration `0043`). The append-only model also carries two narrow, audited grant exceptions — see §3.1 (the GDPR erasure `DELETE` from `0021` and the column-scoped metadata `UPDATE` from `0043`).

## 1. Feature & data flow

A protected request (already through the JWT guard, so tenant + `sub` are **verified**) triggers an audit write: `auth.login` on `POST /auth/session`, `auth.logout` on `DELETE /auth/session`. `AuditService.record()` inserts one row inside `withTenant(verifiedTenantId)` — so the write is RLS-scoped to the actor's tenant. A row holds **IDs + metadata only**: `event_type`, verified `actor_sub`, source `ip`, `user_agent`, a small non-sensitive `metadata` jsonb, `created_at`. **No message content, tokens, keys, passphrases, or `Authorization` headers ever enter the log.** The server remains crypto-blind; audit data is metadata, never plaintext.

## 2. Assets & trust boundaries

- **Assets:** the integrity of the audit trail (it must be trustworthy for forensics) and the metadata it holds (actor ids, IPs = personal data under GDPR).
- **Boundaries:** tenant↔tenant (one tenant must never see another's audit rows); app-code↔database (even a compromised app role must not be able to *rewrite history*); subject↔retention (PII must not linger past its purpose).

## 3. Threats (STRIDE-lite)

1. **Tampering — log forgery / cover-up (primary).** A bug or a compromised `argus_app` role edits or deletes audit rows to hide activity. → **Append-only by grant, with two narrow GDPR exceptions.** `argus_app` gets `SELECT`+`INSERT`, plus exactly two privileges added for data-subject rights, neither of which enables a cover-up: (a) **`DELETE`** (migration `0021`) used only by the Art. 17 erasure flow to remove rows where the erased user was the *actor*; (b) **column-scoped `UPDATE (metadata)`** (migration `0043`) used only by the same flow to scrub a third party's `metadata.targetArgusId` when the erased user was the lookup *target* (ER-1). **The integrity columns that prove who-did-what — `event_type`, `actor_sub`, `ip`, `created_at` — remain non-updatable by `argus_app`**, so it can never rewrite an event's meaning or attribution; a metadata scrub under an erasure obligation is the opposite of a cover-up. Retention `DELETE` runs out-of-band as the least-privilege `argus_prune` role (it cannot touch in-window rows at all). Tested with a negative case: `argus_app` `UPDATE` of `metadata` succeeds, but `UPDATE` of `event_type`/`actor_sub`/`created_at` still fails (`db/audit-prune-rls.spec.ts`).
2. **Information disclosure — cross-tenant audit read.** Tenant A reads B's audit trail. → `tenant_id` + `ENABLE`/`FORCE` RLS + `WITH CHECK`, same as every tenant table; writes only via `withTenant`.
3. **Information disclosure — sensitive data in the log.** Someone logs a token/content/PII into `metadata` or a free field. → Hard rule + review: `metadata` is **non-sensitive context only**; no token/header/content/key fields exist on the table; the service never receives the raw token.
4. **Spoofing — forged actor.** An attacker records events as another user/tenant. → `actor_sub` and `tenant_id` come **only** from the verified token (never request body), via the same guard as `/me`.
5. **Elevation / DoS — unbounded growth or audit flooding.** → **90-day retention, now enforced (F1/AR-1).** The `argus-audit-prune` systemd timer runs daily and, as the least-privilege `argus_prune` role, deletes `audit_events` older than 90 days (and `auth_sessions` expired > 30 days). The prune is cross-tenant but, by RLS policy (`0043`), can only ever see/delete rows **past** their window — never a live/in-window row of any tenant. (This realizes what earlier drafts described as a "per-tenant worker prune"; the shipped design is a single time-windowed cross-tenant sweep, cleaner than per-tenant iteration.) The `(tenant_id, created_at desc)` index keeps reads cheap. Rate-limiting of the session endpoints is deferred to checkpoint 46.

## 4. Invariant check

- **#1 crypto-blind / #6 no admin content:** upheld — audit holds metadata only, never content; nothing here exposes message text.
- **#2 no secret logging:** the core design — no tokens/keys/passphrases/headers in any column.
- **#3 RLS:** `audit_events` has `tenant_id` + FORCE RLS + policy + leading index.
- **#4 no hand-rolled crypto / #5 Key Vault:** N/A (no crypto, no secrets). No tension with any invariant.

## 5. Decision & mitigations

- Table: `audit_events(id, tenant_id, event_type, actor_sub, ip, user_agent, metadata, created_at)`; `ENABLE`+`FORCE` RLS; `WITH CHECK` on `current_setting('app.tenant_id')`; index `(tenant_id, created_at desc)`.
- **Grants to `argus_app`: `SELECT, INSERT`, plus the two GDPR exceptions** — `DELETE` (`0021`, actor-scoped erasure) and column-scoped `UPDATE (metadata)` (`0043`, ER-1 target scrub). No `UPDATE` of integrity columns. **Retention** is a separate least-privilege role, `argus_prune` (`0043`): `SELECT, DELETE` on `audit_events`/`auth_sessions`, RLS-gated to past-window rows only, driven by the `argus-audit-prune` systemd timer.
- `actor_sub`/`tenant_id` from the verified token; writes only via `withTenant`.
- **GDPR (EU):** auth-event metadata (incl. IP) is processed under legitimate interest for security; **90-day retention** (now enforced by `argus_prune`) bounds it; recorded in `docs/gdpr/article-30-records.md`.
- **Reviewer:** `security-boundary-auditor` (+ `infra-reviewer` for the timer/role). **Tests** (`db/audit-prune-rls.spec.ts`, `users/gdpr.service.spec.ts`): insert+readback under tenant; cross-tenant audit read returns zero; **append-only boundary** (`argus_app` metadata `UPDATE` allowed, integrity-column `UPDATE` fails); `argus_prune` sees/deletes only past-window rows across tenants but not in-window rows; ER-1 erasure scrubs `targetArgusId` from another actor's row while preserving the event.

## 6. Residual risk

- **Append-only is enforced by grant, not by storage** — an owner/superuser (migrations, DBA) can still rewrite rows. True write-once (e.g. an external WORM sink) is out of scope for beta; the grant model stops the *application* from tampering, which is the realistic threat.
- **The ER-1 metadata-`UPDATE` grant narrows the append-only invariant** for `argus_app` — but only on the `metadata` column, only the integrity columns matter for tamper-evidence, and they stay immutable. The exception exists solely to honour Art. 17 erasure and is GDPR-owner-cleared. Net: a strictly smaller surface than "the app can rewrite the log".
- **ER-1 erasure is tenant-scoped.** The target-id scrub removes the erased user's argus-id only from audit rows in *their own* tenant. If the same argus-id was probed from a different tenant, that row persists — consistent with argus's single-tenant erasure model; accepted unless the GDPR owner objects.
- **Retention is true in code at merge, enforced once the timer arms at deploy.** A merged-but-not-yet-deployed state has the prune in code, not running; the `argus-audit-prune` timer arms in `deploy.sh` step 5c and a connectivity probe gates the deploy. Pre-existing backups still hold unbounded history and age out under the 30-day B2 backup retention — there is no retroactive scrub of historical backups.
- **IP is personal data** retained 90 days; accepted under legitimate interest, revisit in the GDPR pass.
- **No pre-auth failure auditing** (failed logins have no verified tenant, so they can't be tenant-scoped) — those belong in a separate security log, deferred.
