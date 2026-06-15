# Private-messenger redesign — implementation plan

> **Status:** plan only. No code in this PR. A separate session implements the phases below.
> **Branch for implementation:** `claude/brave-franklin-72kiqn` (or a fresh feature branch per phase).
> **Audience:** the engineer/agent who picks this up next. Read it top-to-bottom once before starting Phase 0.

---

## 1. Context — what & why

Today argus is enterprise-flavoured E2EE SaaS: login is **100% Zitadel OIDC**, there's a per-tenant **SSO**
module, self-serve **workspace creation**, **billing/plans**, and a browsable **member directory**. The owner
wants to turn it into a **simple, very private, invite-only messenger**:

- **Register** = redeem an admin-minted one-time **code** → set up a **passkey**. Nothing else.
- **Login** = **passkey only**. The API issues and verifies **its own** session tokens (Zitadel goes away).
- **Emergency** = a single **admin username + password** "breakglass", bootstrapped from Azure Key Vault.
- **Identity** = every user gets a stable, **immutable**, shareable **argus-id**.
- **Find people** = search by **exact argus-id only**; the browsable directory is removed.
- **Profile** = edit **display name** + pick a **generated avatar**. argus-id never changes.
- **Lost passkey** = **fresh start**: the admin issues a new code, the user re-registers as a new identity.

### Locked owner decisions
| # | Decision | Choice |
|---|----------|--------|
| 1 | Reload behaviour | **Stay logged in** — HttpOnly+SameSite=Strict refresh cookie (+ CSRF header); access token in memory only |
| 2 | Email | **Dropped entirely** — stop collecting; make `users.email` nullable; remove from `/me` + contracts |
| 3 | Avatars | **Generated only** — no uploads/blob storage; a small non-PII `avatar_seed` lets users change the picture |
| 4 | argus-id format | `argus-<16 unambiguous chars>-<animal>` e.g. `argus-k7m2q9x4f3n8p1w5-otter` (CSPRNG; reuse `HANDLE_ANIMALS`) |
| 5 | Login UX | Auto-try a discoverable passkey first; if none, "I have a registration code" → enter code → passkey setup |
| 6 | Local unlock | Derive the keystore-unlock key from the passkey via **WebAuthn PRF** (no separate passphrase) + fallback |
| 7 | Chat history | **Device-local only**; survives app updates; **fresh on a new device/reinstall**. Add `navigator.storage.persist()` |
| 8 | Admin surface | Reuse the **in-app AdminPanel** (codes/users/audit) behind admin login; keep **Grafana** for metrics |
| 9 | Breakglass | Admin **username + password**, Argon2id, lockout + audit; bootstrap creds from **Azure Key Vault** |
| 10 | Tenancy | **One shared user pool** (single default tenant under the hood); privacy via argus-id-only discovery |

---

## 2. Key architectural principle (keeps the change contained)

`auth.sub` is the **identity spine** woven through the whole backend: it is the PK of `user_tenant_index`, the
lookup key in `requireUser(tx, auth.sub)` (dozens of call sites), the match key in `AdminGuard`, the room key in
the WS gateway, and the audit `actorSub`. **Do not rip it out.** Preserve the shape `VerifiedAuth { sub, tenantId }`
and only change **what mints/verifies** the token and **what `sub` is**:

- **`sub` becomes `"argusid:" + argus_id`** (a self-minted, immutable subject). New users get a new spine value, so
  "lost passkey = fresh start = new identity" falls out for free (new sub → new `users`/`devices`/messages).
- Replace "Zitadel issues a JWT, we verify via JWKS" with "**we** mint our own EdDSA JWT after a passkey ceremony,
  and verify it with **our** key." This is a contained change at three seams: `auth.service.ts verify()`, the new
  token **minting**, and the **issuers** of `sub` (registration/login). `jwt-auth.guard.ts` and the WS gateway are
  untouched (they only call `verify()`).
- **Tenancy:** keep `tenant_id` + RLS everywhere (invariant #3). Bootstrap **one fixed `DEFAULT_TENANT_ID`** and
  bind every user to it. The deployment becomes effectively single-tenant; privacy comes from argus-id discovery +
  E2EE, not tenant walls. This is a few lines vs. a multi-month RLS teardown, and stays reversible.
- **Passkey ≠ MLS device keys.** Passkey = account/session auth (server stores the WebAuthn **public** key, which is
  fine for crypto-blindness — it's not message key material). MLS device signature key = per-device E2EE identity
  (client-side, sealed). They stay independent. Lost passkey = fresh start ⇒ new MLS identity too.

---

## 3. Codebase facts the implementer needs

**Auth (today):** `apps/web/src/lib/auth.ts` (oidc-client-ts, in-memory token), `AuthContext.tsx`, `Callback.tsx`.
API only *verifies* Zitadel JWTs: `apps/api/src/auth/auth.service.ts` `verify()` (jose, alg allowlist
`RS256/ES256/EdDSA`, issuer/audience from config). Global `jwt-auth.guard.ts` (deny-by-default); decorators
`@Public()`, `@AllowUnbound()`; `admin.guard.ts` re-reads role from DB. Tenant derived via `user_tenant_index`
(sub→tenant). RLS via `withTenant(tenantId)` / `withRouting()` in `apps/api/src/db/index.ts`. WS auth: first-frame
`auth` message → `realtime.gateway.ts` calls `auth.verify()`.

**Invite/code machinery already exists (reuse it):** `tenant_invites` table (32-byte token, SHA-256 hash at rest,
single-use atomic UPDATE, 7-day TTL); `tenants.service.ts` `createInvite()`/`acceptInvite()`; the
**`tenant_invites_accept_flow` RLS carve-out** (migration 0028) exposes exactly one row by a transaction-local
`app.invite_token_hash` GUC — the template for "look up a code before any session/tenant context exists".

**Enterprise bits to retire:** SSO module `apps/api/src/sso/*` + `tenant_sso_configs` (0019) + AdminPanel SSO tab;
self-serve `POST /tenants` + `CreateWorkspace.tsx`; billing module + Stripe webhook + `stripe_*`/`plan_*` columns;
`GET /users` directory (`users.controller.ts`, `UserService.list`). Zitadel in `compose.yaml`
(`zitadel`, `zitadel-db`, `zitadel-login`, `provision`) + `infra/local/zitadel/provision.sh`.

**User model:** `apps/api/src/db/schema.ts` `users` = `id`, `tenant_id`, `external_identity_id` (Zitadel sub),
`email`, `display_name` (pseudonymous "Adjective Animal", unique per tenant via `users_tenant_display_name_idx`,
0016), `status`, `role`. No argus-id, no profile-edit endpoint. Avatars are **client-generated** via `@dicebear`
(`apps/web/src/features/settings/argus-profile.ts`), not stored.

**E2EE / client storage (verified):** message history lives **device-local** in **IndexedDB, sealed** (keystore is
at schema **v5**, `apps/web/src/lib/keystore.ts`): `message-log` (sealed under a per-unlock session key),
`device`/`key-package-pool` (sealed under a passphrase via Argon2id), `group-state` (MLS ratchet). The server keeps
message **ciphertext** durably but is crypto-blind; **new devices can't decrypt pre-join messages** (MLS forward
secrecy). The **recovery flow is identity-only** (`recovery-ux.ts`: *"restores your identity for future messages
only, not past history"*) — `apps/web/src/features/recovery/*`, `key_backups` table (0006). The app does **not**
call `navigator.storage.persist()` (so IndexedDB can be evicted — add it).

**DB & migration conventions:** numbered forward-only `*.sql` in `apps/api/src/db/migrations/`, applied by the
**owner** role (RLS-bypassing) via `apps/api/src/db/migrate.ts` (simple protocol, dollar-quoted plpgsql OK),
auto-discovered (**next number = 0030**). Runtime role is **`argus_app`** (renamed from `secmes_app` by 0009). RLS
pattern: `nullif(current_setting('app.tenant_id', true), '')::uuid` + `enable`+`force` RLS + WITH CHECK + leading
`tenant_id` index + explicit per-table `grant`. Generators use `node:crypto.randomInt` (CSPRNG) — `Math.random` is
banned (`argus-no-insecure-random`). `tsconfig` has `noUncheckedIndexedAccess` (index access is `T | undefined`).

---

## 4. ⚠️ Gotchas found during a trial run of Phase 0 (save yourself the debugging)

1. **`argus_id NOT NULL` breaks ~25 raw `insert into users (...)` in specs** (rls, messaging-rls, push,
   key-directory, attachments, gdpr, key-backup, user.service, me.controller, …) that omit the column. **Fix:** add
   the column with a **volatile DB default** `DEFAULT gen_argus_id()`. A volatile default makes Postgres rewrite the
   table and evaluate the default **once per existing row** (distinct backfilled values, no manual DO-block), and it
   covers every raw insert. The app still passes its CSPRNG `argus-…-<animal>` value explicitly on real inserts.
2. **Immutability can't be a column-grant revoke** — `users` has **table-level UPDATE** granted to `argus_app`
   (0001), and Postgres can't subtract one column from a table grant. **Use a `BEFORE UPDATE` trigger** that raises
   if `argus_id` changes. (On `ON CONFLICT DO UPDATE` the trigger is fine: `NEW.argus_id = OLD.argus_id` since the
   SET clause never touches it, so repeat logins pass.)
3. **`noUncheckedIndexedAccess`** — `ALPHABET[randomInt(...)]` is `string | undefined`; add a `!` (randomInt
   guarantees an in-range index) or the build fails (`TS2532`).
4. **Adding a required `argusId` to `MeBoundSchema` ripples to two mocks** that are parsed by `MeSchema`:
   `apps/web/src/lib/api.spec.ts` (`establishSession` mock) and `apps/api/src/users/me.controller.spec.ts`. Update
   both.
5. **Some DB-integration specs are ALREADY STALE vs current code** (they `describe.skipIf(!DB_URL)`, so
   `pnpm -r test` is green without a DB, but they FAIL against a real Postgres). Confirmed failing today:
   `me.controller.spec.ts` test 1 asserts a **4-field `toEqual`** while the controller returns the
   `{ bound:true, …, role, plan }` union; test 2 expects a **thrown `NotFoundException`** for a cross-tenant lookup,
   but the controller returns **`{ bound:false }`** (RLS hides the row → `getByAuth` undefined → unbound). **When a
   phase touches `/me` or users, run the DB suite and fix these stale expectations** (don't assume green local =
   green CI-with-DB).
6. **Running the DB suite locally:** Docker Hub is rate-limited here; pull Postgres from the ECR mirror:
   `docker run -d --name argus-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=argus -p 55432:5432 public.ecr.aws/docker/library/postgres:16-alpine`
   then `export DATABASE_URL=postgres://postgres:postgres@localhost:55432/argus`,
   `pnpm --filter @argus/api db:migrate`, `pnpm --filter @argus/api test`. (`dockerd` may need `sudo dockerd &` first.)
7. **API surface changes** (e.g. `/me`) require regenerating `apps/api/openapi.json` (`pnpm --filter @argus/api openapi`
   / `/api-spec` skill) + the 42Crunch audit, per Definition of Done.

---

## 5. Phased plan

> One PR per phase. App must boot after each. Per phase run `pnpm -r typecheck && pnpm -r test && pnpm lint &&
> pnpm format:check`, plus the **DB suite against a real Postgres** when DB/endpoints change, plus `/code-review`
> and the matching reviewer subagent. **Write the threat-model note BEFORE coding** a security-relevant phase.
> **Do Phase 6 LAST** so a working auth fallback exists throughout.

### Phase 0 — Identity spine: `argus_id` (foundation, additive)
**Goal:** every user gets an immutable, system-generated argus-id, surfaced in `/me`. OIDC still active.
**Threat model:** `docs/threat-models/argus-id-identity.md`.
**Changes:**
- `apps/api/src/db/migrations/0030_argus_id.sql` — `gen_argus_id()` (plpgsql, unambiguous alphabet `23456789abcdefghjkmnpqrstvwxyz`, returns `argus-<16>-id` as the DB fallback); `alter table users add column argus_id text not null default gen_argus_id()`; `create unique index users_argus_id_idx on users (argus_id)`; immutability trigger (`users_argus_id_immutable` + BEFORE UPDATE). See gotchas #1, #2.
- `apps/api/src/users/argus-id.ts` (new) — `generateArgusId()` (CSPRNG `node:crypto.randomInt`, `argus-<16 chars>-<animal>` reusing `HANDLE_ANIMALS`, lowercased; `!` on index access per gotcha #3) + `argus-id.spec.ts`.
- `apps/api/src/db/schema.ts` — add `argusId: text('argus_id').notNull()` to `users`.
- `apps/api/src/users/user.service.ts` — add `argusId` to `SELECTION` + `UserRecord`; in `provisionFromToken`
  generate+insert `argusId` (3rd injectable param for tests); add `isArgusIdCollision` (pinned to
  `users_argus_id_idx`) to the retry `catch`.
- `apps/api/src/tenants/tenants.service.ts` — add `argusId: generateArgusId()` to both user inserts (createTenant,
  acceptInvite); add `isArgusIdCollision` to both retry loops.
- `packages/contracts/src/index.ts` — add `argusId: z.string()` to `MeBoundSchema`.
- `apps/api/src/users/me.controller.ts` — return `argusId` + add it to the OpenAPI response schema; regen openapi.
- Update mocks/specs per gotchas #4, #5 (`api.spec.ts`, `me.controller.spec.ts`).
**Done-when:** DB suite green against Postgres; `/me` returns `argusId`; an `UPDATE users SET argus_id=…` is
rejected by the trigger; every user row has a unique argus-id.
**Reviewers:** `security-boundary-auditor` (RLS, grants, trigger, no enumeration regression).

### Phase 1 — Self-minted session tokens (parallel-safe with Phase 2)
**Goal:** the API mints/verifies its own EdDSA JWTs; "stay logged in" via rotating refresh.
**Threat model:** `docs/threat-models/session-tokens.md`.
**Changes:**
- `auth_sessions` table (tenant-scoped, FORCE RLS, leading tenant_id index): `id`(sid), `tenant_id`, `user_id`,
  `refresh_token_hash` (SHA-256 at rest), `expires_at`, `created_at`, `last_used_at`, `revoked_at`.
- `apps/api/src/auth/session-key.config.ts` (new) — Ed25519 signing key from a Key Vault credential **file**
  (`SESSION_SIGNING_KEY_FILE`), fail-closed like `loadOidcConfig`; dev fallback = ephemeral keypair.
- `auth.service.ts verify()` — verify our JWT (`iss:argus`, `aud:argus-api`, `alg:EdDSA`); keep the `sub` →
  `user_tenant_index` lookup + `MaybeUnboundAuth` return shape unchanged. Drop the IdP email/name JIT claims.
- Mint/refresh(rotating, single-use, hashed)/logout endpoints; refresh delivered as **HttpOnly + Secure +
  SameSite=Strict** cookie scoped to the refresh path; require an `X-Argus-Refresh` header (CSRF). Access token
  10 min; refresh 30-day sliding.
- `auth.module.ts` — swap `OIDC_JWKS` provider for the session public key.
**Done-when:** verify() accepts our JWT and rejects alg-confusion/`none`/wrong-iss; refresh rotation is single-use;
logout revokes the `sid`; reload restores a session via the cookie. `jwt-auth.guard.ts` + WS gateway untouched.
**Reviewers:** `security-architect` (trust boundary), `crypto-reviewer` (EdDSA + refresh hashing/rotation),
`security-boundary-auditor` (cookie/CSRF, no token logging).

### Phase 2 — WebAuthn + registration-by-code
**Goal:** redeem a code → set up a passkey → first session; passkey login via discoverable credentials.
**Threat models (write first):** `docs/threat-models/passkey-auth.md`, `registration-and-tenancy.md`.
**Changes:**
- Add `@simplewebauthn/server` (api) + `@simplewebauthn/browser` (web) (one-line dep justification each).
- `webauthn_credentials` table (tenant-scoped, FORCE RLS): `id`, `tenant_id`, `user_id`, `argus_id`,
  `credential_id` (bytea, globally unique), `public_key` (bytea, COSE), `counter` (bigint), `transports`,
  `device_label`, `created_at`, `last_used_at`. Allow **multiple passkeys per user**.
- `webauthn_challenges` table — **no-RLS routing table** (like `user_tenant_index`; no tenant context at
  registration; holds only `ceremony_id`, `challenge_hash`, `purpose`, nullable `argus_id`, `expires_at`).
  Document the no-RLS justification in the migration comment.
- Bootstrap `DEFAULT_TENANT_ID` (fixed UUID constant + idempotent `tenants` insert). Bind all new users to it.
- Registration: `POST /auth/register/redeem { code }` (reuse the 0028 token-hash carve-out) → short-lived
  **redemption ticket** (don't create the user yet) → `/auth/webauthn/register/options` (set
  `userID = isoUint8Array.fromUTF8String(argus_id)` — SimpleWebAuthn requires `userID` as **bytes**, not a string,
  ≤64 bytes; `residentKey:'required'`, `userVerification:'required'`) → `/auth/webauthn/register/verify`: in ONE tx
  (mirroring `acceptInvite`) mark the code consumed, insert `users` (tenant=DEFAULT, generated argus-id + display
  name, **no email**), `user_tenant_index { sub:"argusid:"+argus_id }`, `webauthn_credentials`, then mint the
  first session.
- Login: `/auth/webauthn/authenticate/options` (empty `allowCredentials` → discoverable; user picks passkey, no
  typed id; decode the returned `userHandle` with `isoUint8Array.toUTF8String` to recover the argus-id) → `/verify`
  (look up by `credential_id` under `withTenant(DEFAULT_TENANT_ID)`, check+bump counter → clone detection: reject
  ONLY when the stored counter > 0 and the new counter ≤ it. Counters that stay at `0` are NORMAL for synced /
  platform passkeys (Touch ID, etc.) and must NOT be rejected, or every login after the first breaks) → mint session.
- **WebAuthn PRF** for local keystore unlock (decision #6): request the PRF extension at register/auth; derive the
  keystore-unlock key from the PRF output so there's **no separate passphrase**; fallback (generated local key +
  recovery artifact) for authenticators without PRF. Touches `apps/web/src/lib/keystore.ts` unlock path.
**Done-when:** full register flow works; expired/replayed challenge rejected; consumed code rejected; counter
regression rejected; login needs no typed id.
**Reviewers:** `security-architect`, `crypto-reviewer`, `security-boundary-auditor`.

### Phase 3 — Breakglass admin (username + password)
**Goal:** an emergency admin login that yields an admin session (never a content path).
**Threat model:** `docs/threat-models/breakglass-admin.md`.
**Changes:**
- `admin_credentials` table (tenant-scoped, FORCE RLS): `user_id`, `password_hash`, `salt`, `failed_attempts`,
  `locked_until`, `updated_at`. **Argon2id** via `@noble/hashes/argon2id` (already used for the key-backup KDF —
  no new dep) at interactive params (≈64 MiB / t=3 / p=1), unique CSPRNG salt.
- Bootstrap the initial hash from a Key Vault credential file (`ADMIN_BOOTSTRAP_HASH_FILE`), inserted once if the
  table is empty; rotate via an authenticated `POST /auth/breakglass/rotate`.
- `POST /auth/breakglass/login { username, password }` (`@Public`, throttled) → on success mint an admin-scoped
  session (Phase-1 machinery). Lockout after N failures (`locked_until`); **constant-time** path (verify against a
  dummy hash when the row is missing — no timing oracle); audit every attempt
  (`breakglass.login_succeeded/failed/locked`) with IP+UA metadata only.
**Done-when:** lockout after N; timing parity user-found vs not; audit rows present; admin-only; cannot read content.
**Reviewers:** `security-architect`, `crypto-reviewer`, `security-boundary-auditor`. **(Residual: the password is
the weakest link in an otherwise phishing-resistant design — call it out in the threat model.)**

### Phase 4 — Discovery by argus-id + profile editing
**Goal:** replace the directory with exact-match lookup; let users edit name + (generated) avatar.
**Threat models:** `docs/threat-models/discovery-by-argus-id.md` (+ supersede `user-directory.md`),
`profile-edit.md`.
**Changes:**
- Delete `GET /users` directory (`users.controller.ts`, `UserService.list`); add
  `GET /users/lookup?argusId=…` — **exact match only** (no LIKE/prefix/fuzzy), authenticated, hard rate-limited
  (`SENSITIVE_LIMITS.lookupUser`), **uniform not-found** (no oracle), returns `{ userId, argusId, displayName,
  avatarSeed }` and **never email**. The found `userId` feeds the **existing** conversation-create + MLS welcome
  flow unchanged (`createConversation([userId])`).
- `PUT /users/me { displayName?, avatarSeed? }` — Zod-validated (displayName 1–64 trimmed; `argus_id` not
  accepted). Add `avatar_seed text` column (non-PII) so "change profile picture" cycles the generated avatar;
  keep `@dicebear` client-side default (no blob storage, decision #3).
- Migration: drop `users_tenant_display_name_idx` (display_name becomes a free, non-unique nickname); make
  `users.email` nullable and **stop writing it**; add `avatar_seed`.
- Contracts: remove `UserSummary`/`UserDirectory` + `plan`/`ssoEnabled`/`email` from `/me`; add
  `UserLookupResult`; add `avatarSeed` to `/me`. Regen openapi + 42Crunch.
**Done-when:** lookup is exact-only + rate-limited + uniform 404; profile update rejects argus_id; no email in any
discovery/`/me` response.
**Reviewers:** `security-boundary-auditor` (enumeration resistance, RLS, no PII leak), `/api-spec`.

### Phase 5 — Frontend passkey client
**Goal:** replace the OIDC redirect with the passkey UX; add-by-argus-id; profile editing.
**Changes:**
- Replace `apps/web/src/lib/auth.ts` (drop `oidc-client-ts`); rewrite `AuthContext.tsx` (passkey login + boot
  restore via refresh cookie, in-memory access token); remove `Callback.tsx`/OIDC bits.
- New screens: auto-try-passkey-else-"I have a registration code" (decision #5) → passkey setup; breakglass admin
  login; **add-contact-by-argus-id** replacing the directory picker; profile edit (name + generated-avatar
  picker). Add `navigator.storage.persist()` on first unlock (decision #7).
- Update Playwright E2E (`apps/web/e2e/`) — the `e2e` job gates merges; grep e2e for any changed label/role first.
**Done-when:** E2E: register with a code → set up passkey → reload stays logged in → add a contact by argus-id →
send an E2EE message → breakglass admin login works (metadata only).
**Reviewers:** `/code-review`, E2E suite.

### Phase 6 — Decommission enterprise (LAST)
**Goal:** remove the now-dead enterprise surface; keep recoverable via git history.
**Changes:** delete SSO module + `tenant_sso_configs`; remove Zitadel from `compose.yaml` +
`infra/local/zitadel/provision.sh`; delete `POST /tenants` + `CreateWorkspace.tsx`; delete billing module +
Stripe webhook; remove plan/SSO gating + the AdminPanel SSO tab. Mark `per-tenant-sso.md` retired. **Leave inert
columns** (`stripe_*`, `plan_*`, `email`) rather than risky drops — clean up in a later dedicated migration.
**Done-when:** app boots with no Zitadel; no orphaned `@Public` routes; CI security scans green.
**Reviewers:** `infra-reviewer` (compose/secrets/EU-pinning, no dangling secret mounts), `security-boundary-auditor`.

---

## 6. Dependencies & sequencing
- **Phase 0 first** (spine). **Phase 1 ∥ Phase 2** prep; **Phase 3 ∥ Phase 4**. **Phases 1+2 before Phase 5**
  (client needs the endpoints). **Phase 6 last**.
- Every phase: CI green (ci · security · codeql) **and** both reviews (Codex + `@claude`) before merge; security
  phases (1–4, 6) also need the named reviewer subagent; Phase 5 needs the `e2e` job.

## 7. Open items to confirm with the owner during implementation
- **PRF unavailability fallback** (older authenticators): generated local key + recovery artifact — acceptable?
- **GDPR/erasure** path for `argus_id` and `webauthn_credentials` on account deletion (extend migration 0020 logic).
- **Breakglass alerting**: with email dropped, an out-of-band alert on breakglass login needs another channel (or none).
- **Admin/members view** fields after email removal (argus_id, display_name, role, created_at only).

## 8. End-to-end verification (after Phase 5)
Register with an admin code → set up a passkey (no passphrase) → reload keeps you logged in → look up a friend by
exact argus-id → start a conversation → exchange an E2EE message → on a new device, log in with the passkey and
confirm history starts fresh (device-local) → breakglass admin login reaches the admin panel (metadata only).
