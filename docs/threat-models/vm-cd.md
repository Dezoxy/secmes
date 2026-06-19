# Threat model: CD rollout (Slice 4)

> Status: **DRAFT for ratification.** The continuous-delivery path (roadmap Phase 0, checkpoints 5/6/7/7a):
> `cd.yml` builds + scans + signs the images to GHCR, then rolls out to the single VM via `az vm
> run-command` — pulling the signed images and running DB **migrations before serving**. **Gated** behind
> `vars.ENABLE_DEPLOY` (off) — nothing deploys. Builds on slice 1's OIDC deploy credential (`vm-deploy.md`)
> and slices 2/3 (the stack + secret delivery).

## 1. Feature & data flow

```
push tag vX.Y.Z ─▶ cd.yml (GitHub Actions)
   job images (matrix api + ingress):  build (tag=version) ─▶ push GHCR ─▶ Trivy(HIGH/CRIT) ─▶ syft SBOM ─▶ cosign sign+attest (keyless OIDC)
   job deploy (gated: ENABLE_DEPLOY + `production` env approval):  Azure OIDC login ─▶ bundle exact-SHA infra (compose + fetch unit + deploy.sh)
        └─ az vm run-command invoke ──Azure control plane──▶ VM guest agent ──▶ deploy.sh (root)
              deploy.sh:  Managed Identity ─▶ Key Vault (GHCR token + owner DSN, transient)
                          docker login GHCR ─▶ pull signed images
                          compose up postgres/redis ─▶ MIGRATE (owner, file DSN) ─▶ compose up api/caddy/cloudflared
```

The deploy reaches the VM **only** through the Azure control plane (`run-command`) — no SSH, no inbound port
(NSG denies all inbound). The run-command payload is **non-secret** (compose + scripts at the deployed SHA);
every secret is fetched **on the VM** via the Managed Identity. No message content is involved.

## 2. Assets & trust boundaries

- **Assets:** the GitHub→Azure OIDC deploy credential; the GHCR pull token + the DB **owner** DSN (both
  high-value, both transient on the VM); the integrity of the images the VM runs.
- **Boundaries:** GitHub ↔ Azure (OIDC federation, no stored creds — `vm-deploy.md`); the deploy SP ↔ the VM
  (control-plane `run-command` only, a custom role on the one VM); VM ↔ Key Vault (MI, read-only); CI ↔ GHCR
  (`GITHUB_TOKEN`, `packages:write`, job-scoped).

## 3. Threats (STRIDE-lite)

- **Spoofing the deployer.** A forged OIDC token, or an unwanted tag, could roll out arbitrary code (root) to
  the VM. → Releases are **tag-triggered**, and the deploy job runs in the **`prod` GitHub Environment**
  with **required-reviewer approval** — a per-release human gate before any run-command runs. The federated
  credential is bound to that environment (`repo:OWNER/REPO:environment:prod`, not a branch), and the SP
  holds only a custom `run-command` role on the one VM (not Contributor). `vars.ENABLE_DEPLOY` is the master
  kill-switch. See `vm-deploy.md`.
- **Tampering — a malicious/compromised image.** → Images are built in CI, **Trivy**-scanned (fail on
  HIGH/CRITICAL), SBOM'd (syft), and **cosign**-signed keyless via OIDC. Before rollout the VM resolves each
  tag to its immutable **digest** and **`cosign verify`s** the signature against this repo's `cd.yml` OIDC
  identity **for the exact release tag** (`--certificate-identity …@refs/tags/<this-version>`, not a tag
  prefix — so a tag overwritten to a different-but-legitimately-signed older digest, i.e. a downgrade, also
  fails). A bad/missing/wrong-tag signature fails the deploy closed (the tampered image never runs), and the
  stack runs **by digest** (closing the tag-swap TOCTOU). So a compromised registry or an overwritten tag
  can't ship an unsigned — or stale — image.
- **Info-disclosure — secrets in the deploy.** → The run-command payload carries **no secrets** (only
  non-secret config at the SHA). The GHCR token + owner DSN are fetched on-VM via the Managed Identity, used,
  and dropped: the GHCR token goes to `docker login --password-stdin` (never argv) and the owner DSN is
  written `0400` to a tmpfs file, mounted read-only into the one-off migrate container, and **`shred`-ed**
  immediately after. The owner DSN is **never** part of the persistent `/run/argus/secrets` set the running
  stack holds (least privilege). The cloudflared tunnel token is a mounted file-secret (`TUNNEL_TOKEN_FILE`),
  never in the `compose up` env.
- **Elevation — migrate runs as owner.** A breaking migration could serve ahead of (or behind) its schema, or
  the owner connection could be misused. → **Migrate-before-serve**: data services come up, the **old api is
  stopped** (so on a redeploy old code can't hit the new schema mid-migration), migrations run to completion
  as the owner (file DSN, advisory-locked), and only then do api/caddy/cloudflared (re)start on the new image.
  Brief `/api` downtime during migration is the in-place trade-off (caddy keeps serving the PWA; expand/contract
  migrations are the zero-downtime future). The **runtime** api connects as the non-bypass `argus_app` role,
  never the owner (`vm-ingress.md`).
- **Repudiation / drift.** → The deployed artifact is the signed image at a known SHA + the exact-SHA infra
  bundle; `run-command` is auditable in Azure activity logs (IDs/metadata, no secrets).

## 4. Invariant check (CLAUDE.md ×6)

1. **Crypto-blind server** — N/A (delivery only).
2. **No secret/plaintext logging or persistence** — ✅ run-command payload secretless; transient secrets via
   stdin/file + shredded; CI never echoes a secret; logs are IDs/metadata.
3. **tenant_id + RLS** — N/A; migrations preserve the RLS schema; runtime is `argus_app`.
4. **No hand-rolled crypto** — ✅ none; signing is cosign/Sigstore.
5. **Secrets via Key Vault + Managed Identity** — ✅ every deploy secret (GHCR token, owner DSN) is
   MI-fetched on the VM; CI holds only the OIDC `id-token` + the job-scoped `GITHUB_TOKEN`. No static cloud
   creds anywhere.
6. **No admin path to content** — N/A.

## 5. Decision & mitigations

Ship the gated CD as code. Must-hold: OIDC-only (no stored cloud creds); Trivy/cosign supply-chain gates;
secretless run-command payload; transient MI-fetched deploy secrets (stdin/file, shredded); migrate-before-
serve; runtime stays `argus_app`. Reviewer: **infra-reviewer** (workflow + deploy.sh) + **security-boundary-
auditor** (the migration/role boundary). CI: actionlint/shellcheck on the workflow, gitleaks, Semgrep
(CI-injection rules). Not deployed — `vars.ENABLE_DEPLOY` stays off until the Azure subscription + repo
vars/secrets exist.

## 6. Residual risk

- **Signature-verification trust roots.** The VM verifies via cosign keyless (Fulcio/Rekor) against the
  `cd.yml` OIDC identity — so it trusts the public-good Sigstore infrastructure and a correct
  `--certificate-identity-regexp`. A private Fulcio/Rekor or a pinned key is the enterprise-grade upgrade;
  the regexp must be kept in sync if the workflow path/ref scheme changes.
- **`run-command` runs as root.** Inherent to the control-plane deploy model; the boundary is the OIDC
  subject binding + the single custom role (`vm-deploy.md`). A protected GitHub Environment with required
  reviewers is the pre-prod tightening.
- **Single VM / no staging gate here.** Staging + prod environments (roadmap 8a) and a blue/green or
  health-gated rollout are later; today it's a single in-place `compose up -d`.
- **Tunnel token no longer transits any process env (INF-4, resolved 2026-06).** cloudflared reads the token
  from its mounted file-secret via `TUNNEL_TOKEN_FILE` (>=2025.4.0; we pin 2025.6.1), so `deploy.sh` no longer
  reads the file into a `TUNNEL_TOKEN` env var for `compose up`. The token is now file-backed end-to-end like
  every other data-plane secret — never in `/proc/<pid>/environ`, never in the daemon's at-rest container
  config (`docker inspect`). This removed the last env-delivered secret, flipping invariants 2 & 5 to clean.
- **`shred` on tmpfs is best-effort.** The transient owner-DSN file is `0400` on RAM-backed tmpfs and `rm`-ed
  immediately; the `shred` is defense-in-depth only (overwrite-in-place doesn't apply to tmpfs). The real
  protection is the tmpfs + `0400` + prompt removal.
