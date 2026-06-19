# Threat model: Key Vault → credential files (Slice 3)

> Status: **DRAFT for ratification.** The runtime secret-delivery mechanism (roadmap Phase 0, checkpoints 2 &
> 8): a boot-time systemd oneshot that uses the VM's **Managed Identity** to read secrets from **Azure Key
> Vault** and write them as **credential files** on tmpfs, which the stack + backup/cleanup units consume.
> **Build-only** — this slice provides the script + unit + wiring; the deploy that installs/enables them is
> Slice 4. Cross-references `vm-deploy.md` (slice 1, the MI→KV grant) and `vm-ingress.md` (slice 2, the
> `*_FILE` consumers).

## 1. Feature & data flow

```
boot ─▶ argus-secrets.service (oneshot, root)
          │  1. IMDS (169.254.169.254) ──Managed Identity──▶ access token for vault.azure.net  (no static creds)
          │  2. GET https://<vault>.vault.azure.net/secrets/<name>  (Bearer token)  ──▶ secret value
          │  3. write /run/argus/secrets/<file>   (tmpfs, root:root, 0444, atomic; see §3 for why 0444)
          ▼
   stack (compose) + backup/cleanup units  (Requires=/After= argus-secrets.service)
     - postgres   ← POSTGRES_PASSWORD_FILE        (Docker secret file)
     - api        ← DATABASE_URL_FILE, S3_SECRET_ACCESS_KEY_FILE
     - cloudflared← TUNNEL_TOKEN_FILE  (Docker secret file mount — never env)
     - backup     ← LoadCredential: backup-db-password (argus_backup) + b2-app-key
     - cleanup    ← LoadCredential: cleanup-db-password (argus_cleanup) + b2-app-key
```

No secret ever lands in the repo, an image, Terraform inputs, or a process environment block. The values live
only on **tmpfs** (`/run`, never disk-backed), at mode `0444` owned by root inside a `0700 root` directory.
The mode is `0444`, not `0400`, because file-based Compose secrets are **bind-mounted** into the container
with the host owner/mode unchanged on Linux (no uid/gid remapping), and the consumers run **non-root** (api
uid 1000, postgres 999, grafana 472, redis 999) — a root-owned `0400` file would be unreadable and the stack
would fail to start (see §3). Confinement is the `0700` root directory, not the file mode. The systemd
`LoadCredential` consumers (backup/cleanup units) are unaffected — systemd reads the source as root and
re-exposes the credential to the unit. This is pure secret-delivery infrastructure; **no message content** is
involved (message bodies are E2EE ciphertext regardless).

## 2. Assets & trust boundaries

- **Assets:** the runtime secrets (DB owner + `argus_app` DSN, B2 keys, cloudflared tunnel token, backup
  role password); the Managed Identity's right to read the vault.
- **Boundaries:**
  - VM ↔ IMDS (`169.254.169.254`) — link-local, only processes on the VM can reach it; the token it mints is
    scoped to `vault.azure.net` and short-lived.
  - VM ↔ Key Vault — the MI holds **Key Vault Secrets User** (get/list, read-only — slice 1); the vault
    firewall default-denies, reachable via the subnet's Key Vault service endpoint.
  - fetch oneshot ↔ consumers — the secret files are mode `0444` inside a `0700 root` tmpfs dir, so host
    non-root users can't traverse to them; the root Docker daemon mounts them into containers where the
    **non-root** service users read them, and root systemd re-exposes them to the LoadCredential units.

## 3. Threats (STRIDE-lite)

- **Info-disclosure — secret values leaking.** → Values are written `0444 root:root` inside a `0700 root`
  dir on **tmpfs** (no disk backing, gone on reboot), written **atomically** (temp + `mv`, `umask 0077`). The
  `0444` mode is required so the non-root container users can read the bind-mounted Compose secrets (Docker
  does not remap the file owner on Linux); the `0700` directory — not the file mode — is what keeps host
  non-root users out. The script logs secret
  **names + HTTP status only** — never a value; values are never `export`ed into the environment (so not in
  `/proc/<pid>/environ`, not inherited by children) and never appear in argv. The MI token is held only in a
  shell variable for the duration of the run.
- **Spoofing the identity / token theft.** → The token comes from **IMDS** via the VM's own Managed Identity
  — there is no static credential to steal. IMDS is link-local and only reachable from on-box. A stolen token
  is short-lived and scoped to `vault.azure.net` read.
- **Tampering — a bad secret started under the stack.** → The fetch is **fail-closed**: any failed fetch or
  empty value exits non-zero, and the stack/backup units declare `Requires=argus-secrets.service`, so they do
  **not** start if delivery fails (no silent fallback to a stale/empty secret). Partial temp files are removed
  on failure.
- **Elevation via the oneshot.** → Hardened systemd unit: `NoNewPrivileges`, `ProtectSystem=strict` with only
  `/run/argus/secrets` writable, `ProtectHome`, `PrivateTmp/Devices`, `RestrictAddressFamilies=AF_INET
  AF_INET6`, `SystemCallFilter=@system-service`, `MemoryDenyWriteExecute` (safe — curl + jq, no Python),
  empty `CapabilityBoundingSet`. It needs only egress + a write to the secrets tmpfs.
- **Least privilege of the delivered DSN.** → The api's `database_url` secret is the **non-bypass `argus_app`
  role** (not the owner) — see `vm-ingress.md`; this slice only transports it.

## 4. Invariant check (CLAUDE.md ×6)

1. **Crypto-blind server** — N/A (no content path).
2. **No secret/plaintext logging or persistence** — ✅ names/status only; values only on tmpfs `0444` (inside
   a `0700` root dir), never env/argv/logs/disk.
3. **tenant_id + RLS** — N/A (no schema); the delivered DSN is the RLS-bound `argus_app` role.
4. **No hand-rolled crypto** — ✅ none; TLS to Key Vault is the platform's.
5. **Secrets via Key Vault + Managed Identity as files** — ✅ this *is* that mechanism: MI → Key Vault →
   credential files; nothing committed, nothing long-lived in env.
6. **No admin path to content** — N/A.

## 5. Decision & mitigations

Ship the fetch script + hardened oneshot + consumer wiring. Must-hold mitigations: tmpfs-only `0444`
delivery inside a `0700` root dir; names-only logging; fail-closed with `Requires=` gating; the hardened unit; IMDS-only token (no
static creds). Reviewer: **infra-reviewer** (systemd unit, shell script, secret handling). Gates: shellcheck,
gitleaks (no committed secrets), Semgrep. Not deployed — `vars.ENABLE_DEPLOY` stays off; installation +
enabling is Slice 4.

## 6. Residual risk

- **Root-on-the-VM sees everything.** Anyone with root on the VM can read the tmpfs secrets and the MI token —
  inherent to a single-VM model; the boundary is host integrity (no inbound port, hardened units). Enterprise
  path: split secrets per-service / per-container secret stores, or a confidential-VM TEE.
- **Key Vault availability.** A vault outage at boot fails the fetch (and, via `Requires=`, the stack) — a
  fail-closed outage, not a leak. Accepted.
- **Secret rotation is not yet automated.** Re-running the oneshot (or a reboot) re-fetches; a
  watch/rotate-on-change loop is a later enhancement. Accepted for this phase.
- **Per-endpoint egress not pinned.** The unit allows general egress (it only needs IMDS + the vault), so a
  compromised `curl` could in principle reach elsewhere. `IPAddressAllow` for the vault is impractical (Azure
  Key Vault IPs are dynamic); the NSG/host has no inbound exposure and the unit is short-lived + hardened.
  Tightening egress (service-tag-based) is a later enhancement.
