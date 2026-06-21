# Infrastructure: TURN/coturn & Networking

> Part of the argus VoIP plan set. Siblings: [00-overview-and-goals.md](./00-overview-and-goals.md) · [01-architecture-and-crypto-model.md](./01-architecture-and-crypto-model.md) · [02-signaling-protocol-and-state-machine.md](./02-signaling-protocol-and-state-machine.md) · [04-server-api-and-database.md](./04-server-api-and-database.md) · [05-frontend-pwa-and-webrtc.md](./05-frontend-pwa-and-webrtc.md) · [06-threat-model-and-privacy.md](./06-threat-model-and-privacy.md) · [08-roadmap-and-delivery-slices.md](./08-roadmap-and-delivery-slices.md) · [09-decision-log-and-open-questions.md](./09-decision-log-and-open-questions.md)

This is the highest-risk file in the set. It forces the **first internet-facing inbound port the platform has ever had**, breaks the "zero published ports" invariant that `compose-guard` mechanically enforces, and reintroduces on-box TLS/DNS that the Cloudflare Tunnel model was built to avoid. Everything below treats that as a deliberate, audited exception — not a regression — and keeps the six security invariants intact (coturn relays opaque DTLS-SRTP; it is **crypto-blind by construction**, never a party to the media keys).

A note on V1 scope that shapes this whole file: per the [00 overview](./00-overview-and-goals.md) and the re-cut in [08](./08-roadmap-and-delivery-slices.md), **V1 is 1:1 audio only, relay-only, foreground-ring only**. That changes the infra calculus dramatically — audio relay is cheap (see §10), 25 concurrent *audio* legs is trivial for the shared VM, and the egress-cost-vs-privacy tension that dominates video effectively vanishes for the first ship. Video, ICE-restart/reconnection, and multi-device ring-all are **V1.1**; the infra here is built so they slot in without re-architecting (the relay range, NSG rules, and credential flow are identical — V1.1 only widens `max-bps` and capacity).

**One operational consequence stated up front:** because the default is relay-only, **coturn availability *is* calling availability** for every default user. There is no direct-P2P fallback for the default cohort. That promotes coturn from a "nice to monitor" P3 concern to a **Phase-0 operational deliverable** — health alert + runbook stub ship *with* the relay, not after (see §9 and [08](./08-roadmap-and-delivery-slices.md)).

---

## 1. The head-on tension: Cloudflare Tunnel cannot carry TURN

Today every inbound byte arrives via an **outbound** Cloudflare Tunnel (`cloudflared` dials `caddy:8080`; no host ports; Azure NSG is `deny-all-inbound`; CI job `compose-guard` in `.github/workflows/ci.yml` fails the build if `docker compose config` reports any published port). See `docs/threat-models/vm-ingress.md`.

WebRTC media needs UDP that the client can reach **directly**:

| Need | Port / range | Transport | Why |
| --- | --- | --- | --- |
| STUN binding + TURN allocate | **3478** | UDP (primary) + TCP (fallback) | Classic TURN/STUN listener |
| TURN over TLS (TURNS) | **5349** | TCP/TLS (and DTLS/UDP) | Looks like HTTPS; punches restrictive firewalls |
| Relay media ports | **49152–65535** (we narrow it — see §6) | UDP | One allocation per call leg; coturn picks from this range |

Cloudflare Tunnel (`cloudflared`) only carries **HTTP/WebSocket over TCP**. It cannot forward STUN/TURN UDP or the relay range. **TURN therefore cannot ride the existing tunnel — full stop.** This is not a config nuance; it is a protocol-level dead end. The decision below is *how* we open inbound media, not *whether* the tunnel can avoid it.

---

## 2. Ingress options compared

Four ways to land TURN traffic on a self-hosted relay:

| # | Option | What it is | UDP? | Hides VM IP? | $ / mo (solo) | Setup complexity | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **a** | **coturn on the VM public IP, behind strict NSG** | Open 3478/5349 + a narrow relay range inbound on the existing VM's public IP; one sanctioned non-tunnel ingress | Yes (native) | No — DNS A record exposes real IP | **€0** (egress only) | Low–medium | **RECOMMENDED (audio V1)** |
| b | Cloudflare Spectrum (L4) | Cloudflare proxies raw TCP/UDP to origin, keeping IP hidden + DDoS scrub | UDP is **Enterprise-only**, paid add-on | Yes | Enterprise contract (4-fig+/mo) | High (sales + config) | Reject for solo |
| **c** | **TURNS only, over 443/TLS** | Run `turns:` on 5349 (or 443) as a co-listener — survives captive portals | No (TCP relay only) | No | €0 | Low | **Confirmed co-listener for audio V1** |
| **d** | Dedicated relay host / separate IP | A second small VM (or a managed TURN) holding only coturn; app VM stays tunnel-only | Yes | App VM IP stays hidden; relay IP exposed | €4–8 (small VM) or usage-based | Medium | **Becomes DEFAULT before video (V1.1)** |

Per the [09 decision log](./09-decision-log-and-open-questions.md), Q1 is ruled: **(a) + (c) are confirmed for audio V1**, and **(d) becomes the default before video ships** — at video bitrates the shared-VM blast radius and the IP-exposure trade-off both change enough to justify isolating the relay onto its own IP. Treat (d) as a planned V1.1 graduation, not a hypothetical.

### Why (a) is the default for a solo EU dev (audio V1)

- **Cost.** €0 incremental. The VM already has a Standard public IP that is egress-only; opening narrow inbound rules costs nothing. Spectrum-for-UDP (b) is gated behind an Enterprise contract — wildly disproportionate for one developer. Cloudflare's *Realtime TURN* product is a real alternative but it's a **hosted relay you don't control** (out of scope: "fully self-hosted" is locked) and bills $0.05/GB egress ([Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/)).
- **The IP-exposure objection is weaker than it looks — for audio.** The tunnel hides the VM IP mainly to deny attackers a direct DDoS/scan target. But TURN inherently advertises a reachable relay address to every peer — exposure is intrinsic to running your own relay. We contain it with: a **dedicated DNS name** (`turn.4rgus.com`, grey-cloud / DNS-only) that points at the IP but doesn't advertise it's the app origin; an NSG that allows **only** the three TURN port groups inbound and nothing else (the HTTP origin stays tunnel-only and unreachable); and Cloudflare edge still fronting all HTTP/WS, so the app surface is unchanged. An attacker who finds the IP reaches a coturn that speaks only STUN/TURN and rate-limits hard. **This is exactly the calculus that flips at video volume** → Option (d) before video.
- **Simplicity.** One new compose service, one Terraform NSG block per cloud, one cert. No new host, no Enterprise onboarding.
- **(c) TURNS-over-443 is a complement, not a substitute.** TCP-only relay is the worst-quality path (head-of-line blocking kills jitter tolerance) but it's the one that survives hostile/captive networks. Ship it *alongside* UDP, listed last in ICE priority — not as the only listener.

**Recommendation tiers**
- **Must (audio V1):** Option (a) — coturn on the VM public IP, NSG-restricted to exactly the TURN ports, with TURNS-over-TLS (c) as a co-listener for restrictive networks.
- **Should:** Narrow the relay range (§6), enable both UDP and TURNS, IP-allowlist nothing (TURN is internet-facing by nature) but rate-limit aggressively.
- **Enterprise-optional / V1.1 default:** Option (d) dedicated relay host — **planned default before video** for blast-radius isolation and to keep the app VM IP hidden; or Cloudflare Spectrum (b) only if you ever buy Enterprise for other reasons.

---

## 3. coturn as a hardened Compose service

coturn is the first service that **cannot** match the stack's read-only / zero-cap / zero-ports uniformity, so every deviation is deliberate and documented.

### 3.1 Compose sketch

Lands in `compose.prod.yaml` (new service block). Note the `network_mode: host` decision below the sketch, and the **healthcheck** — mandatory because coturn availability equals calling availability (§9).

```yaml
  coturn:
    image: coturn/coturn:4.6.2  # pin a digest in real config: coturn/coturn@sha256:...
    restart: unless-stopped     # MUST: a relayed call dies if coturn dies; auto-restart minimizes the window
    # Host networking: coturn must see real client src IPs and bind the full
    # relay range. A Docker bridge with a 16k-port range explodes the userland
    # proxy and mangles src IPs (breaks TURN's peer-permission model + abuse logs).
    network_mode: host
    command:
      - -c
      - /etc/coturn/turnserver.conf
    user: "65534:65534"            # nobody:nogroup — never root
    read_only: true                # rootfs read-only…
    tmpfs:
      - /var/tmp                    # …coturn needs a small writable scratch dir only
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - NET_BIND_SERVICE            # required: 3478 and 5349 are privileged (<1024) and coturn runs as nobody
    healthcheck:
      # coturn answers STUN binding on 3478/udp; a successful bind == relay is alive.
      # turnutils_uclient ships in the image; a TCP connect to 3478 is the cheap liveness floor.
      test: ["CMD-SHELL", "turnutils_uclient -y -u health -w health 127.0.0.1 -n 1 >/dev/null 2>&1 || nc -z -u 127.0.0.1 3478 || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    deploy:
      resources:
        limits:
          memory: 256M
          cpus: "1.0"
    secrets:
      - turn_shared_secret          # HMAC key, file-mounted (see §5)
      - turn_tls_cert               # fullchain.pem (see §7)
      - turn_tls_key                # privkey.pem
    configs:
      - source: turnserver_conf
        target: /etc/coturn/turnserver.conf
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"               # metadata-only, short retention (see §8)
```

**Hardening notes / honest deviations:**
- `network_mode: host` is the load-bearing departure. The alternative (`ports:` + bridge) forces Docker's userland proxy to map ~16k UDP ports — it SNATs the source IP, which **breaks coturn's peer-permission checks and turns every abuse log into "the request came from the Docker gateway."** Host networking is the documented, near-universal way to run coturn in containers ([WebRTC.ventures, Jan 2025](https://webrtc.ventures/2025/01/how-to-set-up-self-hosted-stun-turn-servers-for-webrtc-applications/)). Trade-off: it bypasses Compose `ports:` entirely, so the firewall is now **100% the NSG's job** (§4) — there is no Docker-level port gate to lean on.
- `cap_add: [NET_BIND_SERVICE]` is mandatory because 3478/5349 are privileged ports and coturn runs as `nobody`. This is the one cap we add; everything else is dropped.
- `read_only: true` + a single `tmpfs:/var/tmp` works because coturn's only writes are transient (no SQLite/Redis backend — we use the static-secret REST mode, §5, so no DB file to persist).
- `restart: unless-stopped` + the healthcheck are **operational invariants, not polish**: with relay-default, a dead coturn = no calls for anyone. See §9 for the failure-mode contract (a coturn restart drops every active relayed call; in V1.1 ICE-restart is the only recovery — in audio V1 there is no in-call recovery, the call simply ends).
- Resource limits cap the blast radius of a relay flood (a TURN amplification attempt can't OOM Postgres on the same box).

### 3.2 `compose-guard` must learn about coturn

`network_mode: host` sidesteps the `.services[].ports` count that `compose-guard` (`.github/workflows/ci.yml`) sums — so it may pass *by accident*. Don't rely on that. Tighten the guard to:
1. Still assert **zero `ports:`** on every service (host networking is the sanctioned exception, published ports are not).
2. Assert that **exactly one** service uses `network_mode: host`, and it is `coturn`. Any other host-network service fails CI.

This keeps the invariant *visible and enforced* rather than silently circumvented. Update `docs/threat-models/vm-ingress.md` in the same PR — it currently asserts the tunnel is the *only* ingress; that sentence becomes false the moment coturn ships.

---

## 4. NSG / Terraform changes (the first inbound the platform has ever had)

### 4.1 Azure (`infra/azure/terraform/main.tf`)

Today: a single `deny-all-inbound` rule, `protocol = "*"`, all ports. Add inbound `Allow` rules **above** the deny (lower priority number), scoped to exactly the TURN ports from the internet. The Standard public IP accepts inbound once an NSG rule permits it.

```hcl
# TURN/STUN — the single sanctioned non-tunnel ingress. See docs/threat-models/voip-turn.md
resource "azurerm_network_security_rule" "turn_udp" {
  name                        = "allow-turn-stun-udp"
  priority                    = 200
  direction                   = "Inbound"
  access                      = "Allow"
  protocol                    = "Udp"
  source_port_range           = "*"
  destination_port_ranges     = ["3478", "5349"]   # STUN/TURN + DTLS-TURNS
  source_address_prefix       = "Internet"
  destination_address_prefix  = "*"
  # ...resource_group_name / network_security_group_name
}

resource "azurerm_network_security_rule" "turn_tcp" {
  name                    = "allow-turn-tls-tcp"
  priority                = 201
  direction               = "Inbound"
  access                  = "Allow"
  protocol                = "Tcp"
  destination_port_ranges = ["3478", "5349"]       # TURN/TCP + TURNS/TLS
  source_address_prefix   = "Internet"
  # ...
}

resource "azurerm_network_security_rule" "turn_relay_udp" {
  name                   = "allow-turn-relay-udp"
  priority               = 202
  direction              = "Inbound"
  access                 = "Allow"
  protocol               = "Udp"
  destination_port_range = "49160-49260"           # NARROW range — see §6, matches coturn min/max-port
  source_address_prefix  = "Internet"
  # ...
}
```

`coturn --external-ip=<public-ip>` must advertise the VM's public address so relayed candidates are reachable (behind 1:1 NAT this is the public IP; in Azure the VM sees its private IP, so `external-ip=<public>/<private>` form is required).

### 4.2 AWS parity (`infra/aws/terraform/network.tf`)

`aws_security_group.instance` currently has **no ingress rules**. Add three `aws_vpc_security_group_ingress_rule` resources mirroring the above (udp 3478+5349, tcp 3478+5349, udp relay range). Caveat already flagged in that file: a NAT-gateway hardening upgrade is **incompatible** with inbound TURN — the relay needs a routable EIP, not egress-only NAT. Keep the EIP path if TURN lands on the AWS experiment.

### 4.3 DNS

Add `turn.4rgus.com` as a **DNS-only (grey-cloud)** A record → VM public IP. Cloudflare's orange-cloud proxy can't relay TURN UDP, so this record deliberately bypasses the proxy. This is the one place the real IP becomes discoverable; the threat-model note owns that trade-off explicitly. (When Option (d) becomes the default before video, this record re-points at the dedicated relay's IP and the app VM stays hidden.)

### The security story to tell (for the threat-model note `docs/threat-models/voip-turn.md`)
> The platform opens exactly three inbound port groups (STUN/TURN 3478, TURNS 5349, a 100-port UDP relay range) on the VM's public IP, gated by an NSG default-deny with three narrow allows. coturn runs non-root, read-only, all-caps-dropped except `NET_BIND_SERVICE`, resource-capped, and is **crypto-blind**: it relays opaque DTLS-SRTP and is never given the media keys (invariant 1). The HTTP/WS origin remains tunnel-only and unreachable from the internet. The real VM IP becomes discoverable via `turn.4rgus.com`; this is intrinsic to self-hosting a relay and is contained by the narrow NSG and aggressive coturn quotas (§9). No content, keys, or full URLs are logged (invariant 2); logs carry IDs + minimized IPs with short retention (§8).

This `voip-turn.md` note is one of the **GDPR/threat-model Phase-0 artifacts** enumerated in [06 §12](./06-threat-model-and-privacy.md) and [08 P0-TM](./08-roadmap-and-delivery-slices.md). For completeness, the Phase-0 documentation bundle that VoIP must land (named explicitly, not "flag for the ROPA/DPIA") is:

| Artifact | Action | What VoIP adds |
| --- | --- | --- |
| `docs/gdpr/data-residency.md` | **Revise** | Add the coturn relay row — EU-region relay, what transits it (encrypted SRTP + peer IPs), retention window. |
| `docs/gdpr/article-30-records.md` | **Revise** | New processing activity (1:1 calling), personal-data category (peer IP at the relay, call-graph/timing metadata), APNs/FCM sub-processor (V1.1 push only), and the **30-day** retention row (Q3 ruling). |
| `docs/threat-models/metadata-exposure.md` | **Extend** | Add call-graph, call-timing, and relay-peer-IP rows. |
| `docs/gdpr/dpia-voip-calling.md` | **Create** | Legal basis per activity (call setup, relay, V1.1 push/missed-call ledger). |

coturn's relay row in `data-residency.md` and the relay-peer-IP row in `metadata-exposure.md` are the two this file directly feeds.

---

## 5. Ephemeral TURN credentials (no static long-lived creds, ever)

coturn's **REST-API / `use-auth-secret`** mode is exactly the right primitive: the relay holds one HMAC shared secret; `apps/api` mints **time-limited, per-session** username/password pairs on demand. No durable TURN credential exists to leak ([coturn auth methods](https://deepwiki.com/coturn/coturn/4.1-authentication-methods), [coturn README.turnserver](https://github.com/coturn/coturn/blob/master/README.turnserver)).

**The scheme** ([Synapse TURN howto](https://matrix-org.github.io/synapse/v1.50/turn-howto.html)):
```
username  = "<unix-expiry-ts>:<opaque-session-id>"          # ts when the cred dies
password  = base64( HMAC-SHA1( key = shared_secret, msg = username ) )
```
coturn recomputes the HMAC from the username and its own copy of the secret; if it matches and the embedded timestamp isn't past, the allocation is granted. The secret never leaves the server side.

### 5.1 Where it lives in argus

- **New endpoint** in `apps/api`, e.g. `POST /calls/turn-credentials` (or fold into the call-setup response from [02-signaling-protocol-and-state-machine.md](./02-signaling-protocol-and-state-machine.md)). Guarded (not `@Public`); returns `{ urls, username, credential, ttl }`. Add the OpenAPI annotation + a controller spec pinning its guard + 200/401 contract (DoD requirement). Zod-validate the response shape in `@argus/contracts`.
- **TTL = 600 s** (Q6 ruling in [09](./09-decision-log-and-open-questions.md)) — enough headroom to allocate and tolerate clock skew; a call that outlives it keeps its existing allocation (coturn doesn't re-auth mid-allocation). Mint fresh on each call start.
- **Per-session id**, not per-user, so credentials aren't linkable across calls and one leaked cred can't be replayed after expiry.
- **Friendship gate (recommended, cheap abuse choke).** Since friendships don't gate conversation creation today, requiring an accepted friendship before minting is *new* logic — add a `FriendsService.areFriends(a,b)` check before issuing a credential. Decide the exact placement in [02](./02-signaling-protocol-and-state-machine.md); flagged here because no friendship → no relay credential → no free relay bandwidth is the cheapest abuse defense available.

### 5.2 Secret delivery (invariant 5)

The HMAC secret is a **secret** → Key Vault → Managed Identity → tmpfs credential **file**, never env. It slots straight into the existing pattern (`infra/stack/secrets/fetch-keyvault-secrets.sh`):
- Add `turn-shared-secret` to the fetch list; it writes to `/run/argus/secrets/turn_shared_secret` (tmpfs, root-owned 0444).
- `apps/api` reads it via a `*_FILE` env (`TURN_SHARED_SECRET_FILE`), matching `DATABASE_URL_FILE` etc.
- coturn reads the **same** secret file (mounted as a Docker file-secret). Because coturn's config can't `_FILE`-indirect a value inline, either (a) point `turnserver.conf`'s `static-auth-secret` at the file via an entrypoint that reads it (GlitchTip already uses an entrypoint-wrapper pattern for this), or (b) use coturn's `--static-auth-secret=$(cat …)` at launch from a tiny wrapper. Mandatory-secret-fails-closed: if the file is absent, both `apps/api` credential minting and coturn startup must fail (no fallback to a static cred).

**Rotation:** coturn supports two overlapping secrets — rotate by adding the new secret, redeploying, then dropping the old one after the max TTL window. Document in the runbook; not v1-blocking.

---

## 6. STUN strategy + relay range

- **coturn IS your STUN server.** The same listener answers STUN binding requests on 3478. No separate STUN service, no dependency on Google's public STUN (which leaks metadata to a third party and contradicts "fully self-hosted"). The client's `iceServers` lists *only* `turn:`/`turns:` + the coturn `stun:` URL.
- **Relay-only default (locked decision).** Default per-user setting forces all media through the relay so peers never learn each other's IP. Implement by configuring the **client** ICE policy `iceTransportPolicy: 'relay'` (drops host/srflx candidates) — see [05-frontend-pwa-and-webrtc.md](./05-frontend-pwa-and-webrtc.md) for the per-user toggle and [06-threat-model-and-privacy.md](./06-threat-model-and-privacy.md) for why it's the privacy default. coturn itself stays a normal TURN server; the privacy guarantee is the client refusing non-relay candidates. (Defense in depth: you may *also* set `no-loopback-peers`/`denied-peer-ip` so the relay can't be abused to reach internal nets — see §9.)
- **Narrow the relay range.** The default 49152–65535 (16k ports) is one allocation per call leg, but it's wasteful to open 16k inbound NSG ports for a solo deployment. Each relay allocation uses a handful of ports; size for peak concurrent legs with headroom. **Default: `min-port=49160 max-port=49260`** (100 ports → ~25–50 concurrent relayed call legs with margin — far more than audio V1 needs). Bump deliberately as concurrency grows, in lockstep with Option (d) before video. The NSG rule and `turnserver.conf` must agree exactly.

---

## 7. TLS for TURNS (reuse the cert flow, don't reinvent)

The Cloudflare edge owns all current TLS; the VM has no public cert. TURNS on 5349 needs its own cert on-box. Two paths:

| Path | How | Fit |
| --- | --- | --- |
| **Key-Vault-delivered cert file (recommended)** | Issue a cert for `turn.4rgus.com` (Let's Encrypt via DNS-01, or an ACME automation already in `infra/stack`), store fullchain+key in Key Vault, deliver as 0444 tmpfs files via the **existing** `fetch-keyvault-secrets.sh` pattern (`turn_tls_cert`, `turn_tls_key`). coturn `cert=`/`pkey=` point at them. | Matches invariant 5; no new on-box ACME daemon; cert rotation rides the existing secret refresh. |
| On-box ACME (certbot/lego sidecar) | A small ACME client renews directly on the VM, DNS-01 against Cloudflare. | Reintroduces on-box cert management the tunnel model was designed to avoid; more moving parts. Only if Key-Vault cert plumbing is too heavy. |

**Default: Key-Vault-delivered cert files.** DNS-01 is required (no inbound 80 for HTTP-01, and we don't want to open it). The cert is for `turn.4rgus.com` only — it's not the app origin cert. Note: TURNS is the path that "looks like HTTPS" and survives captive portals/firewalls; it's worth the cert cost even though UDP is the quality-preferred path. **Cert expiry is one of the three runbook scenarios in §9** — an expired TURNS cert silently kills the captive-portal fallback path while UDP keeps working, so it's easy to miss without the alert.

---

## 8. Logging hardened to metadata-only

coturn is chatty by default and **logs client IPs and allocation details** — a privacy hazard if retained. Invariant 2 forbids content/keys/tokens; IPs are metadata but still minimized.

`turnserver.conf` hardening:
- `log-file=stdout` → JSON-file driver with `max-size:10m max-file:3` (§3) so logs **auto-rotate and self-expire fast**. No long-term retention.
- `simple-log` (terse) rather than verbose; **never** enable `Verbose`/`-v`/`-V` in prod (verbose dumps per-packet detail).
- coturn **cannot see media plaintext** — it relays encrypted SRTP — so there's no content-leak risk in logs by construction. The residual risk is **IP + timing metadata**: who relayed, when, how much. Keep retention to the rotated window (hours, not days), and **do not ship coturn logs to the long-term Loki store** that backs Grafana. If you must centralize, scrub source IPs at the Alloy pipeline or drop coturn from Loki entirely and rely on the local rotated file for incident triage.
- No admin path to content (invariant 6) is trivially satisfied: coturn has no content; its `cli` admin interface should be **disabled** (`no-cli`) so there's no metadata-leaking admin surface either.

Banned-pattern check: ensure the log scrubbing in the existing pipeline (the `vm-ingress.md` logging rules) treats coturn's `username` field carefully — the ephemeral TURN username embeds a timestamp + session id (not secret, but log it as an opaque id, never alongside the computed password, which coturn must never log).

---

## 9. Availability, abuse controls, quotas, observability

With relay-default, **coturn availability == calling availability** for every default user. This is a **Phase-0 operational concern**, not a P3 nice-to-have. Two things ship *with* the relay in Phase-0 (see [08](./08-roadmap-and-delivery-slices.md)):

1. **Uptime/health alert** — page on coturn down, over-quota saturation, and TURNS cert near-expiry.
2. **One-page runbook stub** covering the three first-response scenarios: **TURN down**, **TURN over quota**, **cert expired**.

### 9.1 Failure modes (be honest — see [06 §11](./06-threat-model-and-privacy.md))

| Failure | Effect in audio V1 | Recovery |
| --- | --- | --- |
| **coturn restart / crash** | **Every active relayed call drops** — there is no other media path for default users. | `restart: unless-stopped` minimizes the window. Audio V1 has **no in-call recovery**: the call ends, the user re-dials. **V1.1 adds ICE-restart** as the reconnection path. Therefore: exclude coturn from routine `--force-recreate` unless its config/image actually changed. |
| **WS-gateway restart** | In-call **signaling** (mute/hangup/renegotiation) is lost; **media survives** (it's peer↔coturn↔peer, independent of the gateway). | The in-call UI must surface a **"signaling lost"** state (see [05](./05-frontend-pwa-and-webrtc.md)); media keeps flowing until either side hangs up by closing the tab. |
| **Shared-VM SPOF** | coturn contends with Postgres/Redis/HTTP on one box; a relay flood or VM reboot takes everything down. | **Accepted for V1.** Option (d) dedicated relay host is the HA lever and is the **planned default before video**. |

### 9.2 Abuse controls

TURN relays are a known abuse magnet (open relays get used for amplification, port-scanning, and free bandwidth theft). Because issuance is gated by short-lived HMAC creds from `apps/api`, a stranger can't get a credential — but defense-in-depth in `turnserver.conf`:

| Control | Setting | Why |
| --- | --- | --- |
| Deny relaying to private/loopback nets | `no-loopback-peers`, `no-multicast-peers`, `denied-peer-ip=10.0.0.0-10.255.255.255` (+ 172.16/12, 192.168/16, 169.254/16) | Stops the relay being a pivot into the Docker/Azure internal network (SSRF-via-TURN). **Must-fix.** |
| Per-allocation bandwidth cap | `max-bps=128000` for audio V1 (~128 kbps/leg covers Opus comfortably; raise to ~300 kbps for V1.1 SD video, more for HD) | Caps theft + per-call cost. |
| Total relay quota | `total-quota=50`, `user-quota=6` | Bounds concurrent allocations globally and per credential. |
| No relay to self / known-bad | `denied-peer-ip` for the VM's own public+private IP | Prevents loopback amplification. |
| App-layer rate limit | Throttle `POST /calls/turn-credentials` per user (reuse the NestJS throttler already on REST) | Caps credential minting → caps allocation churn. |
| WS inbound rate limit | Apply the gateway's `allowSubscribe` pattern to new `call.*` frames | Signaling frames aren't covered by the HTTP throttler — close that gap. |

### 9.3 Observability (Prometheus/Grafana already in the stack)

- coturn exposes a Prometheus endpoint (`prometheus` config option) — scrape **bound to localhost** (it's metadata: allocation counts, bps, errors — no content). Add a `coturn` Grafana panel: concurrent allocations, relay bps, auth-failure rate (spike = credential-leak or attack).
- **Phase-0 alerts:** coturn process down (== calling down), auth-failure-rate spike, `total-quota` saturation (capacity ceiling hit), sustained relay bps near link cap, **TURNS cert < 14 days to expiry**.

---

## 10. Capacity & cost math (relay-by-default)

Relay-default means **every 1:1 call traverses the VM twice** (peer A → coturn → peer B), so the VM's egress carries the full media bitrate for both directions of every active call.

**Per-direction bitrate (planning figures):**

| Media | Low | Typical | High |
| --- | --- | --- | --- |
| **Audio (Opus) — V1** | 40 kbps | 64 kbps | 100 kbps |
| Video (VP8/VP9, SD→HD) — *V1.1* | 1.0 Mbps | 1.5 Mbps | 2.5 Mbps |

**Per relayed call (both legs, both directions through the box).** A 1:1 relayed call = the relay receives one direction and sends it to the other peer, for each direction → the VM handles **~2× the per-direction bitrate inbound + 2× outbound** ≈ **4× per-direction total** across the NIC. For egress billing/capacity, count the **outbound** side: ~2× per-direction.

| Scenario | Per-direction | VM outbound per call (~2×) | 10 concurrent | 25 concurrent |
| --- | --- | --- | --- | --- |
| **Audio-only (V1)** | 64 kbps | ~128 kbps | ~1.3 Mbps | ~3.2 Mbps |
| Video (typical) — *V1.1* | 1.5 Mbps | ~3 Mbps | ~30 Mbps | ~75 Mbps |
| Video (HD) — *V1.1* | 2.5 Mbps | ~5 Mbps | ~50 Mbps | ~125 Mbps |

**Why audio V1 makes this section nearly a non-issue:** 25 concurrent audio legs is **~3.2 Mbps** outbound — noise on a Standard NIC, no contention with Postgres/Redis/HTTP. The 25-concurrent ceiling and the egress bill are **video problems**, and video is V1.1 — by which point Option (d) (dedicated relay) is the planned default anyway. **Link-sizing concern for V1: none.** For V1.1 video, 25 concurrent video calls (~75–125 Mbps outbound) is the practical ceiling for a single shared VM and is exactly the Option-(d) trigger.

**Egress cost (the real money — and why audio-first defuses the cost-vs-privacy tension).** Azure egress is the dominant variable cost; B2/Postgres are unaffected (media never touches them). Rough Azure egress ~€0.08/GB (EU, after free tier; verify current rate):
- One **1-hour audio call** (V1), relayed: ~64 kbps × 2 × 3600 ≈ **58 MB ≈ €0.005/call-hour**.
- One **1-hour HD video call** (V1.1), relayed: ~2.5 Mbps × 2 × 3600 ≈ **2.25 GB ≈ €0.18/call-hour**.
- **1000 audio call-hours/month ≈ €5; 100 HD video call-hours/month ≈ €18.**

**Cost takeaway:** relay-default audio is effectively free (€5 for 1000 call-hours), which is precisely why the audio-first re-cut dissolves the egress-cost-vs-privacy tension that would otherwise force a hard direct-P2P-vs-relay decision in V1. The cost line item only becomes worth watching when **video** lands in V1.1 — at which point the power-user **direct P2P opt-out** is the cost release valve (direct calls bypass the relay, €0 egress) *and* Option (d) isolates the spend onto a dedicated relay. For V1, the privacy default is the obvious, cheap default.

---

## 11. `turnserver.conf` sketch

```ini
# /etc/coturn/turnserver.conf — argus relay. Crypto-blind: relays opaque DTLS-SRTP only.

# --- Listeners ---
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
# Advertise the public IP so relayed candidates are reachable (Azure 1:1 NAT form):
external-ip=<PUBLIC_IP>/<PRIVATE_IP>
realm=turn.4rgus.com
server-name=turn.4rgus.com
fingerprint

# --- Relay range (must match the NSG rule, §6) ---
min-port=49160
max-port=49260

# --- Auth: ephemeral REST/HMAC only. No static users. (§5) ---
use-auth-secret
# static-auth-secret injected at launch from the Key-Vault file (entrypoint reads
# /run/argus/secrets/turn_shared_secret); NEVER hardcode the secret here.
no-auth-pings

# --- TLS for TURNS (§7), cert files delivered from Key Vault ---
cert=/run/argus/secrets/turn_tls_cert
pkey=/run/argus/secrets/turn_tls_key
# Modern TLS only:
no-tlsv1
no-tlsv1_1
cipher-list="ECDHE+AESGCM:ECDHE+CHACHA20"

# --- Abuse controls (§9) ---
no-loopback-peers
no-multicast-peers
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
max-bps=128000          # audio V1; raise to ~300000 for V1.1 SD video
total-quota=50
user-quota=6

# --- Logging: metadata-only, terse, short-lived (§8) ---
log-file=stdout
simple-log
# (Verbose logging deliberately NOT enabled.)

# --- No admin content surface (invariant 6) ---
no-cli

# --- Prometheus metrics, localhost only (§9) ---
prometheus

# --- Hygiene ---
stale-nonce=600
no-rfc5780          # reduce STUN feature surface used for NAT-behavior probing
mobility
```

---

## 12. PR-sized slices

These map onto the audio-core critical path in [08](./08-roadmap-and-delivery-slices.md). Note T-0: the coturn availability deliverables are **Phase-0**, shipped with the relay, not deferred.

| Slice | Scope | Gates |
| --- | --- | --- |
| **T-1** | Threat-model note `docs/threat-models/voip-turn.md` (the §4 security story) + revise `vm-ingress.md` + the GDPR/threat-model Phase-0 bundle rows this file feeds (`data-residency.md` coturn-relay row, `metadata-exposure.md` relay-peer-IP row) | Required *before* infra code (DoD: security-relevant feature → threat model first) |
| **T-2** | Terraform NSG inbound rules (Azure + AWS parity) + `turn.4rgus.com` DNS-only record | `infra-reviewer`; **manual `terraform apply` confirmation** (never auto) |
| **T-3** | Key Vault secret + cert delivery: add `turn-shared-secret`, `turn_tls_cert/key` to `fetch-keyvault-secrets.sh`; DNS-01 cert issuance | `infra-reviewer`, `security-boundary-auditor` |
| **T-4** | `coturn` Compose service (incl. healthcheck + `restart: unless-stopped`) + `turnserver.conf` + `compose-guard` exception (assert single host-net service == coturn) | `infra-reviewer`; CI `compose-guard` updated |
| **T-5** | `apps/api` `POST /calls/turn-credentials` (HMAC mint, 600 s TTL, throttled, friendship gate) + OpenAPI + controller spec + Zod contract | `security-boundary-auditor`; 42Crunch audit; controller spec pins guard/status |
| **T-6 (Phase-0 ops)** | coturn uptime/health alert (down == calling down) + Grafana panel (allocations, relay bps, auth-fail spike, cert-expiry) + one-page runbook stub (TURN down / over quota / cert expired); confirm coturn logs excluded from long-term Loki | `infra-reviewer`; Phase-0 DoD |

Client-side ICE config, `iceTransportPolicy: 'relay'` default, and the per-user direct-P2P toggle live in [05-frontend-pwa-and-webrtc.md](./05-frontend-pwa-and-webrtc.md) and [06-threat-model-and-privacy.md](./06-threat-model-and-privacy.md); the credential-fetch call sequence is in [02-signaling-protocol-and-state-machine.md](./02-signaling-protocol-and-state-machine.md).

---

### Sources
- [coturn Authentication Methods — DeepWiki](https://deepwiki.com/coturn/coturn/4.1-authentication-methods)
- [coturn README.turnserver](https://github.com/coturn/coturn/blob/master/README.turnserver)
- [Configuring a TURN Server — Synapse (REST/HMAC scheme)](https://matrix-org.github.io/synapse/v1.50/turn-howto.html)
- [How to Set Up Self-Hosted STUN/TURN Servers for WebRTC — WebRTC.ventures, Jan 2025](https://webrtc.ventures/2025/01/how-to-set-up-self-hosted-stun-turn-servers-for-webrtc-applications/)
- [Cloudflare Spectrum docs](https://developers.cloudflare.com/spectrum/) · [Spectrum for UDP — Cloudflare blog](https://blog.cloudflare.com/spectrum-for-udp-ddos-protection-and-firewalling-for-unreliable-protocols/)
- [Cloudflare Realtime TURN Service](https://developers.cloudflare.com/realtime/turn/) · [Realtime TURN FAQ](https://developers.cloudflare.com/realtime/turn/faq/)
