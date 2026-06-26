# 02 - Should improve

> **Status:** PROPOSED 2026-06-26.
> These do not currently explain the Friends screen incident, but they make the observability stack noisy or
> misleading enough to slow down future incident response.

## 1. Stop Postgres exporter WAL permission spam

**Status:** [x] Diagnosed / [x] Implemented / [ ] Verified / [x] Merged

### Problem

Postgres logs and `postgres-exporter` logs repeat `permission denied for function pg_ls_waldir` every scrape
interval.

### Evidence

Loki showed repeated Postgres errors and exporter `collector failed name=wal` lines. The exporter runs as
`argus_app`, which should stay least-privilege.

### Plan

- [x] Prefer disabling the WAL collector for `postgres-exporter` unless WAL metrics are needed now.
- [x] Do not grant WAL monitoring privileges now; WAL metrics are not needed for current incident response.
- [x] Keep exporter credentials file-backed via `DATA_SOURCE_PASS_FILE`.

### Verification

- [ ] Postgres no longer logs `permission denied for function pg_ls_waldir`.
- [ ] Prometheus still scrapes basic Postgres metrics.
- [ ] No broad database privilege is granted to `argus_app`.

## 2. Fix Grafana dashboard provisioning error

**Status:** [x] Diagnosed / [x] Implemented / [ ] Verified / [x] Merged

### Problem

Grafana logs `failed to search for dashboards` with `readdirent /etc/grafana/dashboards: no such file or
directory`.

### Evidence

The repo has dashboards under `infra/stack/observability/grafana/dashboards`, and `compose.prod.yaml` mounts
that path into Grafana. The runtime error means the staged VM path or bind mount is missing or wrong.

### Plan

- [x] Confirm `deploy.sh` stages `infra/stack/observability/grafana/dashboards` into `/opt/argus`.
- [x] Fail deploy if the staged dashboard directory is missing or contains no dashboard JSON files.
- [x] Recreate Grafana during deploy when the bind-mounted provisioning or dashboard files change.
- [x] Keep dashboards read-only inside Grafana.

### Verification

- [ ] Grafana stops logging missing dashboard directory errors.
- [ ] The expected Argus dashboards load after deploy.

## 3. Make Alertmanager unarmed state quiet

**Status:** [x] Diagnosed / [x] Implemented / [ ] Verified / [x] Merged

### Problem

Alertmanager retries notification delivery against an empty or invalid webhook URL.

### Evidence

Loki showed `Notify for alerts failed` and `unsupported protocol scheme ""` for alert groups including
`RedisDown` and `ArgusCoturnDown`.

### Plan

- [x] Change unarmed Alertmanager behavior to a real null receiver, or template the config during deploy based
  on whether `alertmanager_webhook_url` is non-empty.
- [x] Preserve the file-backed webhook secret.
- [x] Document how to arm the webhook in the runbook.

### Verification

- [ ] Empty webhook secret produces no notification retry errors.
- [ ] Provisioned webhook sends firing and resolved notifications.

## 4. Fix Pyroscope write permissions

**Status:** [x] Diagnosed / [x] Implemented / [ ] Verified / [ ] Merged

### Problem

Pyroscope runs but cannot write some data under `/var/pyroscope`.

### Evidence

Loki showed permission errors such as `failed to CAS cluster seed key` and `mkdir /var/pyroscope/anonymous:
permission denied`.

### Plan

- [x] Check the Pyroscope image user and named-volume ownership expectation.
- [x] Fix the `pyroscope-data` volume ownership or set an explicit compatible runtime user.
- [x] Keep `read_only: true` for the container root filesystem and only make the data volume writable.

### Verification

- [ ] Pyroscope stops logging `/var/pyroscope` permission errors.
- [ ] API profiling data is visible in Grafana.
