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
| `FATAL: could not resolve a valid private-ip` | `hostname -i` returned nothing/loopback and `ARGUS_TURN_PRIVATE_IP` unset | Set `ARGUS_TURN_PRIVATE_IP=<vm-private-ip>` in the deploy env, restart |
| `secret file not found` or `permission denied` on `/run/secrets/turn_shared_secret` | Secret not provisioned / Key Vault fetch failed | Re-run `argus-secrets.service` |
| `certificate file not found` | TLS cert/key secret missing | Re-run `argus-secrets.service` |
| Calls connect then die ~1 s; `channel bind: error 403 (Forbidden IP)` | Same-server relay peer-ACL not allowing the VM's own private IP | Confirm the entrypoint logged `peer-ACL: allow private <ip> …`; if not, set `ARGUS_TURN_PRIVATE_IP` and restart (see [Verify same-server relay](#verify-same-server-relay)) |
| Exit immediately, no log | Corrupt combined config on tmpfs | Force-recreate (see below) |

---

## Fix: IMDS unreachable (external-ip resolution fails)

Set `ARGUS_TURN_EXTERNAL_IP=<public-ip>/<private-ip>` in the environment the deploy script sources, then restart.

**On AWS EC2 (IMDSv2):**

```bash
TOKEN=$(curl -sX PUT -H "X-aws-ec2-metadata-token-ttl-seconds: 60" http://169.254.169.254/latest/api/token)
PUB=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)
PRIV=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/local-ipv4)
echo "ARGUS_TURN_EXTERNAL_IP=${PUB}/${PRIV}"
```

**On Azure:**

```bash
PUB=$(curl -s -H 'Metadata: true' \
  'http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/publicIpAddress?api-version=2021-02-01&format=text')
PRIV=$(curl -s -H 'Metadata: true' \
  'http://169.254.169.254/metadata/instance/network/interface/0/ipv4/ipAddress/0/privateIpAddress?api-version=2021-02-01&format=text')
echo "ARGUS_TURN_EXTERNAL_IP=${PUB}/${PRIV}"
```

Then set the env var and restart:

```bash
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

# Prometheus scrape should recover (check after ~1m). Run from inside the container
# because Prometheus has no published port (internal Docker network only).
docker compose -f /opt/argus/compose.prod.yaml exec prometheus \
  wget -qO- 'http://localhost:9090/api/v1/query?query=up%7Bjob%3D%22coturn%22%7D' \
  | grep -o '"value":\[.*\]' | head -1
# Expected: last element is "1" — e.g. "value":[1782403715,"1"]
# Alternatively, open Grafana → Explore → Prometheus → run: up{job="coturn"}
```

---

## Verify same-server relay

Relay-only V1 needs both call legs to relay through this one coturn, which requires the
`--allowed-peer-ip=<own-private-ip>` exception (see `voip-turn.md` §3.1). To confirm it works
end-to-end (this is what actually breaks a call even when the healthcheck is green):

```bash
# Mint a credential from the live secret and run a same-server client-to-client relay.
docker exec coturn sh -c 'S=$(cat /run/secrets/turn_shared_secret); \
  turnutils_uclient -y -W "$S" -u relaycheck -n 6 -m 1 $(hostname -i | awk "{print \$1}")'
# PASS signal: NO "channel bind: error 403 (Forbidden IP)" line — the ACL permits the hairpin.
# NOTE: run on-box, the media path loops to our own public IP, which AWS does not hairpin back, so
# tot_recv_msgs may be 0 even on a healthy relay. That is a test-only artifact — real external
# clients enter via the public IP normally. The 403's absence is the authoritative check here;
# end-to-end media is confirmed by an actual phone-to-phone call (see relay-port tcpdump below).

# Confirm the entrypoint resolved and applied the peer-ACL flags:
docker logs coturn 2>&1 | grep -E 'peer-ACL: allow private'
# Expected: peer-ACL: allow private <private-ip> (same-server relay), deny public <public-ip> (self-loopback)
```

If you see the 403, the relay is up but no relay-only call can connect. Check that
`ARGUS_TURN_PRIVATE_IP` (or `hostname -i`) yields the VM's real private IP, then restart coturn.

---

## Notes

- coturn runs as `nobody` (uid 65534), `cap_drop: ALL`, `read_only: true`. Never restart it as root.
- The combined config (turnserver.conf + static-auth-secret) is written to a tmpfs `/var/tmp/turnserver-combined.conf` by the entrypoint; it is lost on container restart — this is intentional (secret never persists to disk).
- The prometheus metrics endpoint binds `0.0.0.0:9641` (coturn 4.6.2 has no localhost-bind option under `network_mode: host`); it is kept off the internet by the NSG/SG (9641 is never opened), and being TCP it is unreachable via the UDP relay. The `ArgusCoturnDown` alert fires on scrape failure, not on an external health check. Tightening the bind is a tracked follow-up (`voip-turn.md` §3.1).
- TLS cert renewal: `caddy` sends a SIGHUP to the `coturn` container by name after cert rotation — coturn reloads the cert file without dropping existing sessions.
