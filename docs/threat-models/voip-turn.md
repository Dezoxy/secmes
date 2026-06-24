# Threat model: TURN/coturn relay & the first public ingress

> **Status: ratified — governs the VoIP V1 relay infra.** Companion to
> [`voip-calling.md`](./voip-calling.md) (the call/signaling threat model) and a revision driver
> for [`vm-ingress.md`](./vm-ingress.md). This note owns the **infrastructure** half of VoIP: the
> self-hosted coturn relay and the platform's **first-ever public inbound port**. Design rationale:
> [03 — Infrastructure: TURN/coturn & Networking](../planning/voip/03-infrastructure-turn-and-networking.md).
> Must be ratified **before** any TURN infra code lands (DoD: security-relevant infra → threat
> model first), i.e. before slices **P0-IT** (NSG/DNS), **P0-IS** (secrets/cert), and **P0-CT**
> (coturn service) per [08 — Roadmap](../planning/voip/08-roadmap-and-delivery-slices.md).

## 1. Feature & data flow

Relay-only is the V1 default, so **every** 1:1 call's media traverses a self-hosted **coturn** relay running on the existing single VM. coturn is a **dumb forwarder of opaque DTLS-SRTP** — it relays encrypted media packets and is **never** given the media keys (invariant 1). It is *not* a media server: no decode, no transcode, no recording.

```
                          ┌──────────────── existing tunnel-only HTTP/WS path (unchanged) ───────────────┐
 users ──HTTPS──▶ Cloudflare edge ──outbound QUIC tunnel──▶ cloudflared ─▶ Caddy ─▶ api ─▶ postgres/redis
                                                                                          │
                                                                                          │ POST /calls/turn-credentials
                                                                                          ▼  (HMAC-minted, 600s TTL)
 ┌─────────────────── NEW: first public inbound ────────────────────┐         ephemeral TURN creds
 │  peer A ──UDP/TCP/TLS──▶  coturn  ◀──UDP/TCP/TLS── peer B          │◀────────  to the browsers
 │   (3478 / 5349 / relay range 49160-49260)  on the VM public IP    │
 │   relays OPAQUE DTLS-SRTP A↔B — holds no media key                │
 └───────────────────────────────────────────────────────────────────┘
```

Two data flows touch the relay:
- **Credential minting** (control plane): `apps/api` holds one HMAC shared secret (Key-Vault file); it mints time-limited `username = "<expiry>:<sub>"` / `credential = base64(HMAC-SHA1(key = turn-shared-secret, msg = username))` pairs over the authenticated `POST /calls/turn-credentials` route (coturn's `use-auth-secret` REST scheme — the secret is the HMAC **key**). The secret never leaves the server side; the browser only ever sees a short-lived derived credential.
- **Media relay** (data plane): the two browsers send DTLS-SRTP to coturn, which forwards it to the other peer. coturn sees both peers' **IP/port 5-tuples** and the encrypted flow (timing, volume, duration) — but never plaintext or keys.

The server (api) is crypto-blind to media and to SDP/ICE (those ride inside MLS ciphertext on the WS path — see [`voip-calling.md`](./voip-calling.md)). coturn is crypto-blind to media by construction.

## 2. Assets & trust boundaries

**Assets**
- The **TURN HMAC shared secret** (`turn-shared-secret`) — minting key; a leak lets anyone mint relay credentials. Key Vault → 0444 tmpfs file; read by both `apps/api` and coturn.
- The **TURNS TLS cert + key** (`turn_tls_cert`, `turn_tls_key`) for `turn.4rgus.com` — Key-Vault files; not the app origin cert.
- **Relay availability** — with relay-only default, coturn uptime *is* calling uptime for every default user.
- **Peer IP/port 5-tuples** processed transiently by the relay (personal data under GDPR — see [`metadata-exposure.md`](./metadata-exposure.md), [`../gdpr/data-residency.md`](../gdpr/data-residency.md)).

**Trust boundaries (new with VoIP)**
- **internet ↔ coturn** — *the new one.* Previously deny-all-inbound; now three narrow NSG allows let internet traffic reach coturn directly on the VM public IP. coturn is the only internet-facing process not behind the Cloudflare edge.
- **coturn ↔ internal VM network** — coturn must **not** be usable as a pivot into the Docker/Azure internal ranges (SSRF-via-relay). Enforced by `denied-peer-ip` RFC1918/loopback/link-local denies.
- **coturn ↔ api** — share the HMAC secret file only; no other coupling. api mints, coturn verifies; neither calls the other.
- **operator ↔ relay metadata** — coturn logs are metadata-only (IP/timing), minimized and short-retention, excluded from the long-term Loki store.

## 3. Threats (STRIDE-lite)

- **Spoofing the origin / bypassing the edge.** The new inbound ports must not become a back door to the HTTP origin or data services. → The NSG `Allow` rules are scoped to **exactly** `3478` (udp+tcp), `5349` (udp+tcp), and the narrow `49160-49260/udp` relay range, all above the `deny-all-inbound`. The HTTP/WS origin (Caddy/api) has **no** inbound rule and stays tunnel-only and unreachable. `compose-guard` is tightened to assert zero published `ports:` **and** that the only `network_mode: host` service is `coturn` — so host-networking can't silently spread to another service.
- **Spoofing a relay credential.** → No static/long-lived TURN credential exists. coturn runs `use-auth-secret` (REST/HMAC) only; credentials are 600s-TTL HMACs minted by the guarded api route after a **≥1-accepted-friend** gate. A stranger can't obtain one; a leaked one expires in minutes and isn't replayable.
- **Tampering / info-disclosure in transit.** → Media is DTLS-SRTP end-to-end (coturn relays ciphertext, holds no key). TURNS on 5349 adds TLS for the captive-portal/firewall path. SDP/ICE never transit coturn — they ride MLS-encrypted on the WS path. coturn cannot read or alter media or signaling.
- **Information disclosure — peer IPs & the real VM IP.** → coturn unavoidably processes both peers' IPs (the *intended* privacy trade: peers are blinded to each other, a single semi-trusted EU relay sees both). Mitigated by minimized/short-retention logging (`simple-log`, no verbose, no credential logging), no persistence, and exclusion from long-term logs. The `turn.4rgus.com` **DNS-only (grey-cloud)** A record exposes the real VM IP (Cloudflare's proxy can't carry TURN UDP) — an accepted V1 trade; ingress Option (d) (a dedicated relay host/IP) is the mitigation and the planned default before video.
- **Elevation of privilege — relay abuse / SSRF-via-TURN.** → A credentialed user must not relay into internal nets or use the box as an open relay/amplifier. `no-loopback-peers`, `no-multicast-peers`, `denied-peer-ip` for all RFC1918 + `169.254/16` + the VM's own addresses; `max-bps`, `total-quota`, `user-quota` cap bandwidth theft and exhaustion; `no-cli` removes the admin surface.
- **Elevation via a compromised coturn container.** → coturn runs **non-root** (`65534:65534`), `read-only` rootfs + a single `/var/tmp` tmpfs, `cap_drop: ALL` with only `NET_BIND_SERVICE` added (privileged ports), `no-new-privileges`, and CPU/memory limits so a relay flood can't OOM Postgres/Redis on the same box.
- **Denial of service — relay flood / amplification / cert expiry.** → coturn quotas + resource limits bound the blast radius; `restart: unless-stopped` + a compose healthcheck + a Phase-0 uptime alert + runbook (TURN down / over quota / cert expired) make the relay-default availability risk observable. coturn is excluded from routine `--force-recreate` (a recreate drops every active relayed call).
- **Secret disclosure.** → The HMAC secret and TURNS cert/key are **Key-Vault files** (0444 tmpfs, Managed Identity), never env, never committed. Mandatory-fail-closed: absent secret → api minting and coturn startup both fail (no fallback to a static cred). gitleaks gates the tree.

## 4. Invariant check (AGENTS.md ×6)

1. **Crypto-blind server** — ✅ coturn relays opaque DTLS-SRTP and holds no media key; api never sees SDP/ICE (MLS-wrapped). **Block** any change that lets coturn terminate media crypto.
2. **No secret/content logging** — ✅ no media/SDP/ICE/keys/credentials in logs; coturn `simple-log`, no verbose, never logs the computed credential; the ephemeral username is an opaque id. coturn logs excluded from long-term Loki.
3. **tenant_id + RLS** — N/A for the relay itself (no schema change in the TURN infra PRs; the only V1 DB change is the `call_relay_only` column on the already-RLS'd `users`). The V1.1 `call_sessions` table carries its own gate.
4. **No hand-rolled crypto** — ✅ DTLS-SRTP is the browser's WebRTC stack; TLS is OpenSSL in coturn; the credential is standard `HMAC-SHA1` over `use-auth-secret` (coturn's documented REST scheme), not a bespoke primitive.
5. **Secrets via Key Vault as files** — ✅ `turn-shared-secret`, `turn_tls_cert`, `turn_tls_key` ride the existing `fetch-keyvault-secrets.sh` → 0444 tmpfs file pattern; nothing in env; fail-closed if absent.
6. **No admin path to content** — ✅ coturn has no content; `no-cli` removes even the metadata-leaking admin surface.

## 5. Decision & mitigations

Open the relay as a **deliberate, audited, single exception** to the zero-ingress model — not a regression. Must-hold mitigations, each landing in its slice:

- **Ingress (P0-IT):** three narrow NSG allows (Azure) + AWS parity + `turn.4rgus.com` DNS-only A record. `coturn --external-ip` advertises the public address (Azure 1:1-NAT `<public>/<private>` form, or relayed candidates are unreachable). EU region pinned. **The NSG relay range and `turnserver.conf` `min-port`/`max-port` must match exactly (`49160-49260`)** — a mismatch silently half-breaks relay allocation. **Manual `terraform apply`** — never auto.
- **Secrets/cert (P0-IS):** `turn-shared-secret` + TURNS cert/key as Key-Vault files; DNS-01 cert issuance for `turn.4rgus.com`.
- **Service (P0-CT):** hardened coturn Compose service (`network_mode: host`, non-root, read-only, caps-dropped except `NET_BIND_SERVICE`, limits, healthcheck, `restart: unless-stopped`) + `turnserver.conf` (REST/HMAC auth, relay range matching the NSG, TURNS, abuse controls, metadata-only logging, `no-cli`, localhost Prometheus). `compose-guard` tightened (zero `ports:` **and** single host-net service == coturn). `vm-ingress.md` revised. **Manual deploy** via `az vm run-command`.
- **Ops (P0-OPS):** coturn uptime/health alert + one-page runbook stub (TURN down / over quota / cert expired). Because relay-default makes coturn availability == calling availability, this is **Phase-0**, not P3.
- **Credentials (P0-A):** `POST /calls/turn-credentials` mints 600s HMAC creds, relay-only shaping, ≥1-friend gate, credential never logged. `infra-reviewer` + `security-boundary-auditor` + `crypto-reviewer` (HMAC use), 42Crunch ≥ 90.

Reviewer: **infra-reviewer** (mandatory across PRs 5–8) + **security-boundary-auditor** (new ingress = boundary change; credential route). CI gates: Checkov/Trivy (Terraform + Dockerfile), gitleaks, the tightened `compose-guard`.

## 6. Residual risk

Accepted for the V1 single-VM deployment:
- **Real VM IP is discoverable** via `turn.4rgus.com` (grey-cloud, bypasses the Cloudflare proxy). Intrinsic to self-hosting a reachable relay; contained by the narrow NSG + aggressive coturn quotas. **Option (d) (dedicated relay host/IP) is the mitigation and the planned default before video** — at which point the app VM IP goes back behind the tunnel entirely.
- **Shared-VM SPOF.** coturn contends with Postgres/Redis/HTTP on one box; a VM failure or relay flood takes everything down. Resource limits cap the flood; Option (d) is the HA lever for V1.1.
- **TURN operator sees both peers' IPs** for every relayed call. The deliberate privacy trade (peers blinded to each other) — documented, unlogged, in-region.
- **coturn restart drops all active relayed calls** with no in-call recovery in V1 (ICE-restart is V1.1). Mitigated to a minimized window by `restart: unless-stopped` + the force-recreate exclusion + the health alert; the honest failure-mode contract is in [`voip-calling.md`](./voip-calling.md) §11.
