# Threat model — Phase 6: decommission Zitadel/OIDC + the enterprise surface

Phase 6 of `docs/planning/private-messenger-redesign-plan.md`. Passkey auth (Phases 0–5) is the sole login path; this
phase removes the now-dead Zitadel/OIDC machinery and the enterprise surface, and minimises stored PII. Ships
as two PRs:

- **PR1** — remove the OIDC verification path + all Zitadel infra (auth trust-boundary change).
- **PR2** — remove SSO / billing / plan-gating / self-serve workspace creation + the data-minimisation
  migration `0039` (null out all stored email; purge legacy subjects).

## What changes (security-relevant)

1. **Auth verification collapses from dual-accept to a single path.** `AuthService.verify()` previously tried
   the self-minted argus EdDSA token first, then fell back to Zitadel JWKS. PR1 removes the fallback: the only
   accepted token is an argus-minted `iss:argus / aud:argus-api / alg:EdDSA` JWT verified with our own key.
   Any other token (including a previously-valid Zitadel token) is now rejected `401`.
2. **The OIDC JIT provisioning path is removed.** `provisionFromToken`, the bare `POST/DELETE /auth/session`
   `AuthSessionController`, and `createTenant`/`acceptInvite` all required a verified `email` claim that only
   Zitadel tokens carried. With OIDC gone that claim is permanently absent, so these paths could only ever
   `400`/throw — they are deleted, not left inert.
3. **Email is dropped as a stored/exposed field.** The OIDC flow was the only writer of `users.email`. PR2
   nulls all existing `users.email` + `tenant_invites.invitee_email` and removes them from every response
   (contracts, `/me`, admin device list, member/invite lists, GDPR export).
4. **Membership gate becomes the admin-minted invite code only.** The freemium `memberLimit`/plan gate is
   removed; registration is gated solely by the single-use, delete-on-use invite code (unchanged mechanism).
5. **Zitadel is removed from prod + dev compose, Caddy ingress, the secret-fetch set, the deploy script, and
   Terraform/populate.** Reclaims ~1.8 GB RAM so the stack fits the 2–4 GB EC2 box.

## Invariant check (the 6 non-negotiables)

1. **Server crypto-blind** — unchanged. The passkey public key and session signing key are server-infra auth,
   never message-key material; no plaintext content is touched.
2. **No secrets/PII in logs** — `verify()` still surfaces neither the token nor jose error detail on failure.
   Email is removed from data at rest and in responses (strengthens this invariant).
3. **`tenant_id` + RLS on every tenant table** — no tenant table is added. `tenant_sso_configs` is dropped
   with its policy/grants atomically. `0039` UPDATE/DELETE run as the owner (migration role); the
   `DELETE FROM user_tenant_index WHERE sub NOT LIKE 'argusid:%'` touches only the no-RLS routing table and
   only legacy Zitadel subjects (active users already hold an `argusid:` binding).
4. **No hand-rolled crypto** — `verify()` still uses `jose` EdDSA verification (the accepted server-auth
   exception, consistent with the prior OIDC verification it replaces). No primitives added.
5. **Secrets from Key Vault as files** — unchanged; the 3 Zitadel secrets simply leave the mandatory fetch
   set. They are deleted from the live vault only *after* the new deploy verifies (rollback safety).
6. **No admin path to content** — unchanged. Removing SSO/billing/plan UI only shrinks the metadata surface.

## Residual risks & mitigations

- **`external_identity_id` stays `NOT NULL` + unique.** Nulling `email` and deleting legacy `user_tenant_index`
  rows touches neither identity nor that unique index (passkey users carry `external_identity_id =
  'argusid:'+argus_id`). Verified before the migration.
- **Mid-rollout secret mismatch.** A rollback to the prior image (which fetches the Zitadel secrets as
  mandatory) only stays possible while those secrets remain in the vault — so they are deleted last.
- **Inert columns left behind** (`plan_*`, `stripe_*`, `users.email`, `external_identity_id`) — a deliberate
  reversible choice over risky drops; a future dedicated migration can drop them.
- **Single auth path = single point of failure.** An absent/empty `argus-session-signing-key` makes the API
  unbootable (fail-closed, by design). The key must be present in Key Vault before deploy.
