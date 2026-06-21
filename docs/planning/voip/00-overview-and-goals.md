# 00 — VoIP Overview & Goals

> **Status:** planning. This is the executive summary and entry point for the argus VoIP plan set. It states what we're building, the four decisions that are locked, the architecture in one breath, the **audio-first V1** scope vs. what we're deliberately deferring to V1.1, how we'll know it worked, the risks that dominate everything, and a reading order for the rest of the docs.
>
> **One-line thesis:** add **1:1 end-to-end-encrypted calling** to argus by reusing what we already have — WebRTC's built-in DTLS-SRTP for media, our existing MLS group for signaling confidentiality, our existing WebSocket gateway for relay — plus exactly **one** new piece of self-hosted infrastructure (a coturn TURN relay) and **one** crypto-reviewer-gated addition to `packages/crypto` (an authenticated-sender decrypt path), with **zero** compromises to the six security invariants.

---

## 1. Goals

1. **1:1 calling** between two argus users, end-to-end encrypted, with the server crypto-blind to media (invariant 1). **V1 ships audio; video is V1.1** (see §4).
2. **Privacy-by-default IP protection:** neither caller nor callee learns the other's IP address unless they explicitly opt out (relay-only is the default).
3. **Fully self-hosted media path:** no third-party calling SaaS, no third-party STUN/TURN, no media egress outside the EU. Everything runs on the existing single Azure VM + one coturn service.
4. **Reuse where we honestly can, build the one thing we must:** signaling *confidentiality* comes from the MLS group we already ship; the realtime transport is the gateway we already run; secrets ride the Key Vault file-secret path we already use. The **one** piece of genuinely new crypto code is an authenticated-sender decrypt path in `packages/crypto` (see §5 and [01](./01-architecture-and-crypto-model.md)) — needed because today's `decrypt()` returns a bare string and surfaces no sender identity, so it cannot by itself prove *who* sent a call signal.
5. **Honest about the platform:** ship PWA calling with a clear-eyed account of what a PWA can and cannot do — and use precise terms for it. We distinguish **ring** (a real foreground in-app ring with ringtone, both apps open), **wake-banner** (an Android-backgrounded push that *usually* fires), and **tap-to-join banner** (an iOS-backgrounded notification that is **not** a ring). V1 ships **ring only**; the rest is V1.1.
6. **No regression to the security posture:** the six invariants hold; the one architectural exception (a public inbound port for TURN) is deliberate, audited, and contained.

### Non-goals (explicit)

These are out of scope **by design** — several would actively break an invariant or the privacy promise:

- **No call recording, ever** — there is no server-side media path to record from (invariants 1 & 6). This is a permanent non-goal, not a deferral.
- **No server-side transcription / speech-to-text / content analysis** — the server cannot see media.
- **No lawful-intercept / key-escrow backdoor** — the server holds no media key and we will not add a mechanism to obtain one.
- **No durable call-recording or full CDR** — at most, in V1.1, a short-TTL **metadata-only** missed-call ledger (V1 ships none; see §4).
- **No presence / last-seen service** — none exists today; VoIP does not introduce one. Reachability is revealed only transiently, at call time.
- **No group calls in V1 or V1.1** (separate topology — see §4).
- **No native app / CallKit / ConnectionService in V1** (PWA-only; Capacitor is a future phase — and a decision *fork*, not a deferral, if "rings a locked phone" becomes a hard requirement; see §6 and [09](./09-decision-log-and-open-questions.md)).
- **No screen-share** (the V1.1 renegotiation plumbing leaves room for it later).

---

## 2. The four locked decisions (and why)

These are settled inputs to the plan, not open questions. Each is validated against how Signal/WhatsApp/Wire/Matrix actually build calling (see [07 — comparative survey](./07-comparative-survey.md)).

| # | Locked decision | Why | Trade-off we accept |
|---|---|---|---|
| **1** | **V1 = 1:1 calling; groups are a future phase** | For 1:1, WebRTC's DTLS-SRTP gives E2EE media for free with no media server in the trust path. Groups need an SFU **plus** a second encryption layer (SFrame) — every mature system treats that as a separate, heavier project. | No multi-party calls until a dedicated group phase. (V1 also starts **audio-only** — see §4.) |
| **2** | **Self-hosted WebRTC P2P for media + self-hosted coturn TURN relay; SFU is future-only** | Keeps the media path fully self-hosted and EU-resident; the relay is a *dumb forwarder* of encrypted SRTP, never a party to the keys. Mainstream-correct: Signal/WhatsApp/Duo all do P2P-with-relay-fallback for 1:1. | coturn forces the platform's first public inbound port (see §6, risk #1). |
| **3** | **IP privacy is a per-user setting; default = relay-only** (force all media through TURN so peers never learn each other's IP) | Privacy-first default. Signal/WhatsApp ship the same "always relay" capability but default it *off*; defaulting it *on* is a stronger, defensible posture for this product. | Higher latency and real TURN bandwidth/egress cost (capped; see [03](./03-infrastructure-turn-and-networking.md)). Power users may opt into direct P2P. |
| **4** | **PWA only** (no native wrapper in V1) | It's the current stack; no app-store dependency, instant updates. | No CallKit/ConnectionService → no reliable **wake-banner** on a locked phone, and **no ring at all** on a backgrounded iPhone (only a tap-to-join banner). Confronted honestly, not faked (see §6, risk #2 and [05](./05-frontend-pwa-and-webrtc.md)). |

---

## 3. Architecture in a nutshell

A 1:1 call is a **WebRTC `RTCPeerConnection` between the two callers' browsers**. The media (audio in V1, audio+video in V1.1) is encrypted end-to-end with **DTLS-SRTP** — the two browsers are the only holders of the SRTP keys. **Signaling** (the SDP offer/answer and ICE candidates that set the call up) is encrypted with the **existing per-conversation MLS group** and relayed as opaque ciphertext over the **existing WebSocket gateway**, so the server forwards call setup exactly as it forwards a chat message — it never sees SDP, ICE, the signal type, or any key. Because raw DTLS-SRTP can't prove *who* is on the other end, the DTLS certificate **fingerprint travels inside that MLS-encrypted payload** and is checked against the **authenticated MLS sender identity** — which requires the new authenticated-sender decrypt path in `packages/crypto` (§5) to defeat a malicious-server MITM. By default both peers exchange **only relay candidates**, so all media flows through a **self-hosted coturn** server (the one new piece of infra) which relays encrypted SRTP without ever holding a key — meaning **neither the server nor the relay can read the call, and the peers never learn each other's IP.**

---

## 4. V1 scope — audio-first — and what's deferred to V1.1

> **The single most important scoping decision in this plan:** V1 is **1:1 audio only, relay-only, foreground-ring only (both apps open), single-device per user**, with **no `call_sessions` ledger, no `argus_call_prune` role, no prune worker, and no push-wake.** Everything else moves to a named **V1.1** phase.
>
> **Why this one cut earns its keep — it resolves three otherwise-thorny problems at once:**
> 1. **Multi-device MLS prerequisite.** Ring-all across a user's devices presupposes multi-device MLS enrollment and a `deviceId` routing dimension we don't have cleanly today. Single-device V1 sidesteps that entirely.
> 2. **Egress-cost-vs-privacy tension.** Relay-default means coturn carries every call's media. Audio (~40–60 kbps/leg) is an order of magnitude cheaper to relay than video, so the privacy-first default is affordable from day one; video's egress cost is faced deliberately in V1.1 with real audio-call telemetry in hand (see [03](./03-infrastructure-turn-and-networking.md)).
> 3. **iOS receivability over-promise.** Foreground-ring-only is a promise a PWA can actually keep. It removes the temptation to imply a backgrounded iPhone will "ring" — it will not (best case: a tap-to-join banner). Push-wake and the missed-call ledger arrive together in V1.1, where they can be built and described honestly.

### Shipping in V1 (the ~9-slice audio core — see [08](./08-roadmap-and-delivery-slices.md))

- **1:1 audio call** only (no camera path in V1).
- **Relay-only** IP privacy by default, with a per-user opt-in to direct P2P (honest UI: "the other person will see your IP").
- **MLS-authenticated signaling** — SDP/ICE encrypted inside the conversation's MLS group; DTLS fingerprint bound to the **authenticated MLS sender identity** via the new decrypt path; reuses the existing safety-number verification as the MITM root of trust.
- **Ephemeral, time-limited TURN credentials** minted per call (TTL **600s**; no static relay secret ever reaches the browser).
- **Trickle ICE** for fast setup.
- **Foreground ring → first-accept-wins → cancel** (both apps open; single device per user, so no fan-out).
- **In-call mute** and clean hang-up.
- **Friendship-gated calling** (only accepted friends can ring you) + per-socket signaling rate limits + coturn abuse quotas.
- **Accessible call UI** and **Playwright E2E** with mocked media (the merge-gating path); a live two-peer smoke runs nightly, non-gating.

### Deferred to V1.1 (designed-for, not built in V1)

| V1.1 item | Why not in V1 | What V1 leaves open |
|---|---|---|
| **1:1 video** | Camera path + much higher relay egress; face cost with real audio telemetry | Signaling/peer wrapper is media-kind-agnostic; adding a video track is a renegotiation, not a redesign |
| **ICE-restart / reconnection** | Recovery from a network switch (Wi-Fi↔cellular) is its own slice; V1 fails a dropped call cleanly | The peer wrapper is structured so ICE-restart slots in without reworking setup |
| **Push-wake + missed-call ledger** | Requires the metadata ledger + honest receivability story (wake-banner / tap-to-join banner) | Content-free Web Push already exists for chat; the call payload shape is reserved |
| **Multi-device ring-all** | Needs multi-device MLS + a `deviceId` routing dimension | Gateway fan-out is the natural home; token shape leaves room for `deviceId` |
| **Metadata-only call ledger + `argus_call_prune` role + prune worker** | The whole missed-call/retention chain lands with push-wake; **retention = 30 days** when it does (see [09](./09-decision-log-and-open-questions.md)) | No `call_sessions` table in V1 at all; the V1.1 table ships with `tenant_id` + RLS + leading-`tenant_id` index + a 30-day prune policy literal |

### Deferred to a later phase (beyond V1.1)

| Deferred item | Why deferred | What the plan leaves open |
|---|---|---|
| **Group calls / SFU** | Separate topology; needs SFrame + a media server | Uses the same MLS group that SFrame will later key via the exporter |
| **SFrame (RFC 9605) media encryption** | Only needed once an SFU sits in the media path | A small `Conversation.exportKey()` shim is spec'd, **async/not wired** for V1 (see [09](./09-decision-log-and-open-questions.md) Q5) |
| **Native wrapper (Capacitor) / CallKit / ConnectionService** | Out of the current PWA stack — and a *fork*: a V1 prerequisite **only if** "rings a locked phone" becomes a hard requirement | Signaling, peer wrapper, and hooks are written to be wrapper-portable |
| **Screen-share** | Not core | Built on the V1.1 renegotiation path; UI affordance is the only gap |
| **Call recording / transcription** | **Never** — violates invariants 1 & 6 | n/a — permanent non-goal |

---

## 5. Success criteria

V1 is done when:

1. **Functional:** two installed argus PWAs, **both in the foreground**, can place and receive a 1:1 **audio** call, with working mute and hang-up.
2. **Private by default:** with default settings, a packet/IP inspection on each peer shows **only the coturn relay address** — neither peer's real IP appears in the other's connection. Opting into direct P2P is the *only* way a peer IP becomes visible, and the UI says so before the user does it.
3. **Crypto-blind verified:** the server/gateway/Redis logs and DB contain **no** SDP, ICE, media keys, or TURN credentials — only IDs and metadata. The boundary auditor and a banned-pattern grep confirm it. coturn never terminates media crypto.
4. **MITM-resistant:** a tampered/swapped SDP fingerprint causes the call to **fail to connect** (fail-closed), not silently downgrade. This depends on the **authenticated-sender decrypt path** in `packages/crypto` — a hard **Phase-0 predecessor** of the first connecting call, gated by `crypto-reviewer` (see [01](./01-architecture-and-crypto-model.md)).
5. **Reliable failure, not silent failure:** a dropped signaling frame fails the call cleanly with a clear message rather than a silent black screen. (Mid-call network-switch *recovery* via ICE-restart is V1.1.)
6. **Honest UX:** first-call onboarding sets correct expectations — V1 calling requires **both apps open**; a backgrounded/locked phone will **not ring** (that's V1.1's wake-banner / tap-to-join banner story, with iOS surfaced as a **warning**, not a hard block).
7. **Gated:** the six invariants pass; `typecheck`/`test`/`lint`/`format` green; the call E2E spec gates merges; 42Crunch ≥ 90 on new endpoints; the **Phase-0 threat-model + GDPR artifact bundle** (below) merges **before** code; reviewers (`crypto-reviewer`, `security-boundary-auditor`, `infra-reviewer`) sign off in their areas.

> **Process note — Phase-0 GDPR artifact bundle (must merge before any VoIP code).** VoIP changes the data-processing picture, so Phase-0 ships four named, canonical repo artifacts — not a vague "flag it for the ROPA/DPIA":
> - **Revise** [`docs/gdpr/data-residency.md`](../../gdpr/data-residency.md) — add the **coturn relay** row (EU-resident relay of encrypted SRTP; no media decryption).
> - **Revise** [`docs/gdpr/article-30-records.md`](../../gdpr/article-30-records.md) — add the **new processing activity** (1:1 calling), the **personal-data category** (call metadata / relayed traffic), the **APNs/FCM sub-processor** entry (for V1.1 push-wake), and the **retention row** (call ledger = **30 days**, V1.1).
> - **Extend** [`docs/threat-models/metadata-exposure.md`](../../threat-models/metadata-exposure.md) — add **call-graph**, **call-timing**, and **relay-peer-IP** rows.
> - **Create** `docs/gdpr/dpia-voip-calling.md` — the DPIA, with **legal basis per processing activity**.
>
> Each new table ships with `tenant_id` + RLS + a leading-`tenant_id` index or it's a block; each new endpoint ships in the OpenAPI spec with a controller spec pinning its guard; the matching reviewer subagent runs after non-trivial changes in its area. The VoIP threat model ([06](./06-threat-model-and-privacy.md)) is copied to `docs/threat-models/voip-calling.md`, and the TURN networking threat-model note ([03](./03-infrastructure-turn-and-networking.md)) merges, before any VoIP code.

---

## 6. Biggest risks at a glance

Two risks dominate; everything else is ordinary engineering. A third cluster — **call reliability / operational availability** — is elevated to a first-class concern because, with relay-default, **coturn availability *is* calling availability** for every default user.

### Risk #1 — TURN breaks the "zero public ports" ingress model (infrastructure)

Today **nothing** is publicly reachable inbound: all ingress rides an outbound Cloudflare Tunnel, the Azure NSG is deny-all-inbound, and a CI guard (`compose-guard`) mechanically fails any published port. **Cloudflare Tunnel carries only HTTP/WebSocket over TCP — it cannot forward TURN's UDP.** So TURN *cannot* ride the existing tunnel, and the relay forces the platform's **first-ever public inbound port** (UDP 3478 + a narrow relay range, TCP/TLS 5349), plus on-box TLS and a DNS name that exposes the real VM IP.

**Disposition (confirmed for audio V1):** resolved deliberately in [03 — infrastructure: TURN & networking](./03-infrastructure-turn-and-networking.md) as **Option (a) coturn on the VM public IP behind three narrow NSG allows + Option (c) TURN-over-TLS on 5349** — run non-root/read-only/caps-dropped/crypto-blind, with a modeled `compose-guard` exception and a revised `vm-ingress.md` threat model. **Option (d) a dedicated relay host/IP becomes the DEFAULT before video** (it is also the HA lever — see Risk #3). The relay stays a dumb forwarder of encrypted SRTP — the invariants hold; the ingress model gains exactly one audited exception.

### Risk #2 — PWA call-UX limits, especially reaching a backgrounded/locked phone (platform)

A PWA has **no CallKit/ConnectionService**, so there is no native full-screen incoming-call screen and **no ring on a locked/asleep phone**. iOS Web Push works **only** for an installed (Home-Screen) PWA on **16.4+**, must be `userVisibleOnly` (no silent wake), and on a backgrounded iPhone yields at most a **tap-to-join banner — never a ring**. The comparative survey confirms **no surveyed system solves background PWA ringing** — they all lean on native APIs we don't have.

**Disposition:** V1 sidesteps this by shipping **foreground-ring-only** (both apps open) — the one promise a PWA keeps reliably. V1.1 adds best-effort reach: an Android **wake-banner** (content-free push that usually fires) and an iOS **tap-to-join banner** (explicitly *not* a ring), backed by a missed-call ledger so the weakness degrades gracefully. In-product copy sets expectations, and iOS call-readiness is surfaced as a **warning, not a hard block**. The real fix (Capacitor + CallKit) is a **decision fork**: if "rings a locked phone" is ever a hard requirement, Capacitor becomes a V1 prerequisite, not a later nicety (see [09](./09-decision-log-and-open-questions.md) Q4).

### Risk #3 — Call reliability & coturn availability (operational, P0 — not P3)

With relay-default, the shared VM's coturn is on the critical path of every call. The failure modes are concrete and must be designed-for, not discovered in production (full register in [06 §11](./06-threat-model-and-privacy.md), with a phase row in [08](./08-roadmap-and-delivery-slices.md)):

- **(a) coturn restart drops *all* active relayed calls.** In V1 there is no recovery — the call ends and must be re-placed. (V1.1 ICE-restart is the only recovery mechanism, and even then only for the surviving peer pair.)
- **(b) coturn must run `restart: unless-stopped`** and be **excluded from routine `--force-recreate`** unless its config/image actually changed — a careless redeploy otherwise kills every in-flight call.
- **(c) A WS-gateway restart kills in-call *signaling* (mute/hangup, and in V1.1 renegotiation) while *media* survives** (media is peer-to-relay-to-peer, independent of the gateway). The in-call UI must therefore show a distinct **"signaling lost"** state rather than pretending the call is healthy.
- **(d) The single shared VM is an accepted SPOF for V1.** The HA lever is **Option (d) the dedicated relay host/IP** — which is also why it becomes the default before video.

Because coturn availability equals calling availability, **a coturn uptime/health alert and a one-page runbook stub (TURN down / over quota / cert expired) are Phase-0 deliverables** (see [08](./08-roadmap-and-delivery-slices.md)), and a **coturn healthcheck** is part of the compose sketch from the start (see [03 §3.1](./03-infrastructure-turn-and-networking.md)).

**Lesser, tracked risks** (full register in [06 §11](./06-threat-model-and-privacy.md)): the real-time **call-graph metadata** the server unavoidably routes; the **online-presence oracle** inherent to synchronous calling (mitigated by uniform 202 + fixed ring timeout + friendship gate); **relay abuse / open-relay** (mitigated by ephemeral 600s creds, deny-internal-ranges, quotas); and the **no-signaling-backfill** property that makes a dropped ICE frame fatal to a call (mitigated by trickle + bounded resend + clean failure).

---

## 7. How to read the rest of the doc set

Read in order for the full picture; jump by concern using the map below.

| Doc | What it covers | Read it when you need… |
|---|---|---|
| **00 — Overview & goals** (this file) | Scope, locked decisions, architecture-in-a-nutshell, audio-first V1, risks, reading order | The executive summary / orientation |
| [**01 — Architecture & E2EE crypto model**](./01-architecture-and-crypto-model.md) | DTLS-SRTP media security; why server & coturn stay crypto-blind; the **authenticated-sender decrypt path** + MLS-bound DTLS fingerprints (MITM defense); exporter/SFrame upgrade path; invariant-by-invariant check | The media security model and trust boundaries |
| [**02 — Signaling protocol & state machine**](./02-signaling-protocol-and-state-machine.md) | The `call.*` signal types (Zod), the per-endpoint state machine, trickle ICE (V1) / ICE-restart + renegotiation (V1.1), glare (perfect negotiation), single-device V1 vs. V1.1 fan-out, ring vs. wake-banner vs. tap-to-join banner, replay protection | The control-plane wire format and call lifecycle |
| [**03 — Infrastructure: TURN & networking**](./03-infrastructure-turn-and-networking.md) | The Cloudflare-Tunnel-vs-UDP collision and its resolution; coturn as a hardened service (with healthcheck); NSG/Terraform inbound; ephemeral TURN creds; TLS; abuse controls; capacity, cost & availability | Anything about the relay, ports, secrets, cost, or uptime |
| [**04 — Server API & database**](./04-server-api-and-database.md) | New REST endpoints (`/calls/*`), WS gateway additions, the relay-only preference, authz/IDOR/presence-oracle handling; **the V1.1 metadata-only `call_sessions` table + RLS + prune** (V1 has none) | Server-side surface, schemas, and the data model |
| [**05 — Frontend, PWA & WebRTC client**](./05-frontend-pwa-and-webrtc.md) | The in-browser WebRTC engine, call UI state machine & components, **honest PWA limitations + precise receivability terms**, failure UX, accessibility, Playwright E2E with mocked media | Client implementation and the PWA reality check |
| [**06 — Threat model & privacy**](./06-threat-model-and-privacy.md) | Assets/adversaries, STRIDE-style metadata enumeration, per-invariant verification, relay-vs-direct privacy dial, **call-reliability/failure-modes (§11)**, GDPR/EU residency + the artifact-bundle checklist (§12), abuse controls, non-goals, residual-risk register | The security source of truth (copy to `docs/threat-models/` before coding) |
| [**07 — Comparative survey**](./07-comparative-survey.md) | How Signal, WhatsApp, Wire, Matrix/Element, Jitsi, Google Meet/Duo build E2EE calling; what to copy vs. avoid; mapping to our locked decisions | External validation and prior art |
| [**08 — Roadmap & delivery slices**](./08-roadmap-and-delivery-slices.md) | Phase-0 predecessors (auth-sender decrypt path, GDPR bundle, coturn alert+runbook), the ~9-slice audio critical path + dependency graph, then the V1.1 slices | Sequencing and PR-sized planning |
| [**09 — Decision log & open questions**](./09-decision-log-and-open-questions.md) | Settled rulings (retention 30d, iOS "accept + be honest", TURN TTL 600s, exporter shim async, ingress (a)+(c) now / (d) before video) and what remains open | The "why did we decide X" record |

**Suggested paths:**
- *Product / decision review:* 00 → 06 → 07 → 09.
- *Building the client:* 00 → 01 → 02 → 05.
- *Building the backend/infra:* 00 → 01 → 03 → 04 → 06.
- *Security review:* 06 → 01 → 03 → 04.
