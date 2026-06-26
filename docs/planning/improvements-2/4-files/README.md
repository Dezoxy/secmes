# Runtime health improvement plan

> **Status:** ACTIVE 2026-06-26. Must-fix implementation is in progress; deployed verification is still pending.
> **Origin:** AWS experiment VM triage via SSM plus Loki/Grafana log review after the Friends screen showed
> stale data during the `aws-v0.8.16` rollout.

## Scope

This plan turns the 2026-06-26 runtime findings into implementable tracks. It covers the user-visible Friends
refresh failure, noisy or false critical alerts, broken observability labels, and lower-priority operational
cleanup.

## Status legend

- `[x] Diagnosed` means the issue has evidence from Loki, Prometheus, Docker, or SSM.
- `[ ] Implemented` means the repo change has landed.
- `[ ] Verified` means the deployed AWS experiment VM proves the fix works.
- `[ ] Merged` means the fix PR is merged to `main`.

## Tracks

| # | Track | Priority | Status | Why it matters |
|---|-------|----------|--------|----------------|
| 1 | [Must fix](./01-must-fix.md) | P1 | Items 1-5 implemented and merged; deployed verification pending | User-visible stale Friends state plus false critical alerts. |
| 2 | [Should improve](./02-should-improve.md) | P2 | Items 1-4 implemented and merged; deployed verification pending | Observability noise hides real incidents and makes dashboards less trustworthy. |
| 3 | [Nice to have](./03-nice-to-have.md) | P3 | Item 1 implemented and merged; item 2 implemented; deployed verification pending | Better deploy UX, dashboards, and regression checks. |

## Recommended order

1. Fix Loki/Grafana service labels first so every later log review names real services instead of container IDs.
2. Fix Friends refresh resilience and `/friends/requests` 429 bursts.
3. Fix Redis exporter and coturn scrape false critical alerts.
4. Clean up Postgres exporter, Grafana provisioning, Alertmanager, and Pyroscope noise.
5. Add dashboard polish and config regression checks.

## Evidence snapshot

- `aws-v0.8.16` deploy started at `2026-06-26 06:37:14 Europe/Budapest`.
- Caddy returned `502` for `/api/friends`, `/api/friends/requests`, `/api/me/settings/privacy`, and `/ws`
  while the API container was being recreated.
- The database still had `accepted | 1` in `friendships`; this was not friend data loss.
- Loki labels currently expose container IDs as the main service dimension, making Grafana service cards
  unreadable.
- Prometheus was firing `RedisDown` and `ArgusCoturnDown` even though Redis and coturn containers were healthy.

## Constraints

- Preserve the no-Docker-socket posture in Alloy. A Docker socket mount is daemon-root-equivalent and is not an
  acceptable shortcut for service-name labels.
- Keep logs metadata-only. Do not log tokens, secret files, plaintext, message content, or presigned URLs.
- Keep all secrets file-backed. Fixes must not move Redis, Grafana, Alertmanager, or database credentials into
  process environment values.
- Each implementation PR updates this README and the relevant concrete track file before opening the PR.
