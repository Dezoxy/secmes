# Disaster-recovery runbook

> **Roadmap checkpoint 50 (Resilience).** This is the **orchestration playbook**: it sequences the existing,
> already-written recovery procedures into named scenarios with objectives and preconditions. It deliberately
> **does not duplicate** them — each step links to the canonical procedure. Where a step is destructive or
> handles a secret, the linked procedure is the source of truth.

> **Status — built, drill gated on arming.** The deploy is gated off today (`vars.ENABLE_DEPLOY` unset; merges
> don't deploy yet). This runbook is complete and reviewable now; the **timed restore drill** at the end can
> only be executed against the *armed* environment (the same live-VM dependency as roadmap #49). Run the drill
> as part of go-live and record the result in the template below.

## 1. Objectives (RPO / RTO)

Proposed targets for the v1 single-VM beta. Override per your risk appetite.

| Asset | Recovery source | RPO (max data loss) | RTO (max downtime) |
| --- | --- | --- | --- |
| **Postgres (all tenant data + metadata)** | Nightly age-encrypted logical dump in private EU B2 ([infra/backup/README.md](../../../infra/backup/README.md)) | **≤ 24 h** (daily `pg_dump`; continuous PITR is the noted enterprise upgrade) | **≤ 4 h** (VM loss) / **≤ 8 h** (region loss) |
| **Attachment blobs** | B2 object storage (`eu-central-003`), durable independently of the VM | **≈ 0** (object storage; survives VM/region loss) | Immediate once the app is back |
| **Secrets & keys** | Azure Key Vault (Managed Identity), source of truth | **0** (not on the VM) | Minutes (re-fetch on boot) |
| **Infrastructure** | Terraform (`infra/aws/terraform`, `infra/azure/terraform`) | n/a (declarative) | Provisioning time |
| **Container images** | GHCR (built from tagged commits) | n/a | Pull time |

**Why 24 h is the DB ceiling:** the backup is a daily logical dump. The DB is the *only* asset with a
non-trivial RPO — everything else is either in object storage, in Key Vault, or reproducible from git/Terraform.
PITR (WAL archiving → restore-to-any-second) is the upgrade that takes the DB RPO to seconds; it is out of scope
for the beta and noted in [db-backup.md](../../threat-models/db-backup.md).

## 2. What lives where (recovery-source map)

```
                 ┌─────────────────────────────────────────────────────────┐
   Postgres ───▶ │ nightly: pg_dumpall(roles) + pg_dump(db) | age-encrypt   │──▶ private EU B2 (WORM, Object Lock)
                 └─────────────────────────────────────────────────────────┘        decrypt key: Key Vault only
   Attachments ─────────────────────────────────────────────────────────────▶ B2 (eu-central-003), client-encrypted
   Secrets/keys ────────────────────────────────────────────────────────────▶ Azure Key Vault (Managed Identity)
   Infra/config ────────────────────────────────────────────────────────────▶ Terraform + this git repo
   Images ──────────────────────────────────────────────────────────────────▶ GHCR (rebuildable from a tag)
   Ingress ─────────────────────────────────────────────────────────────────▶ Cloudflare Tunnel (no public ports)
```

The server is **crypto-blind**: message bodies in the DB dump are already MLS ciphertext. The dump still holds
**cleartext metadata** (emails, display names, membership, audit) — GDPR-relevant PII — which is why it is
**age-encrypted before it ever leaves the VM** and the decrypt key is **never on the backup host**.

## 3. Recovery scenarios

Pick the scenario, run its checklist top-to-bottom. Each step points at the canonical procedure — do not
improvise the linked steps.

### S1 — VM lost or unrecoverable (single-VM total loss)

1. **Provision a replacement host** — `terraform apply` from `infra/aws/terraform` (or `infra/azure/terraform`),
   following the go-live sequence in [aws-first-deploy.md](./aws-first-deploy.md#go-live-sequence).
   (`terraform apply` is destructive-adjacent — human-confirmed, never run by an agent.)
2. **Confirm secrets** — Key Vault survives independently; the new VM's Managed Identity re-fetches them at boot
   (no action unless the vault itself was lost → see **S6**).
3. **Restore the database** — follow the **Restore runbook** in
   [infra/backup/README.md](../../../infra/backup/README.md) §"Restore runbook": fetch the age private key from
   Key Vault, verify the signed backup pair, restore **roles first, then the DB**, re-apply role logins.
4. **Bring the stack up + re-arm** — deploy the tagged images, flip the deploy gate, restore the Cloudflare
   Tunnel (the tunnel token is a Key Vault file — re-fetched on boot).
5. **Verify** — run the post-deploy smoke test ([aws-first-deploy.md](./aws-first-deploy.md#post-deploy-smoke-test))
   and §4's verification checklist below.

### S2 — Region lost

Same as **S1**, plus: set the new region in the Terraform vars (default to an EU region — `eu-central-1` /
`europe-west3` / `westeurope`), confirm the B2 bucket region is still reachable (B2 is independent of the compute
region), and re-point the Cloudflare Tunnel / DNS at the new host. The DB restore source is unchanged (B2 is
cross-region durable).

### S3 — Bad migration / schema corruption (host intact)

Do **not** restore from backup first — most cases recover with no data loss. Decide the path in
[migration-rollback.md](./migration-rollback.md#which-recovery-path-decide-first):

- **Recovery A** (schema intact / only backward-compatible files applied) — re-run / fix forward.
- **Recovery B** (roll the app image back, no data loss).
- **Recovery C** (restore from backup — accept data loss to the last snapshot) only if A/B can't recover it.

### S4 — Accidental data loss (e.g. over-aggressive prune, erroneous delete)

The retention worker deletes only past the 90-day ceiling and the audit/session prune is window-scoped, but if a
delete went wrong: restore the affected data from the **last good B2 nightly** via
[infra/backup/README.md](../../../infra/backup/README.md) §"Restore runbook" into a **scratch** database, then
extract and re-insert only the affected rows (don't blanket-restore over live data). For a full-cluster rollback,
use **Recovery C** in [migration-rollback.md](./migration-rollback.md#recovery-c--restore-from-backup-data-loss-to-the-last-snapshot).

### S5 — Backup bucket damaged or partially overwritten

The backup bucket is **WORM** (B2 Object Lock, Compliance mode) and the backup key has **no delete capability**,
so genuine backups survive as locked non-current versions even if an attacker uploads junk as the current
version. Recover the newest *authentic* version:

- The restore runbook already walks **object versions** newest-first and accepts only a pair whose Ed25519
  **signature verifies** under the git-pinned `backup-verify.pub` (a forger can't sign) — see
  [infra/backup/README.md](../../../infra/backup/README.md) §"Restore runbook" steps 1c–3.
- In a **suspected compromise**, set `COMPROMISE_BEFORE` to an instant just before the window so the walk skips
  any version uploaded at/after it and lands on the newest genuine pre-compromise locked pair (the anti-rollback
  anchor is B2's upload time, which the attacker can't backdate).

### S6 — Secret or key loss

| Lost | Impact | Recovery |
| --- | --- | --- |
| **A delivered secret** (DB password, B2 key, tunnel token, session signing key) | Service can't boot / connect | Re-provision in Key Vault, redeploy. Key Vault is the source of truth; nothing long-lived lives on the VM. |
| **age private key** (`argus-backup-age-key`) | **Every backup is permanently unreadable** | **Unrecoverable.** Keep an offline break-glass copy. Going forward, never let it live only on the backup VM. |
| **`backup-verify.pub` still a placeholder** | Restore **fails closed** — no backup will verify | Populate the committed verify key from the Key Vault signing key **before** relying on restore (see [infra/backup/README.md](../../../infra/backup/README.md) §"Backup signing key"). **This is an open pre-arming task.** |
| **`argus-session-signing-key`** | API won't boot; all sessions invalid | Re-provision in Key Vault, redeploy; users re-authenticate (passkey). |

## 4. Verification after any restore

- [ ] API health: `GET /healthz` → `{"status":"ok"}` and the service banner `GET /` responds.
- [ ] A known user can authenticate (passkey) and the session mints.
- [ ] Tenant isolation intact: a smoke query confirms RLS is forced (no cross-tenant rows) — the
      `db/rls-coverage` spec encodes the invariant; spot-check one tenant-scoped table.
- [ ] Message send/receive round-trips for a test conversation (ciphertext stored + fanned out).
- [ ] Attachment download URL mints and resolves against B2.
- [ ] Observability is reporting (metrics scrape up, error tracking receiving) — [deploy.md](../../architecture/deploy.md).
- [ ] Backups resume: the next nightly run writes a fresh signed pair + success marker.

## 5. Preconditions (keep these true so recovery is possible)

| Precondition | Why | Where |
| --- | --- | --- |
| age **private** key in Key Vault (`argus-backup-age-key`) | Only thing that decrypts a backup | Key Vault |
| `backup-verify.pub` **populated** (not the placeholder) | Restore verifies signatures; fails closed otherwise | committed: [infra/backup/backup-verify.pub](../../../infra/backup/backup-verify.pub) |
| Role passwords in Key Vault | Re-applied at restore (argus_app login) | Key Vault |
| Restore host has **OpenSSL ≥ 3.0** | Ed25519 `-rawin` verify (LibreSSL/1.1.1 can't) | restore host |
| Terraform remote state locked + accessible | Re-provision is reproducible | `infra/*/terraform` |
| An **offline break-glass copy** of the age key | Survives a Key Vault loss | operator-held, out of band |

## 6. Restore drill (rehearse — an untested backup is not a backup)

> **Gated on arming.** Run this once the environment is live, then at least quarterly. Until then it is a
> documented procedure, not a completed drill.

1. Stand up a **scratch** Postgres (never the live DB).
2. Follow [infra/backup/README.md](../../../infra/backup/README.md) §"Restore runbook" end to end against the
   latest signed pair.
3. Run the §4 verification checklist against the scratch instance.
4. Record the result below.

**Drill log:**

| Date (UTC) | Backup stamp restored | RTO actual | Verified (Y/N) | Notes |
| --- | --- | --- | --- | --- |
| _pending arming_ | | | | first drill at go-live |

## 7. Recovery threat considerations

This runbook orchestrates already-threat-modeled components; it introduces no new asset or trust boundary, so it
adds no net-new threat model. The governing analysis is [db-backup.md](../../threat-models/db-backup.md)
(client-side encryption, WORM Object Lock, signed backups, the freshness/anti-rollback anchor). Two recovery-time
invariants to hold:

- **The age private key never touches the backup VM** — it is fetched from Key Vault only on a trusted restore
  host, and shredded on exit.
- **The verify key is read from the repo, never the bucket** — an attacker who can write the bucket must not be
  able to supply the key that validates their forgery.
