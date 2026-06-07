# Local auth (Zitadel OIDC)

How to run real OIDC login against a local **Zitadel** in the Docker stack. This is the dev stand-in
for managed Zitadel-on-AKS (roadmap checkpoint 9). The local stack uses Zitadel v4's split shape:
`zitadel` is the OIDC/API/JWKS server, and `zitadel-login` is the hosted Login V2 web UI.
Security rationale + threat model:
`docs/threat-models/auth-tenant-context.md` (§8 SPA flow, §9 this bootstrap). **Local creds here are
throwaways — never real secrets.**

## One-time setup

Zitadel routes instances by the `Host` header, so the issuer URL must resolve to the same place from
both the browser and the in-compose API. We use `http://zitadel:8080` everywhere; add the hosts entry
so your browser can resolve it:

```sh
echo '127.0.0.1 zitadel' | sudo tee -a /etc/hosts
```

## Bring it up

```sh
make up                                        # postgres, redis, minio, zitadel + provision OIDC
make migrate && make seed                      # apply the argus schema + seed the dev tenant
make api-dev                                   # API on :3000 (host; reads the generated OIDC env)
pnpm --filter @argus/web dev                   # http://localhost:5173  (separate terminal)
```

`make up` provisions Zitadel idempotently (project, SPA app, tenant-claim Action, and Login V2 base
URI) and writes the generated OIDC config to `.env.local` (API) and `apps/web/.env.local` (SPA) —
both gitignored. Re-run `make auth-provision` alone to re-sync after editing the provisioner.

> The API runs on the **host** (`make api-dev`), not the compose image: the self-contained API
> Dockerfile currently can't build (it `npm install`s without a lockfile, so drizzle-orm drifts to a
> version with non-compiling types). `make api-dev` builds from the pnpm workspace instead. The
> `/etc/hosts` line above is what lets the host API reach Zitadel's JWKS at `http://zitadel:8080`.

## Log in

| | |
|---|---|
| URL | http://localhost:5173 |
| User | `admin@argus-local.zitadel` |
| Password | `Password1!` |
| Zitadel console | http://zitadel:8080/ui/console |
| Zitadel Login V2 | http://zitadel:3001/ui/v2/login |

## How it works

- The SPA runs Authorization Code + PKCE against Zitadel (public client, no secret). The browser is
  redirected through `zitadel-login` for credential entry, while tokens still come from the Zitadel
  OIDC endpoints on `http://zitadel:8080`. The API validates
  the **JWT access token** offline against Zitadel's JWKS (`iss=http://zitadel:8080`, `aud=<project id>`).
- argus is multi-tenant and the API requires the tenant claim to be a **UUID** (`tenants.id`). Zitadel
  org ids are numeric, so a Zitadel **Action** (`infra/local/zitadel/provision.sh`) asserts a flat
  `tenant_id` claim (+ `email`/`name`) onto the access token at "Pre Access Token Creation". The value
  matches `DEV_TENANT_ID` seeded by `db:seed:dev`. On first login the API JIT-provisions the user into
  that tenant. (Real multi-org→tenant mapping is Phase 7 / G1.)

## Reset / troubleshooting

- **`make reset`** wipes all volumes (incl. Zitadel) and the generated `.env.local` files. Next `make up`
  re-initialises and re-provisions from scratch.
- **Login can't reach `zitadel:8080` or `zitadel:3001`** → the `/etc/hosts` line is missing, or
  `zitadel-login` is not running (`make ps`).
- **Login redirects to `/ui/v2/login` on port 8080 and returns 404** → rerun `make auth-provision`;
  it sets the Login V2 base URI to the separate `zitadel-login` container.
- **API returns 401 on every route** → `.env.local` wasn't generated; run `make auth-provision`, then
  restart the API (`make api-dev`) so it re-reads the OIDC env.
- The bootstrap PAT + machine key live only in the `zitadel-bootstrap` volume; they never leave the
  local stack and are not committed.
