# Idea D — Continuous profiling with Grafana Pyroscope

**Effort:** M  **Impact:** Medium  **Status:** [x] Implemented

---

## Problem

Logs, metrics, and traces tell you *that* something is slow. Continuous profiling tells you *which function* is burning CPU or allocating heap — without needing to reproduce the issue or run a manual profiler session.

Pyroscope integrates directly into the Grafana UI, so you can open the "Flame graph" panel next to a Tempo trace and see what the Node.js process was doing during that exact time window.

---

## Changes required

### 1. New service in `compose.prod.yaml`

```yaml
pyroscope:
  image: grafana/pyroscope:1.13.0
  restart: unless-stopped
  command: ['-config.file=/etc/pyroscope/pyroscope-config.yml']
  volumes:
    - ./infra/stack/observability/pyroscope:/etc/pyroscope:ro
    - pyroscope-data:/var/pyroscope
  read_only: true
  tmpfs: [/tmp]
  security_opt: [no-new-privileges:true]
  cap_drop: [ALL]
  deploy:
    resources:
      limits: { memory: 256m, cpus: '0.25' }
```

Add `pyroscope-data:` to the top-level `volumes` block. No published ports — Grafana queries `http://pyroscope:4040`.

### 2. New file: `infra/stack/observability/pyroscope/pyroscope-config.yml`

```yaml
server:
  http_listen_port: 4040

storage:
  backend: filesystem
  filesystem:
    dir: /var/pyroscope

compactor:
  block_retention: 72h  # profiles more ephemeral than logs

usage_report:
  reporting_enabled: false
```

### 3. New Grafana datasource: `infra/stack/observability/grafana/provisioning/datasources/pyroscope.yml`

```yaml
apiVersion: 1
datasources:
  - name: Pyroscope
    uid: argus-pyroscope
    type: grafana-pyroscope-datasource
    access: proxy
    url: http://pyroscope:4040
    editable: false
```

### 4. `apps/api/package.json`

Add the Pyroscope Node.js SDK (pull-mode — Pyroscope scrapes the process; no push from app code):

```json
"@pyroscope/nodejs": "^0.4.0"
```

### 5. New file: `apps/api/src/observability/profiling.ts`

```ts
// Loaded via --import alongside tracing.ts in the Dockerfile CMD.
// Exposes a pprof pull endpoint on :4041 (internal only).
// Pyroscope scrapes this endpoint; no data is pushed from app code.
import { init } from '@pyroscope/nodejs';

if (process.env['PYROSCOPE_SERVER_ADDRESS']) {
  init({
    serverAddress: process.env['PYROSCOPE_SERVER_ADDRESS'],
    appName: 'argus.api',
    tags: { version: process.env['IMAGE_TAG'] ?? 'dev' },
  });
}
```

Only starts if `PYROSCOPE_SERVER_ADDRESS` is set — zero-cost no-op in dev/CI.

### 6. `apps/api/Dockerfile`

Add `profiling.js` to the `--import` chain:

```dockerfile
CMD ["node", "--import", "./dist/observability/tracing.js", "--import", "./dist/observability/profiling.js", "dist/main.js"]
```

### 7. `compose.prod.yaml` — api service environment

```yaml
PYROSCOPE_SERVER_ADDRESS: 'http://pyroscope:4040'
```

### 8. Dashboard update: `infra/stack/observability/grafana/dashboards/argus-traces.json`

Add a "Flame graph" panel:

```json
{
  "type": "flamegraph",
  "datasource": { "uid": "argus-pyroscope" },
  "title": "CPU profile (same time window)",
  "targets": [
    {
      "profileTypeId": "process_cpu:cpu:nanoseconds:cpu:nanoseconds",
      "labelSelector": "{service_name=\"argus.api\"}"
    }
  ]
}
```

---

## Security notes

- The Pyroscope service has no published ports — only accessible from Grafana over the internal Docker network.
- Profiles contain function names and call stacks. They do not contain variable values, request bodies, or user data.
- `PYROSCOPE_SERVER_ADDRESS` is a non-secret internal address; it goes in the non-secret `environment` block.

---

## Verification

1. `docker compose exec pyroscope wget -qO- http://localhost:4040/ready` — should return `ready`.
2. Send traffic to the API for ~30 seconds.
3. In Grafana → Explore → Pyroscope datasource → select `argus.api` → choose `process_cpu` profile type → should see a flame graph.
4. Open `argus-traces.json` → the flame graph panel in the traces section should populate when a time range with traffic is selected.
