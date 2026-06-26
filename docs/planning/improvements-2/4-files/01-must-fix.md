# 01 - Must fix

> **Status:** PROPOSED 2026-06-26.
> These are user-visible failures, false critical alerts, or observability blockers that will hurt incident
> response if left as-is.

## 1. Grafana/Loki service labels show container IDs

**Status:** [x] Diagnosed / [x] Implemented / [ ] Verified / [x] Merged

### Problem

Grafana Explore shows opaque values such as `8a5ce1a06f8a...` and `61060bc4b48c...` under the `service`
dimension. Those are Docker container IDs, not service names.

### Evidence

`infra/stack/observability/alloy/config.alloy` tails `/var/lib/docker/containers/*/*-json.log` and derives only
a `container` label from the log path. Loki label discovery showed `container` and `service_name` values as
container IDs.

### Plan

- [x] Preserve the no-Docker-socket model.
- [x] Add safe Docker `json-file` log attributes for Compose service metadata.
- [x] Update `infra/stack/observability/alloy/config.alloy` to extract stable low-cardinality `service` and `service_name` labels
  such as `service="api"` / `service="caddy"` / `service="redis-exporter"`.
- [x] Keep the raw container ID available as a secondary drill-down label or structured metadata, not the
  primary dashboard dimension.
- [x] Update Grafana log dashboards to filter and group by the readable service label.

### Verification

- [ ] In Grafana Explore, the primary service values are human-readable Compose service names.
- [ ] Loki still ingests logs after an API/Caddy deploy recreate.
- [ ] No Docker socket is mounted into Alloy.

## 2. Friends refresh keeps stale UI after deploy-window API failures

**Status:** [x] Diagnosed / [x] Implemented / [ ] Verified / [x] Merged

### Problem

The Friends screen showed `0 accepted friends` and `Could not refresh friends - data may be stale` during the
`aws-v0.8.16` rollout, even though the database still had one accepted friendship.

### Evidence

Loki showed Caddy `502` responses for `/api/friends`, `/api/friends/requests`, `/api/me/settings/privacy`, and
`/ws` while the API container was stopped and recreated. Postgres and Redis stayed healthy. `friendships`
still had `accepted | 1`.

### Plan

- [x] Make `refreshFriends()` in `apps/web/src/features/chat/ChatContext.tsx` in-flight guarded so overlapping
  triggers share one request set.
- [x] Preserve the last known-good friends list on transient network, `502`, or deploy-window failures.
- [x] Add a short retry/backoff for transient failures.
- [x] Keep the warning visible, but make it clear data is temporarily stale instead of implying no friends exist.
- [x] Add or update E2E coverage for a transient `/api/friends` failure.

### Verification

- [ ] With `/api/friends` returning one transient `502`, the previous accepted friends remain visible.
- [ ] The retry succeeds after the endpoint recovers.
- [ ] The Friends screen does not replace known-good friend data with an empty state on transient failure.

## 3. Friends request refresh hits `429`

**Status:** [x] Diagnosed / [x] Implemented / [ ] Verified / [ ] Merged

### Problem

The API returned repeated `429` for `GET /friends/requests` before the deploy window.

### Evidence

Loki showed multiple `level=warn` request-completed lines for `/friends/requests` with `statusCode: 429`.
The route uses `@Throttle(perMinute(SENSITIVE_LIMITS.friendsList))`; `friendsList` is currently `30/min`.
The client refresh path requests accepted friends plus incoming and outgoing friend requests together.

### Plan

- [x] First fix client-side duplicate refreshes with an in-flight guard.
- [x] Audit all `refreshFriends()` triggers: tab open, manager initialization, friend-request websocket event,
  mutations, and app resume if present.
- [x] Add a short client-side freshness window for normal tab refreshes so repeated opens reuse the recent read
  instead of re-querying `/friends/requests`.
- [x] Force refreshes after mutations and friend-request websocket events so real state changes are still visible
  immediately.
- [x] Keep `SENSITIVE_LIMITS.friendsList` unchanged unless deduped normal use still approaches the cap.
- [x] Keep mutation limits tighter than read limits.

### Verification

- [ ] Opening Friends repeatedly does not produce `429`.
- [ ] Incoming friend-request websocket events do not stampede `/friends/requests`.
- [ ] API rate limits still protect friend mutations.

## 4. Redis exporter crash loop creates false `RedisDown`

**Status:** [x] Diagnosed / [ ] Implemented / [ ] Verified / [ ] Merged

### Problem

`argus-prod-redis-exporter-1` was restarting continuously, while Redis itself was healthy.

### Evidence

Docker showed `redis-exporter` with more than 1000 restarts. Logs repeatedly said:
`Error loading redis passwords from file /run/secrets/redis_password`.
Prometheus fired `RedisDown`.

### Plan

- [ ] Patch `compose.prod.yaml` to use the Redis exporter's supported raw password-file flag or environment
  wiring correctly.
- [ ] Keep the Redis password file-backed; do not move it into an environment value.
- [ ] Confirm the exporter can authenticate against Redis without exposing the password in `docker inspect`.

### Verification

- [ ] `redis-exporter` stays running across several scrape intervals.
- [ ] Prometheus reports `up{job="redis"} == 1`.
- [ ] `RedisDown` clears.

## 5. coturn scrape failure creates false `ArgusCoturnDown`

**Status:** [x] Diagnosed / [ ] Implemented / [ ] Verified / [ ] Merged

### Problem

Prometheus fired `ArgusCoturnDown` while the coturn container was healthy.

### Evidence

Prometheus logs said the coturn scrape target sent a blank `Content-Type`, so Prometheus could not determine
the scrape protocol. The coturn healthcheck itself was healthy.

### Plan

- [ ] Add the Prometheus 3 fallback scrape protocol setting to the coturn scrape job in
  `infra/stack/observability/prometheus/prometheus.yml`.
- [ ] Keep coturn internal/host-local scraping only; do not publish a metrics port.
- [ ] Confirm the alert description does not claim the relay is down when the scrape parser is the failure.

### Verification

- [ ] Prometheus reports `up{job="coturn"} == 1`.
- [ ] `ArgusCoturnDown` clears.
- [ ] coturn remains healthy and no active relay config is unnecessarily recreated.
