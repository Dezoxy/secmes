# Threat model: metrics & observability (checkpoint 47)

> Status: **DRAFT for ratification.** Covers the observability stack (roadmap Phase 6, checkpoint 47):
> Prometheus + Grafana + Alertmanager, fed by a Prometheus `/metrics` endpoint on the API. Built in slices:
> **Slice A (this note's first deliverable)** is the API instrumentation — a content-blind metrics endpoint on
> a separate internal port. **Slice B** adds the Prometheus/Grafana/Alertmanager Docker-Compose services
> (gated, like the rest of the VM stack). Extends `vm-ingress.md` (ingress) + `audit-logging.md` (the
> IDs/metadata-only logging rule, which metrics follow too).

## 1. Feature & data flow

```
api ──(in-process)──▶ prom-client default registry
   HTTP interceptor records: http_requests_total{method,route,status} + http_request_duration_seconds (histogram)
   default metrics: process CPU / RSS / event-loop lag / GC  (NO app data)
        │
        ▼  served on a SEPARATE internal port (:9090, 0.0.0.0 on the Docker network only — NOT :3000, NOT routed by Caddy)
   GET /metrics  ──scrape──▶ Prometheus (Slice B, internal) ──▶ Grafana (dashboards) / Alertmanager (alerts)
```

Metrics are **aggregate numbers + low-cardinality labels** describing traffic *shape* — request counts, latency
histograms, process stats. They never carry message content, keys, tokens, passphrases, PII, tenant data, or
raw request paths/query strings. The HTTP label is the **route TEMPLATE** (`/conversations/:id/messages`),
never the concrete path (no UUIDs) and never the query string. The server stays crypto-blind; observability
sees how much/how fast, not *what*.

## 2. Assets & trust boundaries

- **Assets:** the `/metrics` surface (operational metadata); Grafana (dashboards + its admin credential);
  Prometheus' stored series; alert notification channels.
- **Boundaries:**
  - **`/metrics` is internal-only** — a separate listener on `:9090` bound to the Docker network, **not** the
    app's `:3000`, **not** proxied by Caddy, **no published host port**. Only Prometheus (same internal
    network) reaches it. (Defense-in-depth vs. accidentally exposing it through the public `/api/*` route.)
  - **Grafana is an admin surface** → behind **Cloudflare Access** on an admin subdomain (identity at the
    edge) + its own login; never public. Its admin password comes from Key Vault.
  - **Alertmanager** is internal; any notification (webhook/SMTP) carries IDs/severity/counts only — never
    content. Its receiver credentials come from Key Vault.

## 3. Threats (STRIDE-lite)

- **Information disclosure (the primary risk):** metrics that embed content/secrets/PII would breach
  invariant #2. Mitigations: labels are a fixed, low-cardinality set (`method`, route **template**, `status`)
  — no path params, **no query string**, no user/tenant identifiers, no headers/bodies. Nothing on the
  message/key path is ever instrumented with its value. Default process metrics carry no app data. `/metrics`
  is unreachable publicly (separate internal port).
- **Spoofing / elevation:** `/metrics` is unauthenticated but only reachable on the internal network, so
  there's no public principal to spoof. Grafana sits behind Cloudflare Access **and** its own auth.
- **Tampering:** scrape is read-only; Prometheus/Grafana/Alertmanager run as hardened containers (non-root,
  no-new-privileges, cap_drop, no published ports) in Slice B.
- **DoS / cardinality:** unbounded label values (e.g. per-path or per-tenant labels) would blow up series
  count. Using the bounded route-template set caps cardinality; per-tenant breakdowns are deferred.

## 4. Invariant check

1. **Server crypto-blind** — metrics are counts/latencies/process stats; message content + keys are never
   instrumented. ✔
2. **No secret/content logging or persistence** — labels are method + route template + status only (no query,
   no IDs, no content, no tokens); Grafana admin + alert-receiver creds come from Key Vault; alert payloads
   are content-free. Metrics follow the same "IDs/metadata only" rule as logs (`audit-logging.md`). ✔
3. **Tenant isolation** — metrics are not tenant data; no per-tenant **data** is exposed. If a per-tenant
   *count* is ever added it stays a count (never content) and must not enable cross-tenant enumeration —
   deferred for now to also bound cardinality. ✔ (noted)
4. **No hand-rolled crypto** — N/A. ✔
5. **Secrets via Key Vault** — Grafana admin password + any Alertmanager receiver secret are Key-Vault
   credential files (Slice B), never committed/env-at-rest. ✔
6. **No admin path to content** — Grafana/Prometheus expose operational metadata only; never message text or
   images (invariant #6). ✔

## 5. Decision & mitigations

**Slice A:** add `prom-client`; a global HTTP interceptor records request count + latency keyed on
`{method, route-template, status}`; `collectDefaultMetrics()` adds process stats; serve the registry on a
**separate internal port** (`METRICS_PORT`, default 9090) via a tiny standalone listener — outside the Nest
app's guards and outside Caddy's routes. Tests assert the output exposes the HTTP/process metrics **and**
contains no secret/content/raw-id/query material, and that the route label is a template. Gate:
**`security-boundary-auditor`** (the new server surface — exposure + no content/secret leak).

**Slice B:** Prometheus + Grafana + Alertmanager as hardened, no-published-port Compose services; Grafana
behind Cloudflare Access; admin/receiver secrets from Key Vault; dashboards + SLOs + alert rules. Gate:
**`infra-reviewer`** (container hardening, no public data ports, secret delivery, EU region).

## 6. Residual risk

- **Route-template cardinality** is bounded by the fixed route set; a future dynamic-route explosion would
  need a guard, but the current surface is static. Acceptable.
- **`/metrics` is unauthenticated**, so its ENTIRE authorization story rests on a single infra fact: the
  `:9090` listener has **no published host port and is not routed by Caddy**. That is a single point of
  failure — adding a `9090:` mapping to any compose file, or a Caddy route to it, silently turns it into a
  public, unauthenticated operational-metadata endpoint. Guarded today by a comment on the `api` service +
  the fact that it's a non-Nest port; a CI assertion that `:9090` is never published would harden it further.
  If it ever must be exposed beyond the host network, add scrape auth (bearer/mTLS) first.
- **Dashboards / SLOs / alert thresholds** can only be tuned against real traffic — finalized post-arming.
- **Per-tenant SLO breakdown** deferred (cardinality + isolation). Acceptable for this phase.
- **read-only root FS untested on the prom/grafana images** — prod is the first place they run read-only-root
  (data goes to named volumes that inherit the image's runtime-user ownership on first init; only `/tmp` is a
  tmpfs). A write outside those would crash-loop, which the deploy's `wait_running` gates catch loudly (fails
  closed). Smoke-test in a scratch env before arming; drop `read_only` for a service that can't tolerate it.
