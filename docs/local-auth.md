# Local auth (passkey)

argus login is **passkey-only** — the API mints and verifies its own EdDSA session tokens; there is no
external IdP. (Zitadel/OIDC was decommissioned in Phase 6 — see
`docs/threat-models/phase-6-decommission.md`.) This doc covers running auth locally.

## Bring up the stack

```sh
make up                                        # postgres, redis, minio
make migrate && make seed                      # apply the argus schema + seed the dev tenant
make api-dev                                   # API on :3000 (host; ephemeral dev session key)
pnpm --filter @argus/web dev                   # http://localhost:5173  (separate terminal)
```

No `/etc/hosts` entry and no IdP provisioning are needed anymore.

## Session signing key (dev)

`make api-dev` leaves `SESSION_SIGNING_KEY_FILE` unset, so the API generates an **ephemeral Ed25519
keypair** at startup (see `apps/api/src/auth/session-key.config.ts`). Sessions therefore reset whenever you
restart the API — fine for development. In production the key is delivered from Key Vault
(`argus-session-signing-key`).

## Two ways to log in locally

1. **Demo mode (no real WebAuthn ceremony)** — the Playwright E2E suite runs this way
   (`apps/web/playwright.config.ts` sets `VITE_DEMO_MODE=1`). To use it by hand, start the web dev server
   with `VITE_DEMO_MODE=1 pnpm --filter @argus/web dev`. The client skips the passkey ceremony and the
   protected API still requires a valid session token — good for UI work, not for exercising the real
   WebAuthn path.

2. **Real passkey against a seeded invite code** — register the way a real user does:
   - Create an invite code (admin-minted). With no admin UI session yet, insert one directly against the
     dev DB, or use the breakglass admin login (`docs/threat-models/breakglass-admin.md`) once its hash is
     provisioned, then mint a code via the admin panel.
   - On `http://localhost:5173`, choose "I have a registration code", enter it, and create a passkey
     (your browser/OS authenticator; `WEBAUTHN_RP_ID=localhost` works for `localhost` origins).
   - Reload stays logged in via the HttpOnly refresh cookie.

## Reset / troubleshooting

- **`make reset`** wipes all data volumes and any local override `.env.local` files.
- **API returns 401 on every route** → the access token expired or the API restarted (ephemeral dev key);
  log in again. There is no OIDC env to configure.
- **Passkey registration fails in the browser** → the WebAuthn RP ID must match the page origin. Locally
  that is `localhost` (the `make api-dev` default); a non-localhost dev host needs `WEBAUTHN_RP_ID` set to
  match.
