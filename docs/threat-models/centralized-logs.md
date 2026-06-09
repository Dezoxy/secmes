# Threat model: centralized logs (Loki + Alloy — #47b)

> Status: **DRAFT for ratification.** Roadmap Phase 6 #47b. Self-hosted **Loki** (log store) + **Grafana
> Alloy** (collector) on the VM, queried in the **existing Grafana** (#47). **Build-only / gated** — added to
> `compose.prod.yaml` like #47's Prometheus/Grafana/Alertmanager; **no published ports**, deploys with the
> stack at arming. Complements #47 metrics (*how often*) and #48 error tracking (*which line/release*): logs
> are *what happened*. Mirrors the crypto-blind, IDs/metadata-only posture of `observability.md`.

## 1. Feature & data flow

```
api / caddy / … (stdout, Docker json-file driver)
        │  /var/lib/docker/containers/<id>/<id>-json.log   (root:root 0640)
        ▼  read-only bind mount, NO Docker socket
   Alloy (collector, uid 0, cap_drop ALL)  ──parse json + SCRUB (defense-in-depth)──▶
        ▼  push (internal network, no published port)
   Loki (store, filesystem, 7d retention, no auth — internal)
        ▼  query (internal)
   Grafana (#47 — the ONLY ingress, grafana.4rgus.com behind Cloudflare Access)
```

Argus app logs are **IDs / metadata / status only** by existing discipline (the NestJS `Logger` / audit log /
metrics all log ids + status, never content) and are enforced by the Semgrep banned-log-pattern rules. #47b
does **not** change *what* is logged — it **centralizes** the same already-scrub-safe lines. The collector
adds an Alloy **scrub stage** (mask bearer/JWT/presigned-URL shapes) purely as defense-in-depth before a line
persists. Message bodies are E2EE ciphertext the server never logs; the log stream carries none of it.

## 2. Assets & trust boundaries

- **Assets:** the log **stream + store** (IDs/metadata; the risk surface is a buggy log line carrying content
  or a secret); the integrity/availability of Loki.
- **Boundaries:**
  - **container stdout → Alloy** — Alloy reads **all** containers' json logs from a `:ro` mount of
    `/var/lib/docker/containers`. It uses **NO Docker socket** (a socket mount is daemon-root-equivalent — the
    rejected alternative; see §5). It runs as **uid 0** only because those log files are `root:root 0640`;
    `cap_drop:[ALL]` + read-only rootfs + the read-only log mount bound it (no daemon control, no escalation).
  - **Alloy → Loki → Grafana** — intra-VM Docker network, no published ports. Loki has no auth (internal
    only), same posture as Prometheus in #47.
  - **operator/admin ↔ Grafana/Loki** — admins see log **metadata** (ids, status, code paths), never message
    content (invariant #6); the app's logging discipline + the Alloy scrub keep content out of the store.

## 3. Threats (STRIDE-lite)

- **Info-disclosure — a log line carries content/secret (THE risk).** A bug logs message plaintext, a key, a
  token, or a presigned URL → Loki now **persists + centralizes** it. → Layered: (1) the app logs IDs/metadata
  only (discipline + Semgrep banned-log-pattern gate); (2) an Alloy **scrub stage** masks bearer/JWT/presigned
  shapes before write (defense-in-depth, mirrors the #48 scrubber); (3) **7-day retention** bounds exposure;
  (4) Grafana is gated by Cloudflare Access. Not provable for an arbitrary novel string — best-effort + the
  upstream discipline is the real control.
- **Elevation via the collector.** Alloy runs as uid 0. → Contained: `cap_drop:[ALL]` (no `DAC_OVERRIDE` etc.;
  it reads its logs via the owner bit, needs no caps), `no-new-privileges`, **read-only root FS**, the log dir
  mounted **read-only**, and crucially **no Docker socket** — so a compromised Alloy can read logs but cannot
  control the daemon, other containers, or the host.
- **Tampering / Spoofing — forged log lines.** Anything that can write to a container's stdout is already
  inside that container; Loki ingest is internal-only. No app-integrity impact.
- **Info-disclosure of secrets at rest.** Loki has no auth, but it is internal-only (no published port) and
  stores metadata. No credential is introduced (no Loki password; Grafana's admin password is the #47 Key
  Vault file).
- **DoS — log volume floods Loki/disk.** → Loki retention (7d) + per-stream limits; the VM disk is the bound,
  same as Prometheus TSDB. Alloy positions volume avoids re-ingesting on restart.

## 4. Invariant check (CLAUDE.md ×6)

1. **Crypto-blind server** — ✅ logs carry code paths + ids, never ciphertext/content; no decryption added.
2. **No secret/plaintext logging or persistence** — ✅ the central tension. #47b centralizes logs that are
   **already** IDs/metadata-only by app discipline (Semgrep-gated); the Alloy scrub stage masks secret-shaped
   values as belt-and-suspenders; 7d retention bounds any slip. Loki persists only what the app already emits.
3. **tenant_id + RLS** — N/A (no schema/table). A tenant id may appear as a log label — an opaque id, metadata.
4. **No hand-rolled crypto** — ✅ none; intra-VM HTTP, no new crypto.
5. **Secrets via Key Vault as files** — ✅ no new secret. Loki/Alloy have no credentials; Grafana keeps its
   #47 Key-Vault admin-password file. No secret in env or committed.
6. **No admin path to content** — ✅ Grafana/Loki expose log metadata only; the discipline + scrub guarantee
   content never reaches the store.

## 5. Decision & mitigations

Ship Loki + Alloy as **gated** Compose services (no published ports; deploy with the stack at arming), the
Alloy collector config (file-tail, no socket, scrub stage), the Loki monolithic/filesystem config (7d
retention, no auth), and a **Loki datasource** provisioned into the existing Grafana. Must-hold:

- **No Docker socket** — Alloy file-tails `/var/lib/docker/containers:ro`. (The socket is daemon-root-equiv;
  even `:ro` on a Unix socket doesn't restrict API calls — rejected.)
- **Collector hardening** — uid 0 (to read root logs) **but** `cap_drop:[ALL]`, `no-new-privileges`,
  read-only root FS, read-only log mount. Loki runs non-root (image default), `cap_drop:[ALL]`, read-only FS.
- **No published host ports** on Loki/Alloy (the compose-guard CI check enforces it); Grafana stays the only
  ingress, behind Cloudflare Access.
- **Scrub stage** — mask bearer/JWT/presigned-URL shapes in Alloy before write (defense-in-depth for #2).

Reviewer: **infra-reviewer** (Compose, the Alloy/Loki config, the no-socket + uid-0 trade-off, ingress
posture). Gates: `docker compose config -q` + the compose-guard (no published ports), Checkov, gitleaks,
Semgrep. Enables nothing — deploys at arming alongside #47.

## 6. Residual risk

- **Alloy runs as uid 0** to read root-owned container logs. → Accepted: it is the bounded alternative to a
  Docker socket (which is strictly worse). `cap_drop:[ALL]` + read-only rootfs + read-only log mount + no
  socket mean it can read logs and nothing more. Rootless log collection on a single Docker host has no clean
  answer without the socket; revisit if the host moves to rootless Docker / a different runtime.
- **A buggy log line could persist a secret/content for up to the 7-day retention** before compaction drops
  it. → Mitigated by the app discipline + Semgrep + the Alloy scrub; accepted as best-effort, same class as
  the #48 residual. A periodic audit of stored logs at arming is the follow-up.
- **Lossy label enrichment** — without the socket, each entry is labeled by its **container id** (derived from
  the log path via `discovery.relabel`, so every container is its own Loki stream), not a friendly compose
  service name. → Acceptable for a first slice (queryable per container / content / time); mapping ids to
  friendly service names is a follow-up.
- **First-run backfill of pre-existing container logs.** Alloy reads each new `*-json.log` from the start
  (`tail_from_end = false`) so per-deploy boot/crash-loop startup lines — the highest-value logs for debugging
  a failed rollout — are captured every deploy (the alternative, `tail_from_end = true`, would skip them, since
  Docker creates a fresh log path per container). The cost is a one-time backfill of pre-existing logs on first
  arming. → Bounded: Loki's `reject_old_samples` (7d) + retention (7d) drop anything older than the window, the
  ingestion rate limit throttles the burst, and a freshly-provisioned VM has little history. Accepted; capturing
  startup logs every deploy outweighs avoiding a one-time, self-expiring backfill.
- **Single-VM failure domain** — Loki shares the host it observes; a VM-down event loses recent logs not yet
  externalized. Accepted for this phase (multi-host is the B4 enterprise path); the nightly B2 backup does not
  cover Loki (logs are transient observability, not durable data). Note the "what happened just before a
  crash" story is split: **Loki** holds the transient log stream (on-VM), while **#48 error tracking**
  externalizes the exception itself to GlitchTip — so a VM loss still leaves the captured error.
