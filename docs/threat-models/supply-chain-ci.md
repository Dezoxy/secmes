# Threat model: CI container-image supply chain (SUP-1)

**Finding**: SUP-1 (P2) — `docs/reviews/06-infra-deploy.md` §5
**Scope**: third-party container images pulled by CI workflows
**Change**: digest-pin every third-party CI image; no behaviour change

---

## 1. The exposure

GitHub Actions `uses:` references are SHA-pinned repo-wide, but that discipline
did **not** extend to the container images CI pulls:

| Workflow | Image | Was |
|---|---|---|
| `security.yml` | `semgrep/semgrep` | **untagged → implicit `:latest`** |
| `ci.yml`, `dast.yml` | `postgres:16-alpine` | mutable tag |
| `ci.yml`, `dast.yml` | `redis:8-alpine` | mutable tag |

A mutable tag is a re-point vector: the registry can serve different bytes for
the same tag tomorrow (upstream account compromise, tag re-push, registry MITM).
The **`semgrep/semgrep`** case is the sharp one — it runs as a job `container:`,
so it is third-party **executable code** wrapping a job that has checked out the
repo and holds the default `GITHUB_TOKEN`. A hijacked tag there is arbitrary code
execution inside CI with repo write context. The postgres/redis service
containers are the lesser variant: ephemeral data backends, no repo checkout —
but still an unpinned pull.

## 2. The fix

Each image is pinned to its immutable, content-addressed **index (multi-arch
manifest-list) digest**, keeping the human-readable tag for legibility:

```
postgres:16-alpine@sha256:e013e867e712fec275706a6c51c966f0bb0c93cfa8f51000f85a15f9865a28cb
redis:8-alpine@sha256:09160599abd229764c0fb44cb6be640294e1d360a54b19985ab4843dcf2d90f1
semgrep/semgrep@sha256:c180f0c93a17b420c0af5006214a29d3c747c5459c732b740191adf657dd0068
```

`ci.yml` and `dast.yml` carry **identical** postgres/redis digests (single source
of truth — bump them together). Digests resolved **2026-06-20** via
`docker buildx imagetools inspect <image>` (top-level `Digest:` = the index
digest, correct for the multi-arch GHA runners).

**Out of scope (verified):** `cd.yml`/`cd-aws.yml` `image: ${{ env.IMAGE }}` is the
app's *own* image — built, pushed, Trivy-scanned, cosign-signed + SBOM-attested,
and deployed **by digest** with `cosign verify` (see `vm-cd.md`). It is first-party
and already digest-resolved, not a third-party pull.

## 3. Residual — no automatic bumps

Digest-pinning freezes these images: they will not auto-receive upstream patches.
Note the review's suggested "extend Dependabot's docker ecosystem to the workflow
files" is **not achievable as written** — Dependabot tracks `image:`/`FROM` only in
Dockerfiles and docker-compose, and `uses:` only via the `github-actions`
ecosystem; **neither ecosystem updates `image:`/`container:`/`services:` inside
workflow YAML.** So nothing auto-bumps these three pins.

**Chosen mitigation (solo / cost-conscious):** manual periodic bump — re-run
`docker buildx imagetools inspect` for the three images and update the digests
(here + `ci.yml`/`dast.yml` in lockstep). **Be honest about the gap: no CI scanner
inspects these three image contents today.** Trivy only scans the app's *own*
image (`cd.yml` `image-ref: ${{ env.IMAGE }}`; the `security.yml` fs-scan was
deliberately removed), and OSV scans the repo's dependency lockfiles, not OS
packages inside a base image. So a stale, CVE-bearing pin is **silent** until the
next manual bump — staleness is mitigated *only* by that bump, not by an automated
scanner. This is the real cost of the residual and the reason to graduate to
Renovate before scale.

**Enterprise-grade alternative (deferred):** adopt **Renovate**, which *does*
track and PR digest updates for workflow `image:`/`services:`/`container:`
references — the proper automation if this graduates past solo-beta.

## 4. Invariant check

No invariant tension. CI handles no message content (#1/#6 untouched); no secret
is added or logged (#2); the change is workflow-only (no tenant tables → #3 N/A;
no crypto → #4 N/A; no new config secret → #5 N/A). This is pure supply-chain
integrity hardening on the build/test surface.

## 5. Verification

- The PR's own `ci` job (postgres+redis services) and `security` job (semgrep
  container) run on the pinned digests — green CI = all three pull and run.
  `dast.yml` is nightly and won't run on the PR, but its postgres/redis digests
  are byte-identical to `ci.yml`'s, so they are validated transitively.
- `grep -rEn 'image:|container:' .github/workflows` → every third-party image is
  `…@sha256:…`; only `${{ env.IMAGE }}` (the app's own build) stays digest-free,
  by design.
