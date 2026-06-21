# 09 — Decision Log & Open Questions

> Part of the argus VoIP planning set. Siblings: [00 — Overview & Goals](./00-overview-and-goals.md) · [01 — Architecture & Crypto Model](./01-architecture-and-crypto-model.md) · [02 — Signaling Protocol & State Machine](./02-signaling-protocol-and-state-machine.md) · [03 — Infrastructure: TURN/coturn & Networking](./03-infrastructure-turn-and-networking.md) · [04 — Server API & Database](./04-server-api-and-database.md) · [05 — Frontend, PWA & WebRTC Client](./05-frontend-pwa-and-webrtc.md) · [06 — Threat Model & Privacy](./06-threat-model-and-privacy.md) · [07 — Comparative Survey](./07-comparative-survey.md) · [08 — Roadmap & Delivery Slices](./08-roadmap-and-delivery-slices.md)
>
> **What this file is.** The single place that records *what was decided, why, and what it costs* (the Decision Log), and *what is still genuinely undecided and needs a human or `security-architect` call* (Open Questions). It is the entry point for a reviewer who wants the bottom line without reading all eight domain drafts. Every row links back to the draft that owns the detail.
>
> **Status.** Planning only. No VoIP code exists yet (`grep` confirms zero WebRTC/TURN/`getUserMedia` across the repo). Nothing here is implemented; this is the contract the implementation must conform to.
>
> **Receivability vocabulary (used precisely throughout this set — S7).** Three distinct things, never conflated:
> - **ring** — a real, foreground, in-app ring with ringtone. Requires the callee's app open and focused. This is the *only* incoming-call experience V1 commits to.
> - **wake-banner** — an Android-backgrounded Web Push notification that *usually* fires and can wake a cold PWA. Best-effort; a V1.1 capability.
> - **tap-to-join banner** — an iOS-backgrounded notification that is **not** a ring (no sound-on-lock, no CallKit). The user taps it to *enter* the call. A V1.1 capability and the one the field cannot make reliable.
>
> The iOS-locked path is never called "ringing" anywhere in this plan.

---

## 1. Decision Log

Two tiers: **L — locked** (given to the planning effort, not up for relitigation) and **D — derived** (a design choice the domain drafts made to satisfy the locked decisions + the six invariants; reversible with cause, but each has a recommended default already chosen).

### 1.1 Locked decisions (the four givens)

| ID | Decision | Rationale | Consequences (cost / what it forecloses) | Owner draft |
|---|---|---|---|---|
| **L1** | **1:1 only. No group calls.** Group/SFU is an explicit later phase. *(V1 narrows this further to audio-only — see the V1/V1.1 split in §1.3 and [00 §4](./00-overview-and-goals.md).)* | 1:1 P2P media is E2EE "for free" via DTLS-SRTP — no media server in the path, so invariant 1 holds trivially. Groups are a *topology change* (SFU + a second E2EE layer), not a feature flag — every mature system (Signal, Wire, Matrix, Jitsi) treats them as a separate project ([07](./07-comparative-survey.md)). | No multi-party calls. The architecture must *not* foreclose groups: it reuses the existing per-conversation MLS group so the future SFrame-via-MLS path stays open ([01 §5](./01-architecture-and-crypto-model.md)). Group calls will need their own threat-model addendum (the SFU is a new metadata holder). | [01](./01-architecture-and-crypto-model.md), [07](./07-comparative-survey.md) |
| **L2** | **Media topology = fully self-hosted WebRTC P2P + self-hosted coturn TURN relay.** No third-party/managed TURN; no SFU. | Self-hosting keeps all relay metadata (5-tuples, IPs) in-region (EU) and under our control — no third-party processor, no data export (GDPR). Universal precedent: every surveyed system uses TURN as a dumb relay. | coturn forces the platform's **first-ever public inbound port** (UDP 3478 + relay range, TCP/TLS 5349), which collides head-on with the Cloudflare-Tunnel "zero published ports" model ([03 §1](./03-infrastructure-turn-and-networking.md)). Relay-default also means the VM carries full media egress for every relayed call. For **audio** this is trivial (~64 kbit/s/leg); the video egress/capacity ceiling is a V1.1 concern ([03 §10](./03-infrastructure-turn-and-networking.md)). | [03](./03-infrastructure-turn-and-networking.md) |
| **L3** | **IP privacy = per-user setting, DEFAULT = relay-only.** Force all media through TURN so peers never learn each other's IP. Power users may opt into direct P2P (host/srflx candidates). | A privacy-first product should hide peer IPs by default. Signal/WhatsApp ship the same "always relay" feature but default it *off* for quality; defaulting *on* is the stronger, defensible posture ([07](./07-comparative-survey.md)). Relaying does **not** weaken media crypto — DTLS-SRTP keys are still end-to-end ([01 §6](./01-architecture-and-crypto-model.md)). | Latency overhead + relay egress on every default call. With V1 cut to audio, the egress-cost-vs-privacy tension that dominated the original plan **disappears**: relay-only audio is cheap, so the default needs no quality escape hatch in V1. The TURN operator (us) sees both peers' IPs — that is the deliberate trade. Stored as `users.call_relay_only boolean not null default true` ([04 §6](./04-server-api-and-database.md)). | [03](./03-infrastructure-turn-and-networking.md), [04](./04-server-api-and-database.md), [06 §6](./06-threat-model-and-privacy.md) |
| **L4** | **Platform = PWA only.** Native wrappers (Capacitor) are future-only. | Matches the current stack; no app-store/native-build burden for a solo dev. In-browser E2EE calling is proven (Jitsi/Duo/Meet/LiveKit all do frame-crypto in a Web Worker — [07](./07-comparative-survey.md)). | **The hardest, least-mitigable constraint.** No CallKit/ConnectionService → no reliable lock-screen ring; iOS Web Push is installed-PWA-only (16.4+) and `userVisibleOnly` (no silent wake); backgrounded-tab throttling degrades wake. V1 sidesteps this entirely by being **foreground-ring-only** (see §1.3); the wake-banner / tap-to-join-banner paths are V1.1, where this constraint becomes load-bearing. The survey offers **no** mitigation for ringing a locked iPhone — genuinely our weakest area ([05 §5](./05-frontend-pwa-and-webrtc.md)). | [05](./05-frontend-pwa-and-webrtc.md) |

### 1.2 The one new crypto path (M1 — correct the "zero new crypto" claim)

Earlier drafts described the MITM defense as "reuse existing MLS, no new crypto." **That is wrong and must not be repeated.** Authenticating the *sender* of a call signal requires a **new, `crypto-reviewer`-gated authenticated-sender decrypt path in `packages/crypto`.**

- Today `Conversation.decrypt()` returns a **bare string** and surfaces **no sender identity**. The crypto-blind server forwards ciphertext; nothing on the receiving end currently tells the app *which MLS member* produced a given plaintext.
- Binding the DTLS fingerprint to a verified identity (the whole point of D1) requires decrypt to also return the authenticated MLS sender (leaf/credential identity), so the client can assert "this `offer` came from the friend I think I'm calling."
- This is **net-new crypto surface**, small but real, and it is a **hard Phase-0 predecessor of the very first connecting call** — no call may attempt DTLS before it lands and passes `crypto-reviewer`. It is tracked as slice **S12** ([08 P0](./08-roadmap-and-delivery-slices.md), [01 §3](./01-architecture-and-crypto-model.md)).

Everywhere this plan touches the fingerprint binding (00 / 01 / 02 / 06 / 07 / 09), it must say "a new authenticated-sender decrypt path," not "reuse only."

### 1.3 V1 / V1.1 scope split (M-CUT — audio-first)

V1 is deliberately cut to the smallest thing that proves the architecture end-to-end. **One cut resolves three hard problems at once** ([00 §4](./00-overview-and-goals.md)): the multi-device-MLS prerequisite, the egress-cost-vs-privacy tension, and the iOS-receivability over-promise.

| Capability | V1 | V1.1 | Why the line is here |
|---|---|---|---|
| 1:1 **audio** call, relay-only | ✅ | — | The whole point of V1. |
| 1:1 **video** | — | ✅ | Adds the egress/capacity ceiling and bandwidth-quota tuning; nothing about the protocol changes. |
| **ring** (foreground, both apps open) | ✅ | — | The only receivability V1 commits to. |
| **wake-banner** (Android push) / **tap-to-join banner** (iOS push) | — | ✅ | Depends on the content-free `call` push branch + INVITE_TTL wake budget. |
| **Missed-call ledger** (`call_sessions` table, RLS) | — | ✅ | Needs durable metadata only once there's an offline callee to miss. Pulls in `argus_call_prune` role + prune worker. |
| **ICE-restart / reconnection** | — | ✅ | V1 treats a media drop as call-ended (fail-closed); recovery is a V1.1 add. |
| **Multi-device ring-all** | — | ✅ | Requires the multi-device MLS story; V1 is **single-device per user**. |
| Authenticated-sender decrypt path (S12) | ✅ (Phase-0) | — | Hard predecessor of any connecting call (§1.2). |

**Consequences of the cut for V1:** no `call_sessions` ledger, no `argus_call_prune` role, no prune worker, no Web Push wake. A missed call in V1 is simply "the app wasn't open, nothing happened" — acceptable because V1 is for two people who are both present. The metadata-ledger + prune chain, push-wake, video, ICE-restart, and ring-all all move to the named **V1.1** phase and reappear in the Decision Log below tagged accordingly.

### 1.4 Derived decisions (chosen by the domain drafts)

| ID | Phase | Decision | Rationale | Consequences / trade-off | Owner draft |
|---|---|---|---|---|---|
| **D1** | V1 | **Authenticate the DTLS fingerprint by carrying SDP inside the existing MLS-encrypted channel**, and verify the **authenticated MLS sender** of the signal via the new decrypt path (§1.2 / S12). The crypto-blind server cannot read or substitute the fingerprint. | Raw DTLS-SRTP collapses to the security of the *signaling* channel; an untrusted server could swap fingerprints (MITM). MLS already authenticates every member message — but surfacing *who sent it* is the new crypto work, not a free reuse. Builds on the existing safety-number ceremony as the MITM root of trust → **no new verification UX in V1**. | A server-side SDP swap fails the DTLS handshake → **fail-closed** (call won't connect), never a silent downgrade. The manual safety number remains the only human-verifiable backstop (no exporter binding in V1 — D10). | [01 §3](./01-architecture-and-crypto-model.md), [02 §1.2](./02-signaling-protocol-and-state-machine.md) |
| **D2** | V1 | **Signaling transport = transient WS frames on the existing gateway, never the durable message store. No DB write; emit straight onto `RealtimeBus`.** | Signaling needs low latency and ephemerality. Routing it through the persisted `POST /messages` path would paginate/receipt/persist SDP and add a DB write before fan-out — fatal for ICE trickle. | A deliberate departure from durable-then-notify. **No REST backfill** — a dropped frame fails the call closed. V1 accepts that (both apps foreground, so the WS is live); individually-replaceable trickle candidates are designed-for but ICE-restart recovery is V1.1. | [02 §1](./02-signaling-protocol-and-state-machine.md), [04 §1](./04-server-api-and-database.md) |
| **D3** | V1 | **Ephemeral, time-limited TURN credentials** via coturn `use-auth-secret` (REST/HMAC): `username = "<expiry>:<sub>"`, `credential = base64(HMAC-SHA1(secret, username))`. Minted per call by `POST /calls/turn-credentials`, **TTL = 600s** (Q6 ruling). | No long-lived TURN credential ever exists to leak; a leaked cred is near-useless after expiry. The shared HMAC secret stays server-side only. | Adds an authenticated REST endpoint; the derived `credential` is secret-equivalent and must never be logged/cached. 600s gives setup headroom and survives a network blip; coturn doesn't re-auth mid-allocation so an active call outlives expiry regardless. | [03 §5](./03-infrastructure-turn-and-networking.md), [04 §2.2](./04-server-api-and-database.md), [05 §2.5](./05-frontend-pwa-and-webrtc.md) |
| **D4** | V1 | **coturn HMAC secret + `turns:` TLS cert delivered from Key Vault as tmpfs credential files** (via `fetch-keyvault-secrets.sh`), never env. | Invariant 5. Slots cleanly into the existing file-secret pattern — grounding confirms this part "breaks nothing." | coturn config can't `_FILE`-indirect inline → needs a tiny entrypoint wrapper to read the secret at launch (mirrors the GlitchTip pattern). Cert delivery via DNS-01 issuance into Key Vault, not on-box ACME. | [03 §5, §7](./03-infrastructure-turn-and-networking.md), [01 §9](./01-architecture-and-crypto-model.md) |
| **D5** | **V1.1** | **Metadata-only `call_sessions` ledger persisted; SDP/ICE/keys never persisted.** Missed-call list + abuse forensics. RLS (`to argus_app` + `nullif` guard), leading `tenant_id` index, composite FKs, dedicated `argus_call_prune` role with window-scoped policies. | Durable missed-call UX + an abuse trail, with zero content-exposure risk (it's metadata). Pure-Redis was rejected (loses records on restart). Follows the `0042`/`0044` templates exactly. | A new tenant table → must ship with full RLS or it's a block (invariant 3). **Deferred out of V1** because foreground-only calling has nothing to "miss." Live ring state stays ephemeral (in-memory / short Redis TTL). | [04 §4](./04-server-api-and-database.md), [06 §5](./06-threat-model-and-privacy.md) |
| **D6** | V1 | **Calls are gated on an accepted friendship** (`FriendsService` `accepted`-only check before ringing / minting TURN creds). | The cheapest abuse choke point: no friendship → no ring, no relay credential, no free bandwidth. Stops cold-calling strangers entirely. | **New logic specific to calls** — messaging does *not* currently require a friendship, and this does not retroactively change that. The gate result is never surfaced (non-friend invite still gets a uniform 202) to avoid a presence/enumeration oracle. | [04 §7.1](./04-server-api-and-database.md), [06 §9](./06-threat-model-and-privacy.md) |
| **D7** | V1 | **No presence service. Reachability is discovered only by ringing.** Uniform `202` on invite; uniform `404` on wrong-party; fixed ring timeout regardless of whether a socket exists. | A calling product inherently risks an "is X online now" oracle. We refuse to build one: no presence table, no `GET /presence`, no last-seen. Offline and online-but-ignoring are made indistinguishable. | Residual accepted risk: a *friend* who calls repeatedly can infer answer-vs-ignore patterns — inherent to any calling product, bounded by friendship + rate limits. Uniform-ring-timeout UX flagged **needs-work** (Q2). | [04 §3.4, §7.3](./04-server-api-and-database.md), [06 §4](./06-threat-model-and-privacy.md) |
| **D8** | **V1.1** | **Multi-device = ring-all (identity fan-out to all of callee's sockets), first-accept-wins, cancel-the-rest.** No `deviceId` added to `VerifiedAuth`. | The gateway routes per `(tenant, sub)` and has no device dimension — so fanning to every callee socket gives "ring everywhere" for free. Application-layer single-answer enforcement; matches Signal's ICE-forking model ([07](./07-comparative-survey.md)). | **V1 is single-device per user** (the cut removes the multi-device-MLS prerequisite). Ring-all + own-device dedup on `callId` ownership is V1.1. | [02 §6](./02-signaling-protocol-and-state-machine.md), [04 §3.3](./04-server-api-and-database.md) |
| **D9** | V1 | **TURN ingress = coturn on the VM public IP behind a strict NSG (default-deny + three narrow allows), with TURNS-over-TLS as a co-listener.** `network_mode: host`; `compose-guard` extended to assert exactly one host-net service == coturn. | €0 incremental (existing public IP), simplest (one service + one Terraform block per cloud), and the IP-exposure objection is weaker than it looks (a relay address is intrinsically reachable). Spectrum-for-UDP is Enterprise-only; managed TURN breaks "self-hosted." | The **recommended default**, confirmed for audio V1 (Q1: (a)+(c)). It exposes the real VM IP via a DNS-only `turn.4rgus.com` record — the one thing the tunnel was built to hide. Requires `infra-reviewer` sign-off + a `vm-ingress.md` revision. Option **(d) dedicated relay** becomes the default *before* video. | [03 §2](./03-infrastructure-turn-and-networking.md), [06 §R12](./06-threat-model-and-privacy.md) |
| **D10** | V1 | **Do NOT derive an MLS-exporter media key.** MLS *authenticates* the fingerprint (D1); it does not *supply* the SRTP key. Add a ~5-line `Conversation.exportKey()` shim only when the SFU/group phase starts. | For 1:1 P2P, DTLS-SRTP already gives a fresh forward-secret per-call key end-to-end; an exporter-derived key adds no confidentiality the relay can't already be excluded from, plus real plumbing (`RTCRtpScriptTransform`). Simple-first. | The exporter capability stays unwired (it exists in `ts-mls` 1.6.2 — confirmed in grounding — but argus doesn't re-export it). The future group path (SFrame-via-MLS, RFC 9605 + draft-barnes-sframe-mls) depends on this shim — designed-for, not built. Revisitable as Q5. | [01 §4](./01-architecture-and-crypto-model.md), [07](./07-comparative-survey.md) |
| **D11** | future | **Off-main-thread frame crypto is the target when E2EE-above-transport arrives** (group phase): SFrame in a Web Worker via Encoded Transforms. | Universal practice across all web E2EE call systems. Main-thread frame crypto janks the UI. | V1/V1.1 (plain DTLS-SRTP, no frame crypto) need none of this — but the client architecture must stay worker-portable so a later phase doesn't require a rewrite. | [05 §2](./05-frontend-pwa-and-webrtc.md), [07](./07-comparative-survey.md) |
| **D12** | V1 | **Glare handling = WebRTC perfect-negotiation for renegotiation + a deterministic `callId`-comparison tiebreak for simultaneous mutual invites.** | Perfect negotiation is the MDN-blessed standard for mid-call renegotiation glare. Simultaneous *invites* have no PC yet → a lowercase-`callId` comparison (reusing the `canonicalPair` ordering convention) picks a deterministic winner with no server arbitration. | The establishment-glare loser auto-accepts the winner's call (both already expressed intent). Confirmed un-weaponizable by the threat model. | [02 §5](./02-signaling-protocol-and-state-machine.md) |
| **D13** | **V1.1** | **Retention = a 30-day hard ceiling on `call_sessions`** (Q3 ruling). Dedicated `argus_call_prune` role, window-scoped RLS, separate TTL worker slice. | A missed-call list rarely needs more than 30 days; less metadata retained is strictly better for a privacy-first product, while still a comfortable floor for abuse forensics. Reuses the `0044` pattern; metadata-only table has no backfill/epoch coupling, so the prune worker ships as soon as the boundary migration lands. | 30 days is the literal baked into the window-scoped prune policy **and** the ROPA retention row (`docs/gdpr/article-30-records.md`). Never lengthen past the message ceiling without a threat-model update. Whole row is V1.1 (it depends on D5's table). | [04 §5](./04-server-api-and-database.md), [06 §7](./06-threat-model-and-privacy.md) |
| **D14** | **V1.1** | **Web Push wake = a new content-free `call` branch in the existing SW push handler.** No caller identity, no `callId`, no SDP in the payload — just a type. Drives the **wake-banner** (Android) and **tap-to-join banner** (iOS), never a "ring." | Invariant 2 (content-free push already exists for messages). The PWA learns who/what only after reconnecting and pulling call state over WS. | iOS limits make this best-effort only (L4) — and it is explicitly **not** a ring on a locked phone. `INVITE_TTL` (~45s) sizes a cold-PWA wake + WS reconnect budget. Push reliability on iOS is an accepted-risk Open Question (Q4). V1.1 because V1 is foreground-only. | [02 §7](./02-signaling-protocol-and-state-machine.md), [05 §5.4](./05-frontend-pwa-and-webrtc.md) |
| **D15** | V1 (+ V1.1) | **Abuse controls: friendship gate (D6) + per-socket WS rate limit on `call.*` frames (extend `allowSubscribe`) + per-caller invite cooldown + coturn quotas** (`total-quota`, `user-quota`, `max-bps`) + deny-RFC1918 on the relay. | Calling is a notification amplifier and TURN is an abuse magnet. WS signaling frames bypass the HTTP throttler, so they need their own bucket. Block is covered transitively by unfriend (hard-DELETE) in V1. | The WS/cooldown/quota controls ship in V1 with calling itself. Quota *tuning* is flagged **needs-work** (real numbers need real usage). A dedicated block list is Enterprise-optional. | [03 §9](./03-infrastructure-turn-and-networking.md), [04 §8](./04-server-api-and-database.md), [06 §9](./06-threat-model-and-privacy.md) |

---

## 2. Phase-0 GDPR & threat-model artifact bundle (M6/M7/S4/S5/S6)

A Phase-0 deliverable, gating the first VoIP code per DoD. **Four named, canonical repo artifacts** — not a vague "flag for the ROPA/DPIA." All four must be merged before slice T-1 closes ([08 P0-TM](./08-roadmap-and-delivery-slices.md), [06 §12](./06-threat-model-and-privacy.md)).

| # | Artifact | Action | What VoIP adds |
|---|---|---|---|
| 1 | `docs/gdpr/data-residency.md` | **Revise** | Add a **coturn relay** row: relay traffic (SRTP + 5-tuple/IP metadata) processed on the single EU VM, in-region, no third-party processor. |
| 2 | `docs/gdpr/article-30-records.md` | **Revise** | New **processing activity** ("1:1 voice calling"); new **personal-data category** (peer IP addresses seen by the relay; call-graph metadata); **sub-processor** rows for APNs/FCM *(V1.1, when push lands)*; **retention** row = **30 days** for `call_sessions` *(V1.1)*. |
| 3 | `docs/threat-models/metadata-exposure.md` | **Extend** | New rows: **call-graph** (who-calls-whom), **call-timing** (when/how-long), **relay-peer-IP** (the relay operator sees both peers' IPs under relay-only). |
| 4 | `docs/gdpr/dpia-voip-calling.md` | **Create** | Per-activity **legal basis** for voice calling (legitimate interest / contract performance), necessity & proportionality of relay-only default, the iOS-receivability limitation, and the residual presence-oracle risk (Q2/R5). |

> Note: `docs/threat-models/voip-calling.md` (the feature threat-model note) and the `docs/threat-models/vm-ingress.md` revision are **separate** Phase-0 prerequisites (§4.1 P1) — they are the *security* note; the four above are the *GDPR/metadata* artifacts. Both bundles gate code.

---

## 3. Open Questions

Each Open Question below carries the **chair ruling** as its recommended default. The ruling is the decision of record for planning; the listed decision owner confirms (and may overturn with cause) before the named slice.

### Q1 — Exact TURN ingress option (the highest-risk infra call)

**The question.** How does TURN media land inbound, given Cloudflare Tunnel cannot carry UDP and the platform has never had a public port?

| Option | UDP? | Hides VM IP? | €/mo | Verdict |
|---|---|---|---|---|
| **(a) coturn on VM public IP, strict NSG** | Yes | No (DNS exposes IP) | €0 | **Confirmed for audio V1 (D9)** |
| (b) Cloudflare Spectrum L4 | UDP = Enterprise-only | Yes | 4-fig+ | Reject for solo |
| **(c) TURNS-only over 443/TLS** | No (TCP relay) | No | €0 | **Ship as a co-listener (confirmed)** |
| (d) Dedicated relay host / separate IP | Yes | App VM stays hidden | €4–8 | **Becomes the DEFAULT before video (V1.1)** |

**Chair ruling — (a) + (c) confirmed for audio V1.** coturn on the VM public IP, NSG-restricted to exactly 3478 (UDP+TCP), 5349 (TURNS), and a narrow ~100-port UDP relay range; TURNS-over-TLS for hostile/captive networks. The accepted trade is R12 (real VM IP discoverable via `turn.4rgus.com`), acceptable for the single-VM audio V1. **Option (d) is the named upgrade and becomes the default before video ships** (V1.1), when concurrency and blast-radius isolation start to matter. **Decision owner:** `security-architect` + `infra-reviewer` confirm **before slice T-2**.

### Q2 — Is the presence oracle acceptable, and is the uniform-ring-timeout mitigation sufficient?

**The question.** Calling inherently leaks "is X reachable now." D7 minimizes it (no presence API, uniform 202/404, fixed timeout), but a determined friend can still infer answer-vs-ignore over repeated calls (R5, **needs-work**).

- **Option A:** Accept the residual oracle as inherent to any calling product; ship the uniform-ring-timeout UX (fixed minimum foreground-**ring** window so connect-speed can't distinguish offline vs ignored) and bound it with the friendship gate + rate limits. Document as accepted residual risk.
- **Option B:** Add explicit per-user "who can call me" controls beyond friendship (allowlist, DND). More UX, marginal gain over the friendship gate.
- **Option C:** Block calling until a richer privacy model exists. Over-rotation; defeats the feature.

**Chair ruling — A.** **Decision owner:** `security-architect` sign-off on the residual-risk register ([06 §11 R5](./06-threat-model-and-privacy.md)) and the DPIA (artifact #4); the uniform-timeout detail must ship *with* V1 (the C-series client slices), not after.

### Q3 — Call-metadata retention window

**The question.** How long does `call_sessions` (a V1.1 table) keep missed-call/abuse metadata?

- **Option A:** 90 days — message-aligned, one ceiling, one pattern.
- **Option B:** 30 days — a missed-call list rarely needs more; less metadata retained is strictly better.
- **Option C:** No persistence (Redis TTL only) — rejected in D5 (loses records on restart, no abuse trail).

**Chair ruling — B (30 days).** Baked into the window-scoped prune-policy literal **and** the ROPA retention row (`docs/gdpr/article-30-records.md`, artifact #2). Never exceed the message ceiling without a threat-model update. **Decision owner:** product + `security-architect`, **before the V1.1 `0045` migration** (the interval is baked into the policy literal).

### Q4 — Push reliability on iOS: accept the limit or block calling on unsupported configs?

**The question.** L4 + D14 mean a **tap-to-join banner** on a locked iPhone is unreliable and is **not a ring** (installed-PWA-only push, no silent wake, no CallKit). How honest/restrictive should we be? *(V1 sidesteps this — it is foreground-**ring**-only; this question governs V1.1 push.)*

- **Option A — accept + be honest.** Foreground **ring** is the V1 path. In V1.1, make Home-Screen install + notifications a surfaced *prerequisite* for the wake-banner / tap-to-join banner; show a one-time explainer ("calls may not alert you when your phone is locked on iOS"). Surface **call-readiness as a warning, not a hard block**. Don't promise WhatsApp-grade ringing.
- **Option B — gate the call button** on push-readiness (hide/disable for Safari-tab or notifications-off users). Stricter, fewer "why didn't it alert me" complaints, but reduces reach.
- **Option C — wait for Capacitor** (native CallKit/ConnectionService).

**Chair ruling — A, with call-readiness surfaced as a warning (not B's hard block).** This is the field's known dead-end — flag it as the weakest point of the product. **Decision fork, not a deferral:** if "rings a locked phone" is ever a **hard product requirement**, then **Capacitor becomes a V1 prerequisite** and the PWA-only V1 cannot satisfy it — that is a scope decision the product owner makes explicitly, not something engineering can mitigate away. **Decision owner:** product, with `security-architect` confirming the content-free push posture (R11) and the DPIA limitation note.

### Q5 — Derive an MLS-exporter media key?

**The question.** D1 (MLS *authenticates* the fingerprint, via the new decrypt path) vs additionally deriving a media key via the exporter.

- **Option A:** No exporter key. Authenticate via MLS sender + MLS-wrapped SDP; DTLS-SRTP supplies the SRTP key. Add the `Conversation.exportKey()` shim only when the SFU/group phase starts.
- **Option B:** Wire the exporter now and key SRTP/an SFrame layer from it. Adds confidentiality the relay already can't reach (coturn never sees plaintext) at real complexity cost — premature for 1:1 P2P.

**Chair ruling — A (no, for V1).** The exporter shim is **async/deferred** and tracked as part of the group-phase work, not gated on V1 (see S12 — note S12 itself is the *authenticated-sender* path, which **is** required; the *exporter* shim is the separable, deferred piece). Caveat for whenever the shim is added: an exported key must never be serialized toward the server (invariant 1/2). The survey confirms the future group path (RFC 9605 SFrame + MLS exporter) depends on this shim, so A does not foreclose B. **Decision owner:** `crypto-reviewer`.

### Q6 — TURN credential TTL

**Chair ruling — 600s.** Comfortable headroom for setup + a re-fetch on a network change; still near-useless if leaked; coturn doesn't re-auth mid-allocation so an established call survives expiry. Baked into D3. **Decision owner:** implementer at slice T-5/S3 — record the chosen value in the endpoint's OpenAPI description; no `security-architect` gate needed.

### Q7 — Friendship gate strictness: gate the ring, the TURN credential, or both?

**The question.** Where exactly is the D6 friendship check enforced?

- **Option A — both.** Friendship checked at `POST /calls/:friendUserId/invite` (no **ring** emitted to a non-friend, uniform 202) **and** at `POST /calls/turn-credentials` (the cheapest bandwidth-abuse choke). Defense in depth.
- **Option B — invite only.** Simpler, but lets a non-friend mint relay credentials (free bandwidth) even if they can't reach anyone.

**Chair ruling — A.** **Decision owner:** `security-boundary-auditor` at slice S3/S4. Note: TURN-cred issuance needs a callee context to gate per-pair; if creds are minted before a specific callee is known, gate on "user has ≥1 accepted friend" as a coarse floor and re-check at invite.

---

## 4. Prerequisites & assumptions that must hold

These must be true (or made true) for the plan to be valid. If any breaks, the affected decision is revisited.

### 4.1 Hard prerequisites (block the relevant slice if unmet)

1. **The security threat-model note ships before code.** Copy/link [06](./06-threat-model-and-privacy.md) to `docs/threat-models/voip-calling.md` and revise `docs/threat-models/vm-ingress.md` (which currently asserts the tunnel is the *only* ingress — false the moment coturn ships). This is **separate from** the four GDPR/metadata artifacts in §2 (both bundles gate). ([06](./06-threat-model-and-privacy.md), [03 §12 T-1](./03-infrastructure-turn-and-networking.md))
2. **The §2 GDPR artifact bundle is merged** (data-residency revised, article-30-records revised, metadata-exposure extended, dpia-voip-calling created). ([08 P0-TM](./08-roadmap-and-delivery-slices.md))
3. **The authenticated-sender decrypt path (S12) lands and passes `crypto-reviewer` before the first connecting call.** This is net-new crypto (§1.2), not a reuse. ([01 §3](./01-architecture-and-crypto-model.md))
4. **`compose-guard` is updated, not bypassed.** It must still assert zero `ports:` and additionally assert exactly one `network_mode: host` service == coturn. Adding coturn naively breaks CI mechanically. ([03 §3.2](./03-infrastructure-turn-and-networking.md))
5. **Any persisted call table (V1.1) ships with full RLS** (`tenant_id` + ENABLE/FORCE + `to argus_app` + `nullif` guard + leading `tenant_id` index + composite FKs) or it is a block (invariant 3). ([04 §4.2](./04-server-api-and-database.md))
6. **coturn never terminates media crypto.** It is a packet relay below the crypto layer; `turns:` on 5349 is a *transport* wrapper, not media termination. Any proposal where TURN sees plaintext is wrong (invariant 1). ([01 §2](./01-architecture-and-crypto-model.md), [03](./03-infrastructure-turn-and-networking.md))
7. **SDP/ICE always travels inside MLS ciphertext.** The server validates only the outer `CipherEnvelope` + routing IDs; it must never parse the inner `CallSignal` union. ([02 §1.2, §2.3](./02-signaling-protocol-and-state-machine.md))
8. **TURN secrets + TURNS cert ride the Key Vault file-secret path** (invariant 5) — never env, never on-box ad-hoc ACME. ([03 §5, §7](./03-infrastructure-turn-and-networking.md))
9. **New endpoints are in the OpenAPI spec + 42Crunch ≥ 90 + two-tier controller specs** (guard/status contract via `reflectRouteMeta`; behaviour via faked services). The `credential` field flagged sensitive, examples synthetic. ([04 §2.5, §9](./04-server-api-and-database.md))
10. **coturn availability is a Phase-0 operational concern** — see §4.4. With relay-default, **coturn availability == calling availability** for every default user, so its uptime alert + runbook stub ship in Phase-0, not as P3 polish.
11. **The destructive-op confirmation gate holds.** `terraform apply` for the NSG rules and `az vm run-command` deploys require explicit human confirmation — never auto-run. ([03 §12 T-2](./03-infrastructure-turn-and-networking.md), AGENTS.md)

### 4.2 Soft assumptions (true today per grounding; re-verify if stale)

| Assumption | Source | If false… |
|---|---|---|
| **`Conversation.decrypt()` returns a bare string with no sender identity.** S12 (§1.2) exists *because* of this. | crypto-mls grounding | If decrypt already surfaced a verified sender, S12 shrinks to wiring only. |
| **MLS exporter (`mlsExporter`) is available in `ts-mls` 1.6.2** (confirmed in `packages/crypto/package.json`) but not re-exported by argus. D10's deferred shim relies on it. | crypto grounding | Group phase needs a different keying source. |
| **No presence/online/typing tracking exists anywhere.** D7 builds on this clean slate. | ws-gateway grounding | A pre-existing presence surface would already be a partial oracle to account for. |
| **`VerifiedAuth` has no `deviceId`; routing is per `(tenant, sub)`.** D8 (V1.1 ring-all via identity fan-out) depends on this; V1 is single-device. | ws-gateway grounding | If a device dimension is added, multi-device ringing logic changes. |
| **Friendships are `accepted`-only and do NOT yet gate messaging.** D6 is therefore *new* logic for calls only. | db-settings-friendships grounding | If messaging gains a friendship gate, the call gate may be sharable. |
| **No `user_settings` table; per-user prefs live on `users`.** L3 stores `call_relay_only` as a column, not a new table. | db-settings-friendships grounding | If several call prefs arrive, reconsider a settings table (avoid premature abstraction until then). |
| **The content-free Web Push path exists** (`sw.ts`, `{"type":"new_message"}`) and is extensible with a `call` branch. D14 (V1.1) depends on it. | frontend-pwa-push grounding | A call push branch would need to be built from scratch. |
| **The inert `Phone`/`Video` buttons exist in `apps/web/src/.../ChatHeader.tsx` (~255–264) with `aria-label`s ("Start voice call" / "Start video call"), no `onClick`.** The C-series wires the voice button in V1; the video button stays inert until V1.1. | frontend-pwa-push grounding (confirmed via grep) | The trigger UI must be added, not just wired. |
| **Realtime is best-effort, drop-if-offline, no transport ack.** D2's no-backfill failure model assumes this. | ws-gateway grounding | If realtime gains delivery guarantees, the signaling resilience design simplifies. |
| **Single Azure VM (EU) with a Standard public IP that can accept inbound once NSG-allowed.** L2/D9 ingress math assume this. | infra-network grounding | A NAT-gateway hardening (mutually exclusive with inbound TURN) would force option (d). |

### 4.3 Call-reliability / failure modes (S1)

State plainly so the implementation and runbook plan for them ([06 §11](./06-threat-model-and-privacy.md), [08 phase table](./08-roadmap-and-delivery-slices.md)):

| # | Failure | V1 behaviour | Recovery |
|---|---|---|---|
| a | **coturn restart** | Drops **all** active relayed calls at once (relay-default = every default call). | V1: calls just end (fail-closed). **ICE-restart recovery is V1.1** — until then a restart is a hard drop for everyone mid-call. |
| b | **coturn redeploy churn** | A `--force-recreate` that restarts coturn = mass call drop. | coturn must be `restart: unless-stopped` **and excluded from routine `--force-recreate`** unless its config/image actually changed. ([03 §3.1](./03-infrastructure-turn-and-networking.md)) |
| c | **WS-gateway restart mid-call** | Kills in-call **signaling** (mute / hangup / renegotiation) while the P2P **media** flow survives (DTLS-SRTP is peer-to-peer). | The in-call UI **must show a "signaling lost" state** so the user knows controls are degraded; media keeps flowing until a peer hangs up. |
| d | **The single shared VM** | One box runs Postgres + Redis + Zitadel + API + WS + coturn → a single point of failure for calling and everything else. | **Accepted SPOF for V1.** The HA lever is Q1 **Option (d)** (dedicated relay host), which also isolates the call blast radius from the data plane. |

### 4.4 coturn as a Phase-0 operational concern (S1 / cost-infra)

Because relay-default makes coturn availability synonymous with calling availability, the following are **Phase-0 deliverables**, not later polish ([08](./08-roadmap-and-delivery-slices.md)):

- **A coturn uptime / health alert.** Wire a healthcheck into the compose sketch (the `coturn` service gets a `healthcheck:` — N2, [03 §3.1](./03-infrastructure-turn-and-networking.md)) and an alert on it, alongside the existing stack alerts.
- **A one-page runbook stub** covering the three first-line incidents: **TURN down**, **TURN over quota**, **cert expired** (the `turns:` 5349 cert from Key Vault). Stub now, flesh out as real incidents teach it.

### 4.5 Capacity / cost assumptions (V1 vs V1.1)

- **V1 (audio): negligible.** Relay-only audio is ~64 kbit/s/leg; the shared VM carries it comfortably and `max-bps` + `total-quota` cap abuse. The egress-cost-vs-privacy tension that drove the original plan **does not exist for audio** — relay-only is simply the default with no escape hatch needed.
- **V1.1 (video):** the practical ceiling (~25 concurrent video calls before media contends with Postgres/Redis/HTTP) and per-call egress (~€0.18/HD-video-call-hour) reappear — these are the trigger to **graduate Q1 to Option (d)** before video ships, and the reason the power-user direct-P2P opt-out (L3) is the cost release valve. ([03 §10](./03-infrastructure-turn-and-networking.md))

---

## 5. Decision-readiness summary

| Phase / slice can start once… | Blocking open question(s) | Blocking prerequisite(s) |
|---|---|---|
| **Phase-0: threat-model + GDPR bundle + infra (T-1…T-6, S1)** | Q1 (ingress) | P1, P2, P4, P6, P8, P10, P11 |
| **Phase-0 crypto: authenticated-sender path (S12)** | Q5 (exporter is separable/deferred) | P3 |
| **V1 DB + relay-only pref (S2)** | — | P5-pattern (column, no new table in V1) |
| **V1 TURN creds endpoint (T-5, S3)** | Q6 (TTL = 600s), Q7 (gate placement) | P8, P9 |
| **V1 signaling gateway + audio client (S-/C- series)** | Q2 (presence-oracle UX) | P7, P9 |
| **V1.1 missed-call ledger + prune (D5, D13)** | Q3 (30-day literal) | P5 (full RLS) |
| **V1.1 push wake + tap-to-join banner (D14)** | Q4 (iOS push acceptance / Capacitor fork) | §2 push sub-processor rows |

**Bottom line for the reviewer.** The four locked decisions are validated by the comparative survey ([07](./07-comparative-survey.md)) — argus's call architecture is mainstream-correct, with one deliberate, defensible divergence (relay-only *by default*). **V1 is cut to 1:1 audio, relay-only, foreground-ring-only, single-device** — a single cut that resolves the multi-device-MLS prerequisite, the egress-cost-vs-privacy tension, and the iOS-receivability over-promise at once. The one thing this plan must *not* under-state: the MITM defense needs a **new, `crypto-reviewer`-gated authenticated-sender decrypt path (S12)** — there is no "zero new crypto" here, and it is a hard Phase-0 predecessor of the first connecting call. **Genuinely human/`security-architect` calls before building**: TURN ingress (Q1, highest risk), presence-oracle acceptance (Q2). Q3–Q5 govern V1.1; Q6–Q7 are low-stakes implementer calls. The single least-mitigable constraint is **L4/Q4 — ringing a locked iPhone** — which V1 sidesteps by being foreground-only, and which, if it ever becomes a hard requirement, makes Capacitor a V1 prerequisite rather than a future nicety.
