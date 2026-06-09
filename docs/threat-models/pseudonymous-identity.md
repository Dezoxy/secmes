# Threat model: pseudonymous identity (generated handles + avatars)

> Status: **DRAFT for ratification.** Roadmap **#44b**. Replaces the IdP-derived display name with a
> server-generated pseudonymous handle (`Adjective Animal`) and a deterministic generated avatar. Slice 1
> (this note) is the **server** half: handle generation + per-tenant uniqueness. Slice 2 is the client avatar
> (local `@dicebear/*`, deterministic from the user id — no external image fetch).

## 1. Feature & data flow

Today JIT provisioning sets `users.display_name = <IdP token `name`/`preferred_username`>`, leaking the
identity provider's real-name into the in-app directory. #44b makes the display identity **pseudonymous**:

- On a user's **first** provision, the server generates a handle by picking — with a **CSPRNG**
  (`node:crypto.randomInt`) — one of 200 adjectives × 200 animals (40 000 combinations) and stores it as
  `display_name`. The IdP `name` claim is **no longer used** for display.
- Uniqueness is **server-authoritative**: a `unique (tenant_id, display_name)` index + regenerate-on-conflict
  guarantees no two users in a tenant share a handle. The client cannot choose or set its own handle.
- An **existing** user keeps their handle across logins (only `email` is refreshed from the IdP).
- (Slice 2) the avatar is generated **client-side** from the user's stable id via the local `@dicebear` npm —
  no request to `api.dicebear.com`, no external image, EU-safe.

`display_name` is **metadata** (not message content); it already lives on the RLS-scoped `users` table and is
already surfaced intra-tenant by the directory (`GET /users`). The server still sees only metadata + ciphertext.

## 2. Assets & trust boundaries

- **Assets:** the pseudonymous handle (display identity, intra-tenant visible); the IdP real-name (now **not**
  persisted as display); the per-tenant handle-uniqueness invariant.
- **Boundaries:** IdP ↔ server (the token `name` is dropped for display — only the verified `sub`/`email` are
  used); server ↔ tenant (RLS); user ↔ user (the directory shows handles within a tenant).

## 3. Threats (STRIDE-lite)

- **Information disclosure — IdP real-name leaks into the app.** Today's behavior persists the IdP `name` as the
  display name, exposing it to every tenant member via the directory. → Fixed: display is a generated handle;
  the real-name claim is never stored as `display_name`. (The verified `email` is still stored — it is the
  provisioning identity, already covered by `user-directory.md`'s intra-tenant-enumeration analysis.)
- **Spoofing — two users share a handle (impersonation within a tenant).** → `unique (tenant_id, display_name)`
  + regenerate-on-conflict makes handles unique per tenant. (Handles are **display only**, never an auth
  identity — authn/authz ride the verified `sub`, so a handle collision could never escalate auth anyway.)
- **Tampering — a client picks a vanity/duplicate handle.** → Generation is **server-side** from a CSPRNG; the
  client never supplies the handle. The DB unique index is the backstop even against a server bug.
- **Cross-tenant:** impossible — the unique index and all reads are `(tenant_id, …)` under FORCE RLS.

## 4. Invariant check

1. **Crypto-blind server** — unaffected; handles are metadata, not content.
2. **No secret logging/persistence** — a handle is a pseudonymous display label, not a secret; no keys/tokens.
3. **RLS** — `users` already has `tenant_id` + FORCE RLS; the new index is `(tenant_id, display_name)`
   (tenant-scoped uniqueness). No new table.
4. **No hand-rolled crypto** — handle generation uses `node:crypto.randomInt` (a **CSPRNG**) only to pick list
   indices; it is random *selection*, not a cryptographic protocol or key material, so it stays in `apps/api`
   (not `packages/crypto`) and satisfies the `argus-no-insecure-random` ban. No `Math.random`.
5. **Secrets via Key Vault** — N/A.
6. **No admin content path** — N/A.

## 5. Decision & mitigations

Server generates the handle on first provision (CSPRNG, 200×200 lists), enforces `unique (tenant_id,
display_name)` with bounded regenerate-on-conflict, preserves an existing user's handle, and still refreshes
`email`. Migration `0016` first NULLs any DUPLICATE legacy `(tenant_id, display_name)` (keeping the earliest)
so the unique index can build, then adds the index (NULLs distinct); a NULLed/legacy-NULL handle is then healed
to a fresh handle on next login (`coalesce(display_name, <new handle>)`). **Gated by:** `security-boundary-auditor`
(provisioning + migration + RLS), Semgrep (`argus-no-insecure-random`), and the service tests (uniqueness,
conflict-retry, existing-user-keeps-handle, NULL-handle-healing).

## 6. Residual risk

- **Handle-pool exhaustion** — 40 000 combinations per tenant; beyond that, generation would retry until the
  bounded attempt cap and then error. Acceptable for current scale; a future numeric suffix or larger lists
  lifts the ceiling. Logged as a TODO in `handle-words.ts`.
- **Legacy display names** — a pre-#44b user with a NON-duplicate IdP-derived `display_name` keeps it until they
  next log in (the client treats `display_name` as nullable, and a duplicate one was NULLed by 0016 then healed
  on login). So a legacy real-name can linger on an inactive account until its owner next authenticates. No
  production data exists yet (local-first build); a one-shot backfill-to-handles migration is a future option if
  a deployment ever carries legacy names.
- **Handles are guessable/enumerable intra-tenant** — intended for a team directory; cross-tenant is blocked by
  RLS. Same posture as `user-directory.md`.
