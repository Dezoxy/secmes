# Runbook: Arm GlitchTip error tracking

GlitchTip is fully deployed (three services: `glitchtip-db`, `glitchtip`, `glitchtip-worker`). The Sentry SDK in the API has proper scrubbing configured and is gated on `SENTRY_DSN_FILE`. Until the DSN secret is provisioned, error tracking is a complete no-op — all exceptions are swallowed silently.

---

## Prerequisites

- The stack is running (`docker compose -f compose.prod.yaml ps` shows `glitchtip` as healthy).
- You have operator identity access (Cloudflare Access → GlitchTip subdomain).
- You have write access to the Azure Key Vault (`az keyvault secret set`).

---

## Steps

### 1. Access GlitchTip

Navigate to `https://glitchtip.4rgus.com`. Cloudflare Access will challenge for an operator identity — authenticate with your approved identity provider.

### 2. Create an organization and project

1. On first access, create an organization: name it `argus`.
2. Create a new project:
   - **Platform:** Node.js
   - **Name:** `argus-api`

### 3. Copy the DSN

Go to **Project Settings → Client Keys**. Copy the DSN. It will look like:

```
https://<key>@glitchtip.4rgus.com/<project-id>
```

### 4. Provision the secret in Azure Key Vault

```bash
az keyvault secret set \
  --vault-name <keyvault-name> \
  --name "argus-sentry-dsn" \
  --value "<paste DSN here>"
```

Replace `<keyvault-name>` with the `ARGUS_KEY_VAULT` value from the deploy environment.

### 5. Restart the API to pick up the new credential file

```bash
docker compose -f /opt/argus/compose.prod.yaml up -d --no-deps api
```

The `fetch-keyvault-secrets.sh` script will have seeded an empty `sentry_dsn` file on first boot. After provisioning the Key Vault secret, restart the `argus-secrets.service` unit to refresh it, then restart the api:

```bash
systemctl restart argus-secrets.service
docker compose -f /opt/argus/compose.prod.yaml up -d --no-deps api
```

### 6. Verify

Trigger a deliberate 500-class error (for example, send an authenticated request to a non-existent endpoint that causes an unhandled exception in a service). Wait up to 30 seconds, then open GlitchTip → **Issues** — the error should appear with a stack trace.

Confirm the following fields are **absent** from the GlitchTip issue detail (scrubbed by `beforeSend` / `beforeBreadcrumb`):
- `Authorization` header value
- Cookie values
- Query string parameters
- Any field whose key matches `token`, `password`, `secret`, `key`, or `dsn`

---

## Notes

- `SENTRY_RELEASE` is set from `IMAGE_TAG` in `compose.prod.yaml` — GlitchTip groups errors by release automatically.
- GlitchTip's user registration is disabled. Only operators with Cloudflare Access can reach the UI.
- The scrubbing configuration is in `apps/api/src/observability/error-tracking.ts`.
- The DSN secret is delivered as a Docker secret file mount (`/run/secrets/sentry_dsn`) — it never appears in `docker inspect` output.
