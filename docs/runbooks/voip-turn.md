# Runbook: TURN relay (coturn) — ArgusCoturnDown

Fires when `up{job="coturn"} == 0` for ≥ 2 minutes. All relay-only calls fail while coturn is down.

---

## Immediate triage

```bash
# 1. Is the container running?
docker compose -f /opt/argus/compose.prod.yaml ps coturn

# 2. Last 50 log lines
docker logs --tail 50 coturn

# 3. Is port 3478 reachable locally?
turnutils_stunclient 127.0.0.1
```

Common failure modes:

| Symptom in logs | Likely cause | Fix |
|---|---|---|
| `FATAL: could not resolve external-ip` | IMDS unreachable and `ARGUS_TURN_EXTERNAL_IP` unset | Set the env var (see below) |
| `secret file not found` or `permission denied` on `/run/secrets/turn_shared_secret` | Secret not provisioned / Key Vault fetch failed | Re-run `argus-secrets.service` |
| `certificate file not found` | TLS cert/key secret missing | Re-run `argus-secrets.service` |
| Exit immediately, no log | Corrupt combined config on tmpfs | Force-recreate (see below) |

---

## Fix: IMDS unreachable (external-ip resolution fails)

Set `ARGUS_TURN_EXTERNAL_IP=<public-ip>/<private-ip>` in the environment the deploy script sources, then restart:

```bash
# Find the IPs
TOKEN=$(curl -sX PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token)
PUB=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
PRIV=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)
echo "ARGUS_TURN_EXTERNAL_IP=${PUB}/${PRIV}"

# Set in the deploy env, then restart
docker compose -f /opt/argus/compose.prod.yaml up -d --no-deps coturn
```

---

## Fix: Secret fetch failure

```bash
systemctl restart argus-secrets.service
# Wait for it to succeed (check journalctl -u argus-secrets.service)
docker compose -f /opt/argus/compose.prod.yaml up -d --no-deps coturn
```

---

## Fix: Force-recreate (last resort)

**WARNING: this drops every active relayed call.**

```bash
docker compose -f /opt/argus/compose.prod.yaml up -d --force-recreate --no-deps coturn
```

Only do this if `docker compose up -d` (without `--force-recreate`) fails to recover the container.

---

## Verify recovery

```bash
# Healthcheck should go green within 40s
docker compose -f /opt/argus/compose.prod.yaml ps coturn
# Expected: coturn   ... healthy

# Prometheus scrape should recover (check after ~1m)
curl -s http://localhost:9090/api/v1/query?query=up{job="coturn"} | jq '.data.result[0].value[1]'
# Expected: "1"
```

---

## Notes

- coturn runs as `nobody` (uid 65534), `cap_drop: ALL`, `read_only: true`. Never restart it as root.
- The combined config (turnserver.conf + static-auth-secret) is written to a tmpfs `/var/tmp/turnserver-combined.conf` by the entrypoint; it is lost on container restart — this is intentional (secret never persists to disk).
- The prometheus metrics endpoint (9641) is host-local only; not in the NSG. The `ArgusCoturnDown` alert fires on scrape failure, not on an external health check.
- TLS cert renewal: `caddy` sends a SIGHUP to the `coturn` container by name after cert rotation — coturn reloads the cert file without dropping existing sessions.
