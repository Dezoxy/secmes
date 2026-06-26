# 03 - Nice to have

> **Status:** PROPOSED 2026-06-26.
> These are polish and regression-prevention tasks. They should follow the Must Fix and Should Improve tracks.

## 1. Improve deploy-window UX for mobile clients

**Status:** [x] Diagnosed / [x] Implemented / [ ] Verified / [x] Merged

### Problem

A normal deploy can briefly disconnect `/ws` and return transient `502`s for API reads. The current UI can make
that look like user data disappeared.

### Plan

- [x] Add deploy-window-friendly retry messaging for transient API failures.
- [ ] Ensure websocket reconnect status and API refresh status use consistent copy.
- [ ] Consider a post-deploy refresh nudge when the app detects API recovery.

### Verification

- [ ] During a controlled API recreate, the UI says data is temporarily stale and recovers automatically.

## 2. Improve observability dashboards after service labels are fixed

**Status:** [x] Diagnosed / [x] Implemented / [ ] Verified / [x] Merged

### Problem

Even after labels are fixed, the dashboards should make common incident questions obvious: which service is
failing, what changed around deploy time, and whether alerts are real or scrape/config failures.

### Plan

- [x] Add service-grouped log panels for centralized Loki services: `api`, `caddy`, `redis-exporter`,
  `postgres-exporter`, `prometheus`, `grafana`, `alertmanager`, `pyroscope`, `loki`, and `alloy`.
- [x] Keep `coturn` out of centralized Loki storage; use local short-retention logs and Prometheus health
  signals for TURN triage.
- [x] Add quick filters for `level`, `service`, and `context`.
- [x] Add panels separating user-facing `5xx` from observability-service errors.

### Verification

- [ ] A deploy-window incident can be diagnosed from Grafana without manually mapping container IDs.

## 3. Add log-label regression checks

**Status:** [x] Diagnosed / [x] Implemented / [ ] Verified / [ ] Merged

### Problem

The current label regression was only visible after opening Grafana. A future config change could accidentally
return dashboards to opaque IDs.

### Plan

- [x] Add a lightweight config/static test for the Alloy relabel rules and Grafana dashboard queries.
- [x] Fail if dashboards use opaque container IDs as the primary service dimension.
- [x] Document the intended labels in the centralized logs threat model or observability README.

### Verification

- [ ] CI catches a dashboard or Alloy config regression before deploy.
