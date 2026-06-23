# Idea G — GlitchTip arming runbook + deployment annotations

**Effort:** S  **Impact:** Low-Medium  **Status:** [x] Implemented

---

Two independent improvements, both small.

---

## G1 — GlitchTip DSN arming runbook

### Problem

GlitchTip is fully deployed (three services: `glitchtip-db`, `glitchtip`, `glitchtip-worker`). The Sentry SDK in the API has proper scrubbing and is gated on `SENTRY_DSN_FILE`. But the DSN secret is not provisioned, so error tracking is a complete no-op in production — exceptions are swallowed silently.

### What to create: `docs/runbooks/arm-glitchtip.md`

The runbook should cover these steps (documentation only — no code changes needed):

1. **Access GlitchTip:** Navigate to `https://glitchtip.4rgus.com` (protected by Cloudflare Access — requires operator identity).
2. **Create an organization and project:**
   - Organization: `argus`
   - Project: `argus-api`, platform: `Node.js`
3. **Copy the DSN:** From Project Settings → Client Keys → copy the DSN value (format: `https://<key>@glitchtip.4rgus.com/<project-id>`).
4. **Provision the secret in Azure Key Vault:**
   ```bash
   az keyvault secret set \
     --vault-name <keyvault-name> \
     --name "argus-sentry-dsn" \
     --value "<paste DSN here>"
   ```
5. **Restart the API** to pick up the new credential file:
   ```bash
   docker compose up -d --no-deps api
   ```
6. **Verify:** Trigger a test error (e.g., hit an endpoint with invalid input that causes a 500) and confirm it appears in GlitchTip within 30 seconds.

### Notes

- The API's `error-tracking.ts` already reads `SENTRY_DSN_FILE` and applies full scrubbing (`beforeSend`, `beforeBreadcrumb`, key/value redaction). No code changes needed.
- `SENTRY_RELEASE` is set from `IMAGE_TAG` — GlitchTip will group errors by release automatically.
- Keep GlitchTip's registration disabled (already configured) — operators access it via Cloudflare Access only.

---

## G2 — Deployment annotations on Grafana dashboards

### Problem

When a metric or error rate shifts after a deploy, correlating it to the deployment is manual ("what was deployed around 14:30?"). Grafana annotations mark deployments as vertical lines on every time-series panel automatically.

### What to add: deploy script or GitHub Actions step

After `docker compose up -d` completes successfully in the deploy script, POST an annotation to Grafana:

```bash
# Read the Grafana admin password from the credential file
GRAFANA_PASSWORD=$(cat /run/secrets/grafana_admin_password)

curl -s -X POST "http://grafana:3000/api/annotations" \
  -H "Content-Type: application/json" \
  -u "admin:${GRAFANA_PASSWORD}" \
  -d "{
    \"text\": \"Deployed ${IMAGE_TAG}\",
    \"tags\": [\"deploy\", \"api\"],
    \"time\": $(date +%s%3N)
  }"
```

This posts to the Grafana HTTP API over the internal Docker network — no external exposure.

### Result

Every time-series panel in every dashboard shows a vertical dashed line at the deployment moment. When a p95 latency spike or error-rate increase appears, you can immediately see whether it coincides with a deploy.

### Notes

- The `grafana_admin_password` secret is already mounted into the Grafana container (it's how Grafana's `GF_SECURITY_ADMIN_PASSWORD__FILE` is set). The deploy script needs access to the same file.
- The annotation is tagged `deploy` so it can be filtered or hidden per-panel if needed.
- If the CD pipeline runs in GitHub Actions via `az vm run-command`, the `curl` step runs inside the VM as part of the deploy command — the Docker network is accessible there.

---

## Verification

### G1
- After provisioning the DSN and restarting the API, trigger a deliberate 500 error.
- Open GlitchTip → Issues → the error should appear within 30 seconds with a stack trace.
- Confirm the scrubbed fields (authorization header, cookies, query string) do NOT appear in the GlitchTip issue detail.

### G2
- Deploy a new IMAGE_TAG.
- Open `argus-api-overview.json` in Grafana.
- A vertical line labelled "Deployed <tag>" should appear at the deployment time on all time-series panels.
