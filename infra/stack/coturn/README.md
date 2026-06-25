# coturn — TURN relay for VoIP V1

Self-hosted TURN relay for argus 1:1 calling. coturn runs as a Compose service (added in PR 7) and needs three secrets delivered by `argus-secrets` (added in PR 6).

## Secrets

| Key Vault name | Local file | What it's for |
|---|---|---|
| `argus-turn-shared-secret` | `turn_shared_secret` | HMAC-SHA1 shared secret for coturn `use-auth-secret` + ephemeral cred minting in the API |
| `argus-turn-tls-cert` | `turn_tls_cert` | fullchain PEM for `turn.4rgus.com` (TURNS port 5349) |
| `argus-turn-tls-key` | `turn_tls_key` | private key PEM matching the cert |

All three are **mandatory** — `argus-secrets` fails closed if any is absent.

## Operator sequence (one-time setup)

Follow these steps **before** deploying PR 6 to the running stack:

### 1. Confirm DNS is live

```bash
dig turn.4rgus.com
# → should return the VM's EIP, not a Cloudflare proxy IP
```

The `turn.4rgus.com` A record is a grey-cloud (DNS-only) record added in the cloudflare-terraform repo. Confirm it's live before issuing the cert (the DNS-01 challenge needs to resolve).

### 2. Issue the TURNS TLS cert

```bash
# Run from your workstation (needs az CLI logged in as a Key Vault Secrets Officer).
export ARGUS_KEY_VAULT=$(terraform -chdir=infra/aws/terraform output -raw key_vault_name)
export CF_Token=<cloudflare-api-token-zone-dns-edit-on-4rgus.com>
bash infra/stack/coturn/issue-turn-cert.sh
```

The script:
- Installs `acme.sh` under `/opt/acme.sh` if absent.
- Issues a Let's Encrypt cert for `turn.4rgus.com` via Cloudflare DNS-01.
- Validates the cert (expiry + domain match).
- Uploads `argus-turn-tls-cert` and `argus-turn-tls-key` to Key Vault via `--file` (not argv).
- Bakes vault name + EC2 instance ID + region into `/opt/acme.sh/deploy/argus_turn_cert.conf` (mode 0600).
- Installs an acme.sh renewal cron + a deploy hook (`argus_turn_cert_deploy()`) that re-uploads to KV and
  triggers `systemctl restart argus-secrets && docker kill -s HUP coturn` on the VM via SSM on each renewal.

For the Cloudflare API token: Dashboard → Profile → API Tokens → Create Token → "Edit zone DNS" template → scope to zone `4rgus.com`.

### 3. Provision the HMAC shared secret

```bash
# From your workstation.
bash infra/aws/scripts/populate-keyvault.sh [--vault <name>]
# argus-turn-shared-secret will be generated and stored. Existing secrets are skipped (idempotent).
```

Or, if populate-keyvault.sh was already run for other secrets, run it again — it skips existing values.

### 4. Verify Key Vault contents

```bash
KV=$(terraform -chdir=infra/aws/terraform output -raw key_vault_name)
az keyvault secret show --vault-name "$KV" --name argus-turn-shared-secret --query value -o tsv | wc -c
az keyvault secret show --vault-name "$KV" --name argus-turn-tls-cert --query value -o tsv | openssl x509 -noout -subject -dates
az keyvault secret show --vault-name "$KV" --name argus-turn-tls-key --query value -o tsv | openssl pkey -noout -check
```

### 5. Deploy PR 6

```bash
# The normal deploy flow — on the VM via az vm run-command / SSM or however deploy.sh is invoked.
# argus-secrets will pick up the three new secrets on its next run.
systemctl restart argus-secrets
ls -la /run/argus/secrets/turn_*
# → turn_shared_secret  turn_tls_cert  turn_tls_key  (mode 0444)
```

## Certificate renewal

`issue-turn-cert.sh` installs an acme.sh cron entry that checks for renewal roughly every 60 days. Let's Encrypt certs are 90-day; acme.sh renews at 60 days remaining. On renewal, the deploy hook (`/opt/acme.sh/deploy/argus-turn-cert.sh`) re-uploads to Key Vault and sends SIGHUP to the coturn container — coturn reloads its TLS config gracefully without dropping active relay allocations.

To force a renewal manually:

```bash
export ARGUS_KEY_VAULT=...
export CF_Token=...
bash infra/stack/coturn/issue-turn-cert.sh --renew
```

## Rotating the HMAC shared secret

```bash
export ARGUS_KEY_VAULT=...
bash infra/aws/scripts/populate-keyvault.sh --rotate
# Only argus-turn-shared-secret (and other rotatable secrets) are overwritten.
# Then restart argus-secrets + coturn to pick up the new value.
# Active calls finish; new calls use the new secret immediately after coturn restarts.
```
