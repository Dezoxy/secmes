# Threat model: VoIP 1:1 calling (audio core, V1)

> **Status: ratified — governs the VoIP V1 (audio-core) build.** This is the canonical
> threat-model note required by `AGENTS.md` (Definition of Done) for the VoIP feature: the copy
> the `security-boundary-auditor` and the 6-invariant gate target. Its design rationale and the
> full plan set live in `docs/planning/voip/` (00–09); this note is kept in sync with the
> source-of-truth [06 — Threat Model & Privacy](../planning/voip/06-threat-model-and-privacy.md).
> The companion infra note is [`voip-turn.md`](./voip-turn.md); [`vm-ingress.md`](./vm-ingress.md)
> is revised in the same bundle because VoIP introduces the platform's first sanctioned
> non-tunnel ingress.
>
> **Scope of this note:** the privacy and security posture of **1:1 calls** under the locked V1
> scope (see [00 — Overview & Goals](../planning/voip/00-overview-and-goals.md)): **V1 = 1:1
> _audio only_, relay-only, foreground-ring only, single-device per user.** Video,
> ICE-restart/reconnection, push-wake + missed-call ledger, multi-device ring-all, and the
> metadata-ledger/prune chain are deferred to **V1.1** and are threat-modelled here as *future*
> surface so the design doesn't paint itself into a corner. Group calls / SFU are explicitly out
> of scope and call out their *new* threats where relevant. Read alongside
> [01 — Architecture & Crypto Model](../planning/voip/01-architecture-and-crypto-model.md),
> [02 — Signaling Protocol & State Machine](../planning/voip/02-signaling-protocol-and-state-machine.md),
> [03 — Infrastructure: TURN/coturn & Networking](../planning/voip/03-infrastructure-turn-and-networking.md),
> [04 — Server API & Database](../planning/voip/04-server-api-and-database.md), and
> [05 — Frontend, PWA & WebRTC Client](../planning/voip/05-frontend-pwa-and-webrtc.md).

---

## 1. What's different about calls

Chat in argus is **content-confidential and metadata-minimal**: the server forwards opaque MLS ciphertext and learns only `(tenant, conversation, sender, timestamp, size)`. Calls do not change the content story — media is E2EE browser-to-browser via DTLS-SRTP, and the server never holds a media key. **The new risk surface is almost entirely metadata and infrastructure**, not content:

- A **TURN relay** sees both peers' IP/port and the encrypted media flow (timing, volume, duration) for every relayed call — by design, since relay-only is the default and (in audio V1) the *only* path.
- **Signaling** (offer/answer/ICE/hangup) is a new real-time event class that, even when the *payload* is E2EE, leaks **who-calls-whom and when** through routing metadata the server must see to deliver it.
- Calls are **interactive and synchronous**, so they create an **online-presence oracle** that store-and-forward chat never did: a call only connects if the callee is reachable *right now*. V1's foreground-ring-only model actually *narrows* this oracle — there is no push-wake, so a call only rings a peer who already has the app open.
- The relay forces the platform's **first public inbound port**, breaking the "tunnel-only, zero published ports" ingress invariant (see [voip-turn.md](./voip-turn.md) / [03](../planning/voip/03-infrastructure-turn-and-networking.md)).
- **Authenticating the call's sender is a new crypto path, not a reuse.** The platform's MITM defence (binding the DTLS fingerprint to a known peer identity) requires verifying *who sent the call signal*. Today `packages/crypto`'s `decrypt()` returns a bare string and surfaces **no sender identity** — so this needs a **new, crypto-reviewer-gated authenticated-sender decrypt path**. It is a hard **Phase-0 predecessor** of the first call that ever connects (see §4, §5, and [01](../planning/voip/01-architecture-and-crypto-model.md)). Do not describe the MITM defence as "zero new crypto."

This note enumerates those metadata threats, verifies the design against all 6 non-negotiable invariants, frames the **relay-vs-direct** choice as the user's privacy dial (a V1.1 setting; V1 is relay-only with no toggle), and records residual risk and failure modes.

---

## 2. Assets

| # | Asset | Sensitivity | Where it lives |
|---|-------|-------------|----------------|
| A1 | **Call media** (audio frames in V1; +video in V1.1) | Critical | E2EE in transit (DTLS-SRTP) between browsers; never on server |
| A2 | **Media keys** (DTLS-SRTP master secrets) | Critical | Negotiated in-browser; MLS-bound via exporter (V1.1, see [01](../planning/voip/01-architecture-and-crypto-model.md)); never serialized to server |
| A3 | **Call graph** — who called whom | High | Signaling routing metadata; optional `call_sessions` row is **V1.1 only** |
| A4 | **Call timing/duration/frequency** | High | Inferable at server (signaling) and at TURN (relay flow) |
| A5 | **Peer IP addresses** | High | Always visible to TURN; visible to the *other peer* only if direct P2P opt-in (V1.1) |
| A6 | **Online-presence signal** | Medium-High | Implicit in whether a call rings/connects |
| A7 | **SDP / ICE candidates** | Medium | E2EE payload; if leaked, reveals IPs, codecs, fingerprints |
| A8 | **TURN credentials** (shared secret / time-limited HMAC creds) | High | Key Vault → credential file on VM; ephemeral per-session creds to clients (TTL 600s — see [09](../planning/voip/09-decision-log-and-open-questions.md) Q6) |
| A9 | **Tenant isolation of call metadata** | Critical | RLS on `call_sessions` (V1.1, *if* persisted) |
| A10 | **Sender identity on the call signal** | Critical | Recovered only via the new authenticated-sender decrypt path; basis for the MITM/fingerprint binding |
| A11 | **Push-notification wake metadata** | Medium | V1.1 only — V1 has no push-wake. Content-free ping; existence/timing still observable |

---

## 3. Adversaries

| ID | Adversary | Capability | Primary goal |
|----|-----------|-----------|--------------|
| **ADV-SRV** | Malicious server / insider / compromised host | Full read of DB, app logs, signaling traffic, TURN process; can run queries, read memory | Recover content (A1/A2) or build a call graph (A3/A4) |
| **ADV-NET** | Passive/active network observer (ISP, hostile Wi-Fi, state actor on the wire) | Sees encrypted packets to/from TURN and (if direct) between peers; traffic analysis | Confirm who-talks-to-whom, timing, that a call happened |
| **ADV-PEER** | Malicious call peer (an accepted friend or a spoofer) | A legitimate endpoint in the call | Learn the other party's real IP (A5); MITM media (A2); harass |
| **ADV-TEN** | Another tenant on the same multi-tenant deployment | Authenticated user in tenant B | Read/observe tenant A's call metadata (cross-tenant breach) |
| **ADV-ABUSE** | Abusive in-tenant user | A valid, possibly-befriended user | Spam-call, ring-flood, harass, enumerate presence |

---

## 4. STRIDE-ish enumeration — focused on call *metadata*

Content (A1/A2) is handled by DTLS-SRTP + MLS fingerprint binding ([01](../planning/voip/01-architecture-and-crypto-model.md)); SRTP is non-optional in WebRTC and the media key never reaches the server. The table below concentrates where the real exposure is: **metadata** — plus the one *content-adjacent* item (MITM via fingerprint substitution) that depends on the new authenticated-sender path.

| Threat (STRIDE) | Vector | Who sees it | Mitigation | Residual |
|---|---|---|---|---|
| **I — Who-calls-whom (call graph)** | Server must route signaling between two `(tenant, sub)` identities | ADV-SRV | Route over the existing room/identity model (server-verified `(tenant,sub)` only, never client IDs); **V1 persists no `call_sessions` row** — signaling is emitted straight onto the bus, no DB write (mirrors the "real-time-only, ephemeral" chat pattern). In V1.1, a row kept for the missed-call list is **metadata-only**, 30-day TTL (see [09](../planning/voip/09-decision-log-and-open-questions.md) Q3), RLS-scoped | Server can observe the graph *in real time* even without persistence. **Accepted** — unavoidable for any routed signaling; minimized by no-persistence in V1 |
| **I — Call timing & duration** | Offer→answer→hangup events through the server; relay flow start/stop at TURN | ADV-SRV, ADV-NET | No durable timing log in V1; TURN logging minimized (§7); media itself is opaque | Timing inferable in real time. **Accepted** |
| **I — Call frequency / pattern** | Repeated signaling between the same pair | ADV-SRV | No aggregation, no analytics on signaling; no per-pair counters | Statistical inference possible at the server. **Accepted; documented** |
| **I — Online-presence oracle** | A call only connects if callee has a live socket; ring vs. instant-fail distinguishes online/offline | ADV-ABUSE, ADV-SRV | V1 is **foreground-ring only** (no push-wake) so the oracle is bounded to "app currently open." **Uniform "calling…" UX** with a fixed minimum ring window before any failure is shown, so "offline" and "declined/no-answer" are not trivially distinguishable; **no presence API** exists today (grounding: zero presence/last-seen anywhere) and none is added; friendship gate (§9) limits who can probe at all | A determined caller still learns reachability over time. **Needs-work** on the uniform-timeout UX detail |
| **I — IP-to-relay (always)** | TURN sees both peers' source IP/port for every relayed call | ADV-SRV (TURN host), ADV-NET near TURN | This is **the privacy cost of relay-only** and is *intended*: peers never see each other (§6). coturn must restrict internal ranges, minimize logging (§7), and keep relay addresses off durable storage | Operator-of-TURN sees both IPs. **Accepted** — it's the design's privacy trade (peers blinded, single semi-trusted relay) |
| **I — IP-to-peer (direct only, V1.1)** | If a user opts into direct P2P, host/srflx candidates expose their real IP to the other peer | ADV-PEER | **Not present in V1** (relay-only, no toggle). When direct P2P ships in V1.1 it is strictly opt-in per-user; relay-only stays the default exactly because ICE leaks IPs to peers. UI must state plainly: "the other person will see your IP address." Both peers' settings considered — **relay-only wins** if *either* side requires it | Opt-in users accept peer IP exposure knowingly. **Accepted by user choice** (V1.1) |
| **I — TURN logs** | coturn can log allocations, 5-tuples, usernames, credentials | ADV-SRV | Run coturn with `--no-stdout-log` and a minimal log target; **no verbose/`-v`**; never log credentials; logs (if any) carry no message-derived data and follow short retention | Live process memory still holds 5-tuples during a call. **Accepted** with minimized logging |
| **I — Push-notification metadata (V1.1)** | A "call incoming" push must wake a backgrounded callee out-of-band | ADV-SRV, push provider | **Not in V1** (foreground-ring only). In V1.1, reuse the existing **content-free** push (`{"type":...}` only — no caller, no conversation, no text — grounding `src/sw.ts`); a `call` push type carries **no caller identity**; the client fetches signaling over the authenticated socket after wake. APNs/FCM become named sub-processors in the ROPA (§7) | Existence + timing of a push is observable to the push provider. **Accepted** (inherent to Web Push) — V1.1 only |
| **S — Caller spoofing** | Forged "from" in signaling | ADV-PEER, ADV-ABUSE | Server routes only by **server-verified** `(tenant, sub)` from first-frame token auth — never client-supplied IDs (grounding: ws-gateway authz). Endpoint identity authenticity for media is the fingerprint-binding job (next row), which depends on the new authenticated-sender path | Low. **Accepted** |
| **S/T — DTLS fingerprint substitution (MITM)** | Active attacker rewrites the SDP fingerprint in transit | ADV-SRV, ADV-NET | **V1 defense:** signaling rides the **authenticated WSS** gateway, and the SDP/fingerprint is carried **inside MLS-encrypted payload** so the crypto-blind server can neither read nor alter it; the **new authenticated-sender decrypt path** in `packages/crypto` lets the recipient confirm *which* MLS member sent the offer, so an attacker cannot inject an offer as the friend. The existing **manual safety-number ceremony** is the human-verifiable root of trust in V1. **V1.1 adds** cryptographic **MLS-exporter binding** of the DTLS fingerprint to that identity ([01](../planning/voip/01-architecture-and-crypto-model.md)), removing reliance on the manual ceremony | Lowered to *detectable/fail-closed* in V1 via authenticated-sender + MLS-wrapped SDP + safety number; exporter binding (V1.1) closes the residual. **Needs-work** — the authenticated-sender path is a **Phase-0 blocker** of the first connecting call; exporter binding is V1.1 (Q5: exporter key = no for V1, async shim — see [09](../planning/voip/09-decision-log-and-open-questions.md)) |
| **T — Tamper with signaling to disrupt** | Drop/alter ICE to break a call | ADV-SRV | Failure mode is "call fails to connect" — the **correct** fail-closed behavior; no integrity claim beyond MLS on payload | Denial only, no content risk. **Accepted** |
| **R — Repudiation** | "I never called you" | n/a | **Out of scope** — argus is privacy-first, not an audit/non-repudiation system. No durable call ledger in V1 by design (§9) | Intentional. **Accepted** |
| **I — Cross-tenant metadata read (V1.1)** | Reading tenant A's call rows/events as tenant B | ADV-TEN | Room key is `${tenantId}:${conversationId}` (tenant baked in → fan-out can't cross tenants, grounding ws-gateway); the V1.1 `call_sessions` table gets `tenant_id` + FORCE RLS `TO argus_app` + leading `tenant_id` index (grounding db; invariant 3) | Low. **Accepted** if/when the table ships with its RLS gate |
| **D — Ring/relay flooding** | Spam-calling, ICE flooding, TURN allocation exhaustion | ADV-ABUSE | Per-socket inbound rate-limit on `call_*` frames (extend `allowSubscribe` pattern); friendship gate (§9); coturn quotas (`--total-quota`, `--max-bps`, `--user-quota`); block list | DoS pressure remains possible at scale. **Needs-work** on quota tuning |
| **E — Privilege/relay abuse** | Use TURN as an open relay to internal services or third parties | ADV-ABUSE, external | coturn **time-limited credentials** (REST/HMAC, 600s TTL), `--no-multicast-peers`, **deny RFC1918/internal ranges**, `--denied-peer-ip` for the VM's own subnet; isolate TURN on its own security group | Low with correct config. **Needs-work** (config must be reviewed by `infra-reviewer`) |
| **E — Admin path to content/metadata** | Ops surface exposing call detail | ADV-SRV insider | Admin surfaces stay **metadata-only** (invariant 6); no call content ever, no recording (§9) | None if invariant held. **Accepted** |

---

## 5. Per-invariant verification (all 6)

| # | Invariant | How the VoIP design satisfies it | Status |
|---|-----------|----------------------------------|--------|
| **1** | **Server is crypto-blind** | Media is DTLS-SRTP between browsers; coturn relays **encrypted SRTP** and must **never** terminate media crypto (it's a packet relay, not a media server). Signaling payload (SDP/ICE) rides **inside MLS ciphertext** — the server forwards an opaque blob exactly like a chat message. No media key ever leaves a device. | ✅ by design — **block** any proposal where TURN decrypts media or the server reads SDP |
| **2** | **Never log/persist secrets or content** | No media, no SDP, no ICE, no media keys, no TURN credentials in logs. coturn runs with minimized logging (`--no-stdout-log`, no `-v`, no credential logging). App logs carry IDs/metadata only (existing posture). Ephemeral TURN creds never logged. | ✅ — verify with banned-pattern grep + `infra-reviewer` |
| **3** | **tenant_id + RLS + leading index on every tenant table** | **V1 persists no call table.** When the V1.1 `call_sessions` (missed-call UX) lands it follows the `0042_friendships.sql` template: `tenant_id`, ENABLE+FORCE RLS, isolation policy scoped **`TO argus_app`** with the `nullif` guard, leading `tenant_id` index, composite FKs, metadata-only columns. | ✅ — **block** a call table without RLS |
| **4** | **No hand-rolled crypto** | DTLS-SRTP is the browser's WebRTC stack (not argus code). The **new authenticated-sender decrypt path** and any media-key binding go through `packages/crypto`'s MLS layer (exporter, RFC 9420) — **no new primitives**, but it *is* new code on the crypto boundary and must pass `crypto-reviewer` before the first connecting call. Safety numbers/peer-identity reused from MLS. | ✅ provided the new path is crypto-reviewer-gated — **block** any custom KDF/cipher in the call path |
| **5** | **Secrets from Key Vault via Managed Identity, as files** | coturn's static-auth shared secret arrives via the existing `fetch-keyvault-secrets.sh` path as a 0444 tmpfs **file** (fits the existing pattern). No long-lived creds in env. A `turns:` TLS cert, if used, is a Key-Vault-delivered file, not on-box ACME. | ✅ — verify with `infra-reviewer` |
| **6** | **No admin path to content** | No recording, no transcription, no server-side media. Admin/ops sees only metadata (call count/timing if persisted in V1.1), never media or SDP. | ✅ by design |

**Net:** the design is invariant-compatible **provided** (a) TURN never terminates media crypto, (b) SDP/ICE always travels inside MLS ciphertext, (c) the new authenticated-sender decrypt path passes `crypto-reviewer` before any connecting call, (d) the V1.1 `call_sessions` table ships with RLS, and (e) TURN secrets ride the file-secret path. Each is a hard gate, not a guideline.

---

## 6. Relay-default vs. direct-P2P — the user's privacy dial (V1.1)

This is the single most important *user-facing* privacy control. It is a **per-user setting**, default = **relay-only** — but the *toggle* is a **V1.1 feature**. **V1 ships relay-only with no toggle at all**, which is the strictest posture and conveniently sidesteps the IP-to-peer threat entirely for the first release. (The storage — a `call_relay_only boolean not null default true` column on `users` — lands in V1 as its own slice; the credential endpoint then reads it to enforce relay-only shaping server-side from day one. Only the *user-facing toggle UI* is deferred to V1.1.)

| Mode | Who learns your IP | Latency / quality | Bandwidth cost (operator) | Best for |
|------|--------------------|-------------------|---------------------------|----------|
| **Relay-only (V1 default; only mode in V1)** | Only the **TURN server** (semi-trusted, operator-run, EU) — **the peer never sees your IP** | Slightly higher (one hop via relay) | Operator pays media egress | Privacy-by-default; calling a contact you don't want to expose your IP to |
| **Direct P2P (V1.1 opt-in)** | The **other peer** sees your real (srflx/host) IP | Lowest | Operator pays ~nothing | Power users on a trusted call who want best quality and accept IP exposure |

**Design rules (apply when the toggle lands in V1.1; V1 hard-codes relay-only):**
- Default **relay-only**: ICE offers **only relay candidates**; host/srflx are suppressed so neither peer nor passive observers near the peer learn the IP.
- **Conservative AND**: if *either* peer is relay-only, the call is relay-only. A power user opting into direct cannot downgrade a privacy-conscious peer.
- **Honest UI copy** at opt-in: "Direct calls are faster but the other person will see your IP address (your approximate location)." No dark patterns.
- The setting fits cleanly as a **`call_relay_only boolean not null default true` column on `users`** (grounding: no settings table exists; single scalar → column, not a new table), inheriting `users` RLS automatically. Default is **`true`** (relay-only).

---

## 7. GDPR / EU data-residency

argus is a solo-EU-developer, privacy-first product; the bar is **data minimization by default**, not compliance theater.

### 7.1 GDPR artifact updates — a named Phase-0 bundle

VoIP touches the platform's canonical privacy artifacts. These are **explicit Phase-0 deliverables** ([08 P0-TM](../planning/voip/08-roadmap-and-delivery-slices.md)), not a vague "flag for the ROPA/DPIA." All four ship in this same docs bundle:

| Artifact | Action | What VoIP adds |
|---|---|---|
| `docs/gdpr/data-residency.md` | **Revise** | Add a **coturn relay** row: relay processes peer IP/port transiently, runs on the EU VM, never logs or persists IPs, no third-party TURN/egress out of region. |
| `docs/gdpr/article-30-records.md` | **Revise** | Add VoIP as a **new processing activity**; add **peer IP address** as a personal-data category; add **APNs/FCM** as a sub-processor (V1.1 push-wake only); add the **retention row = 30 days** for the V1.1 `call_sessions` missed-call metadata ([09](../planning/voip/09-decision-log-and-open-questions.md) Q3). |
| `docs/threat-models/metadata-exposure.md` | **Extend** | Add rows for **call-graph** (who-calls-whom via signaling routing), **call-timing/duration/frequency**, and **relay peer-IP** exposure — cross-referencing this note. |
| `docs/gdpr/dpia-voip-calling.md` | **Create** | New DPIA recording the **legal basis per processing activity** (signaling routing, transient relay IP processing, V1.1 push-wake, V1.1 direct-P2P consent) and the DPIA-worthy items in §7.3. |

### 7.2 Residency, minimization & retention

**Residency**
- **coturn runs on the same EU VM** (Azure `germanywestcentral` / AWS `eu-central-1` per grounding). No third-party TURN (e.g. Twilio) — that would export 5-tuples/IPs outside the EU and add a processor. Self-hosting keeps **all relay metadata in-region**.
- Any persisted call metadata (V1.1) stays in the EU Postgres; no analytics export.

**Minimization & retention**
- **IP addresses are personal data under GDPR.** TURN inevitably processes them transiently; the mitigation is **don't log them** (`--no-stdout-log`, no verbose), **don't persist** them, and document the transient processing in `data-residency.md` + `dpia-voip-calling.md`.
- **Signaling is ephemeral** — emitted to the bus, never written to disk. Nothing to retain in V1.
- **V1.1 `call_sessions`**: 30-day TTL (Q3) with a dedicated least-privilege prune role + time-windowed RLS policy (follow `0044_messages_prune_role.sql`), **not** a reuse of an existing prune role — per-table auditability. The retention literal must match the ROPA row.

### 7.3 DPIA-worthy items (record in `dpia-voip-calling.md`)
1. Real-time processing of **peer IP addresses** at the TURN relay (even if unlogged).
2. The **online-presence oracle** — an implicit signal that a data subject is reachable at a given time (bounded in V1 to "app open").
3. The **direct-P2P opt-in** (V1.1) — peer-to-peer IP disclosure requires informed consent (the honest UI copy in §6 is the consent surface).
4. **Push-notification wake** (V1.1) — existence/timing observable to the push provider (APNs/FCM sub-processor).

**Data-subject rights:** with no durable call log in V1, there is essentially **nothing to export or erase** for calls — the strongest possible posture. In V1.1, the missed-call metadata is the only erasable artifact and is covered by the 30-day TTL.

---

## 8. Abuse, spam-calling & harassment

| Control | Mechanism | Tier |
|---|---|---|
| **Friendship gating** | A call may only be *placed* to an **accepted friend**. Today friendships do **not** gate conversation/messaging (grounding: no `friend` check in messaging) — so this is **new logic** for VoIP and gates calls even though chat stays open. Stops cold-calling strangers entirely. | **Must** |
| **Per-socket call rate limit** | Extend the existing `allowSubscribe` per-socket throttle to `call.signal`/`call.release` inbound frames (these bypass the HTTP throttler — grounding ws-gateway). Bounds ring-flood and ICE-flood. | **Must** |
| **Block** | A block hard-stops both calls and (eventually) messages from that user; enforced server-side before any signaling routes. In V1, unfriend (hard-DELETE) transitively removes call ability; a dedicated block list is V1.1+. | **Should** |
| **coturn quotas** | `--user-quota`, `--total-quota`, `--max-bps` cap relay abuse and bandwidth-exhaustion DoS. | **Should** |
| **Uniform ring/timeout** | Fixed minimum "calling…" window so abusive callers can't use connect-speed as a presence/online probe (§4 online-presence oracle). | **Should** |
| **No call-history enumeration** | Wrong-caller / non-friend attempts return uniform responses (reuse the friends-module "uniform 202, no oracle" posture). | **Should** |

---

## 9. Explicit NON-goals

These are **out of scope by design**, not omissions. Adding any of them would violate the invariants or the product's privacy promise:

- **No call recording** — anywhere, server or client-prompted. There is no server-side media path to record from (invariant 1/6).
- **No lawful-intercept / key-escrow backdoor.** The server holds no media key and cannot be compelled to produce one it never has.
- **No server-side transcription / speech-to-text / content analysis** — the server is crypto-blind; it cannot see media.
- **No durable call ledger / CDR in V1** — no who-called-whom history persisted server-side. The V1.1 missed-call hint is short-TTL (30-day) metadata only.
- **No presence/last-seen service** — none exists today; VoIP does not introduce one. Reachability is revealed only transiently at call time.
- **No video in V1** — audio-first; video is a named V1.1 phase.
- **No group calls in V1** — SFU is future-only; an SFU is a *new* metadata holder (it sees all participants' flows) and will require its own threat-model addendum.
- **No native CallKit/ConnectionService integration** — PWA-only; background-receivability limits are an honest constraint, not a feature gap to fake (see [05](../planning/voip/05-frontend-pwa-and-webrtc.md)). If "rings a locked phone" ever becomes a hard requirement, Capacitor is a prerequisite — a decision fork, not a deferral ([09](../planning/voip/09-decision-log-and-open-questions.md) Q4).

---

## 10. Residual-risk register

| ID | Risk | Severity | Mitigation in place | Disposition |
|----|------|----------|---------------------|-------------|
| R1 | Server observes the **call graph in real time** (who-calls-whom) via signaling routing | Medium | No persistence in V1; route by server-verified identity only; minimized logging | **Accepted** — inherent to any routed signaling |
| R2 | Server/observer infers **call timing, duration, frequency** | Medium | No durable timing log; no analytics/counters | **Accepted** |
| R3 | **TURN operator sees both peers' IPs** for every relayed call | Medium | Self-hosted EU relay; unlogged; relay-only is *itself* the peer-blinding privacy win | **Accepted** — the deliberate trade vs. peer IP exposure |
| R4 | **Peer learns your IP** in direct-P2P mode | Medium | **Absent in V1** (relay-only, no toggle). V1.1: opt-in only; conservative-AND; honest consent UI; default off | **Accepted by user choice** (V1.1) |
| R5 | **Online-presence oracle** via connect/fail timing | Medium | Foreground-ring-only bounds it in V1; friendship gate; planned uniform ring timeout | **Needs-work** — uniform-timeout UX must ship with V1 |
| R6 | **DTLS-fingerprint MITM** by active server/network attacker | Medium-High | WSS signaling + SDP inside MLS ciphertext; **new authenticated-sender decrypt path** (Phase-0 blocker) + exporter-binding (V1.1) make substitution *detectable* | **Needs-work** — authenticated-sender path is a hard Phase-0 predecessor of the first connecting call; exporter binding follows in V1.1 ([01](../planning/voip/01-architecture-and-crypto-model.md)) |
| R7 | **Public TURN port** breaks zero-ingress model; first internet-facing attack surface | High | Strict NSG/SG rules, isolated relay, coturn hardening, CI compose-guard exception modeled explicitly | **Needs-work** — resolved in [voip-turn.md](./voip-turn.md); requires `infra-reviewer` sign-off |
| R8 | **Relay abuse / open-relay** to internal or third-party hosts | High | Time-limited HMAC creds (600s TTL), deny RFC1918, `--no-multicast-peers`, isolation | **Needs-work** — config review required |
| R9 | **Spam-calling / ring-flood / harassment** | Medium | Friendship gate + per-socket rate limit + unfriend + coturn quotas | **Needs-work** — quota tuning + enforcement to implement |
| R10 | **Cross-tenant call-metadata read** (V1.1 table) | High | FORCE RLS `TO argus_app`, leading `tenant_id` index, composite FK | **Accepted** *iff* the V1.1 table ships with the RLS gate; **block** otherwise |
| R11 | **Push-wake metadata** observable to push provider (V1.1) | Low | Content-free push, no caller identity; **absent in V1** | **Accepted** — inherent to Web Push (V1.1) |
| R12 | **Real IP exposed via public `turn.<domain>` DNS** (bypasses Cloudflare proxy) | Medium | Documented trade in [voip-turn.md](./voip-turn.md); a dedicated relay host/IP (ingress Option (d)) is the mitigation, slated to become the default before video | **Accepted** for V1 single-VM; Option (d) is the HA/privacy lever for V1.1 |
| R13 | **coturn outage = calling outage** for every default user (relay-only) | High | coturn `restart:unless-stopped` + compose healthcheck; uptime/health alert + runbook stub as **Phase-0** deliverables (§11, [08 P0](../planning/voip/08-roadmap-and-delivery-slices.md)) | **Needs-work** — availability is a P0 operational concern, not P3 |

**Block list (must-fix before merge):** R6 (authenticated-sender path, a Phase-0 predecessor of any connecting call), R7, R8, R10 (gate, when the V1.1 table lands), R5 (uniform timeout), R13 (coturn health alert + runbook in Phase-0), and all six §5 invariant gates.

---

## 11. Call-reliability & failure modes

Relay-only default means **coturn availability == calling availability** for every default user, and the single shared VM concentrates several failure modes. State them plainly:

| Failure | Effect | Mitigation / behavior |
|---|---|---|
| **coturn restart** | **Drops ALL active relayed calls** — the relay holds per-call allocations in process memory. In V1 there is **no recovery** (ICE-restart is V1.1); the call simply ends. | coturn runs `restart:unless-stopped` **and is excluded from routine `--force-recreate`** unless its config/image actually changed. A compose **healthcheck** plus an uptime/health alert and a one-page runbook stub (TURN down / over quota / cert expired) are **Phase-0 deliverables** ([08 P0](../planning/voip/08-roadmap-and-delivery-slices.md)). |
| **WS-gateway restart** | Kills **in-call signaling** (mute/hangup/renegotiation) while **media survives** (DTLS-SRTP is peer-to-relay, independent of the WS). | In-call UI must show a **"signaling lost"** state so the user understands controls are temporarily dead and can hang up locally. |
| **Single shared VM (SPOF)** | A VM-level failure takes down API, gateway, *and* relay together. | **Accepted for V1.** Ingress Option (d) — a dedicated relay host/IP — is the HA lever, slated to become the default before video. |
| **Ephemeral TURN cred expiry mid-setup** | A 600s-TTL credential ([09](../planning/voip/09-decision-log-and-open-questions.md) Q6) that expires before ICE completes fails the allocation. | 600s comfortably exceeds setup time; client requests fresh creds per call attempt. |

---

## 12. Verification checklist (Definition of Done)

- [x] *(shipped in this docs bundle)* This note lives at `docs/threat-models/voip-calling.md`; `docs/threat-models/vm-ingress.md` revised for the new ingress.
- [x] *(shipped in this docs bundle)* **GDPR artifact bundle (Phase-0)**: `docs/gdpr/data-residency.md` (coturn relay row), `docs/gdpr/article-30-records.md` (new activity + peer-IP category + APNs/FCM sub-processor + 30-day retention row), `docs/threat-models/metadata-exposure.md` (call-graph / call-timing / relay-peer-IP rows), and **new** `docs/gdpr/dpia-voip-calling.md` (legal basis per activity).
- [ ] `crypto-reviewer` has signed off the **new authenticated-sender decrypt path** in `packages/crypto` — this gate clears **before the first connecting call** (slice **P0-CRYPTO**).
- [ ] Banned-pattern grep proves no media/SDP/ICE/keys/TURN-creds in any log path.
- [ ] coturn config reviewed by `infra-reviewer`: minimized logging, deny-internal, quotas, 600s time-limited creds, Key-Vault file secret; **compose healthcheck present**; coturn **uptime/health alert + runbook stub** landed as Phase-0 deliverables.
- [ ] If/when the V1.1 `call_sessions` exists: `db-migration` skill output shows `tenant_id` + FORCE RLS `TO argus_app` + leading index + 30-day prune role; a `route-meta` controller spec pins guard/status.
- [ ] Relay-only verified end-to-end (ICE emits relay candidates only); in V1.1 the direct-P2P opt-in shows the honest IP-exposure copy.
- [ ] Friendship gate + per-socket `call.*` rate limit enforced server-side, with E2E coverage (`context.grantPermissions(['microphone'])` for audio V1; add `'camera'` with video in V1.1).
- [ ] `crypto-reviewer` confirms no hand-rolled crypto and that any DTLS-fingerprint binding uses the MLS exporter only.

---

*Design rationale, comparative survey, and the full slice plan: [`docs/planning/voip/`](../planning/voip/) (00–09). This note is the canonical, in-tree threat model; the planning set is its origin and must be kept in sync when either changes.*
