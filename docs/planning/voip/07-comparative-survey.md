# 07 — Comparative Survey: How Mature Systems Do E2EE Calling

> **Purpose.** Validate or challenge argus's locked VoIP decisions (1:1-only V1, self-hosted WebRTC P2P + coturn relay, relay-by-default IP privacy, PWA-only) against how Signal, WhatsApp, Wire, Matrix/Element, Jitsi, and Google Meet/Duo actually build encrypted calling in 2025–2026. Each profile covers **media topology, key establishment & authentication, relay/IP-privacy posture, group approach, and a COPY/AVOID verdict**. Closes with a mapping table to our locked decisions and an overall verdict.
>
> Sibling docs: [00 — overview & goals](./00-overview-and-goals.md) · [01 — architecture & crypto model](./01-architecture-and-crypto-model.md) · [02 — signaling protocol & state machine](./02-signaling-protocol-and-state-machine.md) · [03 — infrastructure: TURN & networking](./03-infrastructure-turn-and-networking.md) · [04 — server API & database](./04-server-api-and-database.md) · [05 — frontend, PWA & WebRTC](./05-frontend-pwa-and-webrtc.md) · [06 — threat model & privacy](./06-threat-model-and-privacy.md) · [08 — roadmap & delivery slices](./08-roadmap-and-delivery-slices.md) · [09 — decision log & open questions](./09-decision-log-and-open-questions.md)

---

## The shared baseline: what "E2EE calling" means in practice

Every system below is built on the same two-layer WebRTC primitive, so it's worth stating once:

- **1:1 media is E2EE for free.** WebRTC mandates **DTLS-SRTP**: a DTLS handshake negotiates SRTP keys directly between the two endpoints; SRTP then encrypts the actual audio/video. For a genuine peer-to-peer (or peer-via-dumb-relay) 1:1 call, the media is already end-to-end encrypted — no relay, including a TURN server, ever holds the SRTP keys ([How DTLS-SRTP Keeps WebRTC Voice and Video Secure](https://medium.com/@justin.edgewoods/how-dtls-srtp-keeps-webrtc-voice-and-video-secure-09ad546b3307); [WebRTC Security: DTLS-SRTP](https://antmedia.io/webrtc-security/)).
- **The hard problem is two-fold:** (a) **authenticating** the DTLS handshake so it isn't a MITM, and (b) **groups**, where any media server (SFU/MCU) that mixes or forwards streams sits *inside* the DTLS-SRTP boundary and can therefore see plaintext — "there is no similar standard securing media end-to-end in group calling" out of the box ([webrtcHacks: Meet vs. Duo](https://webrtchacks.com/meet-vs-duo-2-faces-of-googles-webrtc/)).

The systems differ almost entirely in **how they solve (a) and (b)** — which is exactly where argus has to make its own choices. For 1:1 (our entire V1 scope), the media-encryption baseline is largely solved; the survey confirms the interesting work is **authenticating the call signal's sender** and **IP privacy**, not media encryption.

> **A note on what "free" does *not* mean here.** DTLS-SRTP gives us encrypted media for free, but it does **not** give us an authenticated *caller* for free. Binding the SDP fingerprint to a verified identity (the MITM defense, below) requires our signaling layer to expose **who sent the call signal** — and in argus that is **net-new crypto work**, not a reuse of an existing primitive. See the MITM-defense note in the Signal profile and the [01 — architecture & crypto model](./01-architecture-and-crypto-model.md) authenticated-sender path.

---

## Signal — the closest match to our V1

| Dimension | Signal |
|---|---|
| **Media topology** | 1:1 = WebRTC P2P (DTLS-SRTP) with TURN relay fallback. Groups = a Signal-operated **SFU** (the "Calling Service") with a second E2EE layer on top. |
| **Key establishment** | Call-setup signaling rides **inside the Signal Protocol session** (the same E2EE channel as messages). The DTLS fingerprints exchanged in SDP are therefore authenticated by the existing Signal identity keys — no separate trust ceremony for calls. |
| **Authentication** | Identity is the message-channel identity; **safety numbers** already verify that channel out-of-band. Calls inherit it. |
| **Relay / IP privacy** | **"Always Relay Calls"** setting forces all media through Signal's TURN servers so peers never exchange host/srflx candidates and never learn each other's IP — at a quality cost. Default is *off* (direct P2P preferred). |
| **Groups** | SFU-based; group keys distributed over the Signal Protocol so the SFU forwards opaque media. **Multi-device ringing via ICE forking.** |

**How it works.** Signal runs calls over WebRTC ICE + SRTP, and is explicit that "the encryption keys that are used during this process are never shared with the service, and only the two devices that are calling each other have access to them" — relay servers cannot decrypt ([Signal: Multi-device calls with ICE forking](https://signal.org/blog/ice-forking/)). The **Always Relay Calls** option "will never include your public/private IPs in the ICE Candidates," routing everything through Signal's relay so a contact never learns your IP, at the cost of call quality ([How to Always Relay Calls to Hide IP Address in Signal](https://techviral.net/signal-always-relay-calls/)). Multi-device ringing is solved with **ICE forking**: "the caller's device sends an offer message to all of the recipient's devices, and those devices independently send back an answer message," using a parent PeerConnection as a shared ICE gatherer feeding one child PeerConnection per device ([Signal: ICE forking](https://signal.org/blog/ice-forking/)).

**COPY**

- **Signaling rides inside the existing E2EE message session** → DTLS fingerprints are carried inside the encrypted channel rather than server-relayed in clear. This is exactly our [02 — signaling protocol & state machine](./02-signaling-protocol-and-state-machine.md) design: encrypt `{kind:'call.offer'|...}` through the existing MLS-protected message path. We get media-key *confidentiality* for free from MLS; we do **not** get sender authentication for free — see the MITM-defense note below.
- **Relay-as-IP-privacy is a real, shipped, well-understood pattern.** Signal validates our relay-only-by-default decision wholesale. The only difference: Signal defaults it *off*; we default it *on* (stronger privacy posture, the right call for a privacy-first product — see verdict).
- **ICE forking** is the canonical answer to multi-device ringing. We explicitly **defer** it: V1 is single-device-per-user (see [00 — overview & goals](./00-overview-and-goals.md) §4 and [08 — roadmap & delivery slices](./08-roadmap-and-delivery-slices.md)); multi-device **ring-all** lands in **V1.1**. Signal's parent/child PeerConnection pattern is the design we adopt then.

> **MITM-defense note — this is NOT "zero new crypto."** Signal gets call-fingerprint authentication "for free" only because its identity layer already authenticates *who* sent every Signal-Protocol message. argus does **not** have that today: `packages/crypto`'s `decrypt()` currently returns a bare plaintext string and surfaces **no sender identity**. Binding the SDP DTLS fingerprint to a verified caller therefore requires a **new, crypto-reviewer-gated authenticated-sender decrypt path** in `packages/crypto` — the call recipient must be able to prove the offer came from the friend it claims to, not a tenant-mate or the server. This is a **hard Phase-0 predecessor of the first connecting call**, not a downstream reuse. Treat any plan text that says "reuse existing MLS, no new crypto" for the call MITM defense as wrong. See [01 — architecture & crypto model](./01-architecture-and-crypto-model.md), [06 — threat model & privacy](./06-threat-model-and-privacy.md), and [09 — decision log & open questions](./09-decision-log-and-open-questions.md).

**AVOID (for V1)**

- The group SFU. Signal needed it for group scale; we've explicitly deferred groups. Don't import SFU complexity before we have the requirement.
- ICE forking / multi-device ring-all in V1 — deferred to V1.1 along with the rest of the multi-device-MLS prerequisite chain.

---

## WhatsApp — same lineage, less to learn from (closed)

| Dimension | WhatsApp |
|---|---|
| **Media topology** | WebRTC-based; 1:1 P2P with relay fallback, group calls via relay/server. |
| **Key establishment** | Calls keyed off the **Signal Protocol** session (WhatsApp licensed/forked it in 2016). |
| **Authentication** | Inherits Signal-protocol identity; safety-number equivalent ("security code"). |
| **Relay / IP privacy** | Added a "Protect IP address in calls" relay-all setting (mirrors Signal's Always Relay), default off. |
| **Groups** | Supported; server-assisted; closed implementation. |

WhatsApp "uses a modified version of the Open Whisper Systems' Signal protocol as the basis for end-to-end encryption," and that protocol "prevents WhatsApp's servers and other third parties from accessing the plaintext of user messages or calls" ([About end-to-end encryption — WhatsApp](https://faq.whatsapp.com/820124435853543/); [WhatsApp Calling](https://www.whatsapp.com/calling)). The web client is WebRTC-based with DTLS-SRTP ([webrtcHacks: What's up with WhatsApp and WebRTC?](https://webrtchacks.com/whats-up-with-whatsapp-and-webrtc/)).

**COPY** — Mostly a confirmation, not a source of design. The takeaway is convergent evidence: the two largest E2EE messengers on earth both bind calls to the **message-channel identity** and both ship a **relay-all IP-privacy toggle**. That's two independent votes for our architecture — including, implicitly, for the principle that the *sender* of a call signal must be authenticated, which is the new-crypto Phase-0 work flagged above.

**AVOID** — Closed source; don't treat any specific behavior as a spec. Use it only as corroboration, never as a reference implementation.

---

## Wire — the cleanest "SFU but still E2EE" blueprint (relevant to our *future* group phase)

| Dimension | Wire |
|---|---|
| **Media topology** | 1:1 P2P (DTLS-SRTP). Groups via **SFT** (Selective Forwarding Turn), their own SFU. |
| **Key establishment** | Wire is migrating its whole stack to **MLS**; group call media keys come from the MLS group. |
| **Authentication** | MLS group membership + Wire's device-verification. |
| **Relay / IP privacy** | TURN-based relay; SFT itself acts as the forwarding node. |
| **Groups** | **Double encryption**: standard DTLS-SRTP to the SFT, *plus* a second Insertable-Streams layer with a group key the server never holds. |

Wire is the best-documented example of the central tension every group-calling system hits: once an SFU is in the path, "connections are not end-to-end anymore… dTLS encryption offered by WebRTC is not enough anymore as the encryption is terminated at the server-side." Their fix: "SFT utilizes WebRTC InsertableStreams to encrypt the packets a second time with a group key that is not known to the server, making it possible to have conference calls with many participants without compromising end-to-end security" ([Conference Calling 2.0 (SFT) — Wire Docs](https://docs.wire.com/latest/understand/sft.html)).

**COPY (for the future group phase, not V1)**

- The **double-encryption pattern** (transport DTLS-SRTP to the SFU + an SFrame/Insertable-Streams E2EE layer keyed outside the server) is *the* way to add a self-hosted SFU later without breaking invariant #1. And crucially, **Wire derives the second-layer key from MLS** — which is precisely the capability our [01 — architecture & crypto model](./01-architecture-and-crypto-model.md) identifies as available-but-unwired (`mlsExporter` exists in `ts-mls`, not yet re-exported). When we get to groups, the path is: expose `Conversation.exportKey(label, context, length)` → derive SFrame keys per epoch. Note this is a **distinct** piece of crypto work from the V1 authenticated-sender path; the exporter shim is **async / not on the V1 critical path** (see [09 — decision log & open questions](./09-decision-log-and-open-questions.md), Q5).

**AVOID**

- All of it for V1. SFT is a group solution; importing it now is exactly the premature complexity our scope lock forbids.

---

## Matrix / Element — the standards-track group design (our future north star)

| Dimension | Matrix / Element (MatrixRTC) |
|---|---|
| **Media topology** | **MatrixRTC / MSC3401**: Matrix carries *high-level* call signaling (who's in the call, membership, duration); a **LiveKit SFU** carries media. |
| **Key establishment** | Group key negotiated over Matrix (Olm/Megolm today; moving toward MLS-negotiated **per-sender keys**). |
| **Authentication** | Matrix device cross-signing / identity. |
| **Relay / IP privacy** | LiveKit handles ICE/TURN; SFU is always in the media path for groups. |
| **Groups** | LiveKit SFU + **Insertable-Streams E2EE**: media encrypted at the sender, decrypted only at receivers, SFU forwards opaque packets. |

MSC3401 splits the concern cleanly: "high-level call signaling (existence, membership, duration) is advertised by Matrix, but actual WebRTC signaling is handled separately" ([Matrix 2.0](https://matrix.org/blog/2023/09/matrix-2-0/)). Element built a "Matrix-capable SFU on top of the LiveKit engine," and LiveKit's E2EE mode "encrypt[s] media at the sender before leaving the browser… the SFU forwarding opaque encrypted packets it cannot inspect" via Insertable Streams ([MatrixRTC setup — Spaetzblog](https://sspaeth.de/2024/11/sfu/); [LiveKit Encryption](https://docs.livekit.io/transport/encryption/)). E2EE started "using a shared static secret" and is moving to "full Matrix-negotiated end-to-end encryption with sender keys" ([This Week in Matrix 2025-08-29](https://matrix.org/blog/2025/08/29/this-week-in-matrix-2025-08-29/)).

**COPY (architecturally, for later)**

- **Separate the two signaling planes**: durable, server-visible *call-state metadata* (membership, duration) vs. the opaque *WebRTC SDP/ICE* payload. The full plane-split (a persisted, metadata-only call ledger) is **V1.1**, not V1 — V1 is foreground-ring-only with **no `call_sessions` ledger** (see [00 — overview & goals](./00-overview-and-goals.md) §4, [04 — server API & database](./04-server-api-and-database.md), [08 — roadmap & delivery slices](./08-roadmap-and-delivery-slices.md)). The architectural principle still holds for V1's transient signaling: route/connect over server-visible envelopes, keep SDP/ICE MLS-wrapped and opaque, so the server stays crypto-blind (invariant #1).
- **Per-sender keys** is the right end-state for group E2EE — note it as the target for our group phase.

**AVOID (for V1)**

- LiveKit / any SFU dependency. It's a heavy external component; our 1:1 P2P scope doesn't need it, and adopting it now would contradict "self-hosted, simple-first."
- The "shared static secret" interim — a known-weak shortcut Element itself is replacing. If/when we do groups, go straight to MLS-derived per-epoch keys (we already have MLS).
- A persisted metadata ledger / prune chain in V1. The metadata-ledger (and its `argus_call_prune` role + prune worker) is V1.1 work, governed by the 30-day retention ruling in [09 — decision log & open questions](./09-decision-log-and-open-questions.md) (Q3).

---

## Jitsi — the reference implementation of Insertable-Streams E2EE

| Dimension | Jitsi Meet |
|---|---|
| **Media topology** | Always SFU (JVB), even for 2 people. |
| **Key establishment** | Each participant generates a random media key; distributed to others over an **Olm** secure channel established via the XMPP signaling transport. |
| **Authentication** | Olm channel over signaling; no built-in out-of-band verification ceremony comparable to Signal safety numbers. |
| **Relay / IP privacy** | SFU-centric; not designed around peer IP-hiding (the SFU is the peer). |
| **Groups** | AES-GCM per-participant keys, **rotated on leave**, **ratcheted on join** (joiners derive the new key locally, no redistribution). |

Jitsi "encrypts audio and video frames before transmission using the WebRTC Insertable Streams API"; "each participant has a randomly generated key… distributed with other participants via an E2EE channel which is established with Olm," with crypto in a dedicated Web Worker ([lib-jitsi-meet E2EE docs](https://github.com/jitsi/lib-jitsi-meet/blob/master/doc/e2ee.md); [Jitsi E2EE explainer](https://jitsi.org/e2ee-in-jitsi/)). Key lifecycle: "rotated every time a participant leaves… When a new participant joins, each participant ratchets their key, but this new resulting key is not distributed since every participant can derive it" ([DeepWiki: Jitsi E2EE](https://deepwiki.com/jitsi/lib-jitsi-meet/6.1-end-to-end-encryption)).

**COPY (for later)**

- The **rotate-on-leave / ratchet-on-join** key lifecycle is a clean group-membership-to-key-rotation mapping — and it's conceptually *what MLS already does for us natively* (every add/remove is a commit that advances the epoch). When we do groups, our MLS commits give us this for free; Jitsi validates the model.
- **Crypto in a Web Worker** — directly applicable to our PWA, even though V1 is **audio-only** (frame-level Insertable-Streams crypto is a groups-era concern, not a V1 one). When we do reach sender-keyed media, do it off-thread; frame crypto on the main thread would jank the UI.

**AVOID**

- The **SFU-always** topology (even 2-party goes through the server). For 1:1 it's strictly worse than P2P on latency and privacy. Our P2P-for-1:1 decision is correct; Jitsi is the counterexample of what *not* to do for two people.
- E2EE is **opt-in / not the default** in Jitsi and limited to Insertable-Streams-capable browsers. We want E2EE to be the non-negotiable default, not a toggle.

---

## Google Meet / Duo — the contrast case (where E2EE *isn't*)

| Dimension | Google Meet | Google Duo |
|---|---|---|
| **Media topology** | SFU; transport-only encryption. | 1:1 P2P + relay. |
| **Encryption** | DTLS-SRTP **client↔server only** (AES-256-GCM). Server sees plaintext. | DTLS-SRTP **plus** Insertable-Streams **E2EE** frame encryption. |
| **E2EE?** | **No** real E2EE for standard meetings — "the media is encrypted… but only between client and server." | **Yes**, true E2EE. |
| **Relay / IP privacy** | N/A (server is the peer). | Relay available. |

The webrtcHacks teardown is blunt: for Meet's group path "the SFU has access to the unencrypted payload and could listen in," whereas Duo "implements [E2EE] through… encrypting the media with a key that is not known to the SFU" using Insertable Streams ([Meet vs. Duo](https://webrtchacks.com/meet-vs-duo-2-faces-of-googles-webrtc/); [Google Meet encryption help](https://support.google.com/meet/answer/12387251)).

**COPY** — Nothing technical. The lesson is **negative and clarifying**: "encrypted calls" in the mass market usually means *transport* encryption, not E2EE. Meet is the baseline our product explicitly rejects. Use this as the marketing/threat-model contrast — "unlike Meet, your media key never touches our server."

**AVOID** — The entire Meet model (server-terminated media). It violates invariant #1 by construction. It's in this survey only to mark the line we will not cross.

---

## The standards layer: SFrame + MLS (validates our future group path)

Worth pulling out because it directly blesses our crypto stack for the *eventual* group phase. **SFrame is now RFC 9605** — "end-to-end encryption and authentication… for media frames in a multiparty conference call, where central media servers can access media metadata without accessing the actual media" ([RFC 9605](https://datatracker.ietf.org/doc/rfc9605/)). And the IETF has standardized **deriving SFrame keys from an MLS group**: "the derivation of SFrame keys per MLS epoch and per sender," using the MLS exporter ([draft-barnes-sframe-mls](https://datatracker.ietf.org/doc/html/draft-barnes-sframe-mls-00); [SFrame WG](https://datatracker.ietf.org/wg/sframe/about/)).

This is the standards-track version of what Wire ships and what our [01 — architecture & crypto model](./01-architecture-and-crypto-model.md) found latent in our stack: **MLS exporter → SFrame keys**. We already have MLS; the future group path is an *implementation* of an IETF standard, not a research project. Strong validation that betting on MLS now pays off later. (Reminder: this is the *group/media-frame* crypto path. It is unrelated to, and must not be conflated with, the V1 *authenticated-sender* decrypt path that the 1:1 call MITM defense needs — that one is new, Phase-0, and independent of the exporter.)

---

## Mapping to argus's locked decisions

| Our locked decision | Strongest precedent | Validates? | What the survey warns |
|---|---|---|---|
| **1:1 only in V1 (audio-first); groups deferred** | Signal/Duo do 1:1 P2P; Jitsi/Meet/Wire-SFT prove groups are a *separate, heavier* project | ✅ Strongly | Don't let "we might do groups" pull SFU complexity into V1. Every system treats groups as a distinct topology. Video itself is a **V1.1** layer on top of the audio core (see [08 — roadmap & delivery slices](./08-roadmap-and-delivery-slices.md)). |
| **Self-hosted WebRTC P2P for 1:1 media** | Signal, WhatsApp, Duo all do P2P-with-relay-fallback for 1:1 | ✅ Strongly | Jitsi's SFU-always shows the anti-pattern: never route 2 people through a server. |
| **Self-hosted coturn TURN relay** | Universal — every system uses TURN | ✅ Strongly | TURN is a dumb relay: it must **never** terminate DTLS-SRTP (invariant #1). See [03 — infrastructure: TURN & networking](./03-infrastructure-turn-and-networking.md) for the public-UDP/Cloudflare-Tunnel tension. With **relay-default**, coturn availability == calling availability — a P0 operational concern (health alert + runbook stub), not a P3 nicety. |
| **Relay-only by DEFAULT for IP privacy; opt-out to P2P** | Signal "Always Relay," WhatsApp "Protect IP" | ✅ Validated *as a feature*; we go further on default | Signal/WhatsApp default it **off** for quality. Our default-on is a stronger, defensible privacy stance — but document the **quality trade-off** and the **higher TURN bandwidth/egress cost** it forces on our single VM. Audio-first V1 deliberately blunts this cost (see [00 — overview & goals](./00-overview-and-goals.md) §4). |
| **Signaling = encrypted payload over existing E2EE channel** | Signal (signaling inside Signal Protocol); Matrix (split metadata vs. media planes) | ✅ Strongly | Matrix warns to **split planes**: the SDP/ICE *must* stay opaque (MLS-wrapped). The *persisted* metadata ledger is V1.1, not V1. |
| **Caller authentication (call MITM defense)** | Signal binds calls to the authenticated message-channel sender | ⚠️ Validated, but **costs new crypto** | This is **not** free reuse. `packages/crypto`'s `decrypt()` returns a bare string with no sender identity; authenticating the call signal's sender needs a **new, crypto-reviewer-gated authenticated-sender decrypt path**, and it is a **hard Phase-0 predecessor** of the first connecting call. See [01](./01-architecture-and-crypto-model.md)/[06](./06-threat-model-and-privacy.md)/[09](./09-decision-log-and-open-questions.md). |
| **PWA-only (no native wrappers in V1)** | Jitsi/Meet/Duo all run E2EE calling in-browser | ⚠️ Partial | None of them solve the PWA *receivability* problem: no CallKit/ConnectionService, Web Push wake limits. V1 is therefore **foreground-ring only** (both apps open). Be precise: a real **ring** is foreground-only; Android-backgrounded gets a **wake-banner** (usually fires); iOS-backgrounded gets a **tap-to-join banner** that is **NOT a ring**. If "rings a locked phone" becomes a hard requirement, Capacitor is a V1 prerequisite — a decision fork, not a deferral ([09](./09-decision-log-and-open-questions.md) Q4). See [05 — frontend, PWA & WebRTC](./05-frontend-pwa-and-webrtc.md). |
| **MLS as the crypto foundation (future groups via exporter→SFrame)** | Wire (MLS→group call keys), Matrix (moving to MLS per-sender keys), RFC 9605 + SFrame-MLS draft | ✅ Strongly | The exporter is unwired today; keep it unwired until groups (the shim is async, not on the V1 critical path). The standards-track path (MLS exporter → SFrame per-epoch/per-sender) is proven. |

---

## Overall verdict

**What this validates.** argus's V1 architecture is *mainstream-correct*, not exotic. The two biggest E2EE messengers (Signal, WhatsApp) converge on exactly our 1:1 design: **WebRTC P2P with TURN fallback, signaling bound to the existing E2EE message-channel identity, and a relay-all IP-privacy mode.** Our one deliberate divergence — making relay-only the *default* rather than an opt-in — is a strictly stronger privacy posture, well within precedent and the right call for a privacy-first product, provided we own the quality/egress-cost trade-off (which audio-first V1 deliberately minimizes). Our crypto bet (MLS) is forward-compatible with the IETF-standardized group path (RFC 9605 SFrame + MLS exporter), so V1 doesn't paint us into a corner for groups.

**What this warns us about.**

1. **Caller authentication is new crypto, and it gates the first real call.** Signal authenticates calls "for free" only because its identity layer already authenticates every message sender. We don't have that: a **new authenticated-sender decrypt path** in `packages/crypto` is a Phase-0 predecessor of the first connecting call. Do not bill the MITM defense as "reuse existing MLS, no new crypto."
2. **Groups are a topology change, not a feature flag.** Every mature group implementation (Wire SFT, Matrix/LiveKit, Jitsi) adds an SFU *plus* a second E2EE layer (Insertable Streams keyed outside the server). That's a whole project. Our scope lock is correct — hold the line.
3. **TURN must stay a dumb relay, and it's a P0 availability concern.** Invariant #1 survives groups only if, like everyone here, the relay never terminates media crypto. And because we default to relay, coturn going down means *calling* goes down for every default user — so a health alert and a one-page runbook stub (TURN down / over quota / cert expired) belong in Phase-0, with a healthcheck in the compose sketch ([03 — infrastructure: TURN & networking](./03-infrastructure-turn-and-networking.md)).
4. **The PWA receivability gap is unsolved by the field.** No surveyed system demonstrates reliable background ringing in an installed PWA — they all lean on native CallKit/ConnectionService that we don't have. The comparative survey *cannot* de-risk this for us; V1 is **foreground-ring only**, with Android **wake-banner** and iOS **tap-to-join banner** as the honest backgrounded fallbacks, and Capacitor explicitly future-only. See [05 — frontend, PWA & WebRTC](./05-frontend-pwa-and-webrtc.md).
5. **Do the (eventual) frame crypto off-thread.** Universal practice (Jitsi/Duo/Meet/LiveKit): frame-crypto in a Web Worker. Not a V1 concern (audio-first, no sender-keyed frames yet) but bake the Web-Worker assumption into the groups-era client design from the start.

**Net:** copy Signal's 1:1 model almost verbatim *but budget the authenticated-sender crypto it implicitly requires*, copy Matrix's plane-split principle for call state (persisted ledger deferred to V1.1), hold Wire/Matrix/Jitsi group patterns in reserve behind the MLS exporter, and reject Meet's server-terminated model and Jitsi's SFU-always-for-1:1 outright.

---

### Sources

- [Signal: Multi-device calls with ICE forking](https://signal.org/blog/ice-forking/) · [How to Always Relay Calls to Hide IP Address in Signal](https://techviral.net/signal-always-relay-calls/)
- [WhatsApp Calling](https://www.whatsapp.com/calling) · [About end-to-end encryption — WhatsApp](https://faq.whatsapp.com/820124435853543/) · [webrtcHacks: What's up with WhatsApp and WebRTC?](https://webrtchacks.com/whats-up-with-whatsapp-and-webrtc/)
- [Conference Calling 2.0 (SFT) — Wire Docs](https://docs.wire.com/latest/understand/sft.html)
- [Matrix 2.0](https://matrix.org/blog/2023/09/matrix-2-0/) · [MatrixRTC / Element-call setup — Spaetzblog](https://sspaeth.de/2024/11/sfu/) · [This Week in Matrix 2025-08-29](https://matrix.org/blog/2025/08/29/this-week-in-matrix-2025-08-29/) · [LiveKit Encryption](https://docs.livekit.io/transport/encryption/)
- [lib-jitsi-meet E2EE docs](https://github.com/jitsi/lib-jitsi-meet/blob/master/doc/e2ee.md) · [Jitsi: Does Jitsi support E2EE?](https://jitsi.org/e2ee-in-jitsi/) · [DeepWiki: Jitsi E2EE](https://deepwiki.com/jitsi/lib-jitsi-meet/6.1-end-to-end-encryption)
- [webrtcHacks: Meet vs. Duo](https://webrtchacks.com/meet-vs-duo-2-faces-of-googles-webrtc/) · [Google Meet encryption help](https://support.google.com/meet/answer/12387251)
- [How DTLS-SRTP Keeps WebRTC Secure](https://medium.com/@justin.edgewoods/how-dtls-srtp-keeps-webrtc-voice-and-video-secure-09ad546b3307) · [WebRTC Security: DTLS-SRTP](https://antmedia.io/webrtc-security/) · [WebRTC Security: DTLS, SRTP, Fingerprints, Identity — Fora Soft](https://www.forasoft.com/learn/video-streaming/articles-streaming/webrtc-security-dtls-srtp)
- [RFC 9605 — Secure Frame (SFrame)](https://datatracker.ietf.org/doc/rfc9605/) · [Using MLS to Provide Keys for SFrame (draft-barnes-sframe-mls)](https://datatracker.ietf.org/doc/html/draft-barnes-sframe-mls-00) · [Secure Media Frames WG](https://datatracker.ietf.org/wg/sframe/about/)
