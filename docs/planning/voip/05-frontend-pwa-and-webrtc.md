# 05 — Frontend PWA & WebRTC client

> Part of the argus VoIP planning set. Siblings: [00 — Overview & goals](./00-overview-and-goals.md) · [01 — Architecture & E2EE crypto model](./01-architecture-and-crypto-model.md) · [02 — Signaling protocol & call state machine](./02-signaling-protocol-and-state-machine.md) · [03 — Infrastructure: TURN/coturn & networking](./03-infrastructure-turn-and-networking.md) · [04 — Server API & database](./04-server-api-and-database.md) · [06 — Threat model & privacy](./06-threat-model-and-privacy.md) · [08 — Roadmap & delivery slices](./08-roadmap-and-delivery-slices.md) · [09 — Decision log & open questions](./09-decision-log-and-open-questions.md)
>
> **Locked scope this file conforms to:** the **V1 client is 1:1 AUDIO only**, **relay-only**, **foreground-ring only** (both apps open), **single-device per user**. **Video, ICE-restart/reconnection, push-wake + missed-call ledger, multi-device ring-all, and the metadata/prune chain are explicitly V1.1** (see [00 §4](./00-overview-and-goals.md) for the rationale and [08](./08-roadmap-and-delivery-slices.md) for the slice cut). WebRTC P2P media with a self-hosted coturn relay; IP privacy as a per-user setting **defaulting to relay-only**; **PWA only** (Capacitor is future). Media is E2EE browser-to-browser via DTLS-SRTP; coturn relays encrypted SRTP and never terminates media crypto (invariant 1).

This document is the client half of the plan: the WebRTC engine inside `apps/web`, the call UI state machine and where its components/hooks live, the **honest** PWA limitations for calling plus realistic mitigations, the V1.1 reconnection/ICE-restart UX, accessibility, and the Playwright e2e strategy with mocked media. Code below is **sketch-level** — enough to map each phase to PR-sized slices, not final implementation.

The file is written audio-first: anything video- or V1.1-only is **explicitly tagged `[V1.1]`** so the audio core stays legible and the slice cut in [08](./08-roadmap-and-delivery-slices.md) maps 1:1 to it.

---

## 0. Receivability terminology (used precisely everywhere)

Per the chair ruling (S7), this plan never uses "ring"/"ringing" as a catch-all. Three distinct terms, used exactly:

| Term | What it is | When it fires |
|---|---|---|
| **ring** | A real, foreground, in-app incoming-call screen with an audible ringtone. | Only when the callee's PWA is **open and visible** (or audible). This is the **only** V1 receivability path. |
| **wake-banner** `[V1.1]` | An Android push that wakes a backgrounded PWA and shows a high-priority "Incoming call" banner that *usually* fires reliably. | Android, backgrounded PWA, V1.1 push-wake. |
| **tap-to-join banner** `[V1.1]` | An iOS notification that is **not a ring** — no ringtone, no auto-launch, no lock-screen call UI. The user must *tap* it to open the app and join. | iOS, backgrounded/locked PWA, V1.1 push-wake. |

The iOS-locked path is **never** called "ringing." If a hard "rings a locked phone" requirement appears, that is a Capacitor decision fork, not a PWA deferral (see [09 Q4](./09-decision-log-and-open-questions.md)).

---

## 1. Where this lives in the existing tree

The grounding pass mapped the exact insertion points. Nothing about media exists yet (`grep` for `getUserMedia`/`RTCPeerConnection`/`MediaStream` across `apps/web/src` returns zero), so this is greenfield against a known-good realtime spine.

| Concern | New/changed file | Notes |
|---|---|---|
| Signaling transport | `apps/web/src/lib/ws.ts` (extend) **or** `apps/web/src/lib/call-signaling.ts` (sibling) | Add `call_offer` / `call_answer` / `call_ice` / `call_end` frames + `onCall*` callbacks. Reuse the first-frame-auth + CSPRNG-jittered reconnect already in `ws.ts`. **Recommendation: sibling file** so call churn doesn't destabilize the message socket. |
| WebRTC engine | `apps/web/src/lib/peer-connection.ts` (new) | Framework-free `RTCPeerConnection` wrapper: create/offer/answer/ICE, `iceTransportPolicy`, trickle. ICE-restart is `[V1.1]`. No React. Unit-testable. |
| Media devices | `apps/web/src/lib/media-devices.ts` (new) | `getUserMedia`, `enumerateDevices`, `permissions.query`, device-switch via `replaceTrack`. None exists today. Audio-only in V1; camera paths tagged `[V1.1]`. |
| TURN creds | `apps/web/src/lib/turn-credentials.ts` (new) | Fetch short-lived TURN creds from the API (`GET /api/calls/turn-credentials`, see [03](./03-infrastructure-turn-and-networking.md)); never bundle static creds. TTL = **600s** per [09 Q6](./09-decision-log-and-open-questions.md). |
| Authenticated-sender decrypt | `packages/crypto` (new path) | **Hard Phase-0 predecessor.** Authenticating the call signal's *sender* needs a new, crypto-reviewer-gated authenticated-sender decrypt path — today `decrypt()` returns a bare string and surfaces no sender identity. See §2.6 + [01](./01-architecture-and-crypto-model.md). |
| Call state | `apps/web/src/features/call/useCall.ts` (new) | Mirrors `features/chat/useLiveConversations.ts`: owns the PC, the state machine, local/remote streams. Instantiated in `ChatScreen.tsx`. |
| Call UI | `apps/web/src/features/call/` (new) | `IncomingCallModal.tsx`, `OutgoingCallModal.tsx`, `InCallScreen.tsx`, `CallControls.tsx`. Reuse `features/ui/{Modal,IconButton,Button}`. |
| Trigger buttons | `apps/web/src/features/chat/ChatHeader.tsx` (lines ~252–265) | The `Phone`/`Video` `IconButton`s already exist with `aria-label`s but **no `onClick`** — wire `onStartVoiceCall` through from `ChatScreen` (same pattern as `onVerify`/`onAddMember`). The `Video` button stays inert / hidden in V1 (`onStartVideoCall` is `[V1.1]`). |
| SW push | `apps/web/src/sw.ts` | **`[V1.1]`** — add a `call`-type branch to the `push` handler (today only `{"type":"new_message"}`). V1 has **no push-wake**: ring is foreground-only. |
| Relay-only setting UI | `apps/web/src/features/settings/` | Toggle bound to the per-user preference (column on `users` per [04](./04-server-api-and-database.md)). |
| E2E | `apps/web/e2e/call.spec.ts` (new) + demo/fake media path | `context.grantPermissions(['microphone'])` + fake `getUserMedia`; DoD gates merges on the `e2e` job. |

**Store choice:** the app has **no global store** (no Redux/Zustand) — state is React Context + hooks. Keep that. Call state belongs in a `useCall` hook plus a thin `CallContext` so `ChatHeader` (trigger) and a top-level `<CallLayer/>` (modals) can both reach it without prop-drilling through `ChatScreen`. Do **not** introduce a state library for one feature (project rule: no premature abstraction).

---

## 2. WebRTC client architecture

### 2.1 The `RTCPeerConnection` lifecycle

One `RTCPeerConnection` per call. The wrapper (`lib/peer-connection.ts`) is deliberately UI-free so it can be unit-tested and reasoned about independently of React re-renders.

```ts
// apps/web/src/lib/peer-connection.ts  (sketch)
export type PcEvents = {
  onLocalIce: (candidate: RTCIceCandidate) => void; // → send over signaling
  onRemoteTrack: (stream: MediaStream) => void;
  onConnState: (s: RTCPeerConnectionState) => void;
  onIceRestartNeeded: () => void;                   // [V1.1] on 'failed'
};

export function createPeer(opts: {
  iceServers: RTCIceServer[];     // from turn-credentials.ts (ephemeral)
  relayOnly: boolean;             // from the user setting (default true)
  events: PcEvents;
}) {
  const pc = new RTCPeerConnection({
    iceServers: opts.iceServers,
    // LOCKED PRIVACY DEFAULT: relay-only forces all candidates through coturn,
    // so the remote peer only ever sees the TURN relay address, never host/srflx.
    iceTransportPolicy: opts.relayOnly ? 'relay' : 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  });

  pc.onicecandidate = (e) => {
    if (e.candidate) opts.events.onLocalIce(e.candidate); // trickle
    // null candidate = end-of-candidates; signaled implicitly by gathering state
  };
  pc.ontrack = (e) => opts.events.onRemoteTrack(e.streams[0]);
  pc.onconnectionstatechange = () => {
    opts.events.onConnState(pc.connectionState);
    // [V1.1] reconnection: 'failed' triggers an ICE restart (§4). In V1 a
    // 'failed' state ends the call with a clear "Couldn't connect" message.
    if (pc.connectionState === 'failed') opts.events.onIceRestartNeeded();
  };
  return pc;
}
```

**State progression** the `useCall` machine reacts to (browser-driven, not invented by us):

```
new → connecting → connected → (disconnected ⇄ connecting on transient loss) → failed | closed
```

`connectionState` (the aggregate) is what UI binds to; `iceConnectionState` is finer-grained and used only for diagnostics/logging-as-metadata. In V1, the `disconnected ⇄ connecting` self-heal is whatever the browser does for free — **we do not drive an ICE restart** (that's `[V1.1]`, §4).

### 2.2 Offer/answer flow (caller and callee)

Perfect-negotiation is overkill for strict 1:1 audio with a clear initiator — keep it simple with an explicit caller/callee role derived from who pressed the button. (Glare is near-impossible in 1:1 with a human-initiated call and a server-ordered signaling channel; the `initiator_user_id` on the call frame is the tiebreak if it ever happens — reject the later offer with `call_end{reason:'glare'}`.)

```
Caller                                   Callee
──────                                   ──────
getUserMedia(audio)
createPeer(relayOnly: true)
addTrack (audio)
pc.createOffer()  ──────────────────────► call_offer {sdp}   (SDP is opaque to server; rides inside MLS ciphertext — see §2.6)
                                          RING UI shown (foreground WS only; no push in V1)
                                          user accepts
                                          getUserMedia(audio)
                                          createPeer(relayOnly: true)
                                          addTrack (audio)
            call_answer {sdp} ◄────────── pc.setRemoteDescription(offer); pc.createAnswer()
pc.setRemoteDescription(answer)
   ⇅ call_ice {candidate}   (trickle, both directions, throughout)   ⇅
DTLS-SRTP handshake (E2EE, browser↔browser)
connected → audio flows (always via coturn relay in V1; default relay-only)
```

`[V1.1]` Video adds a second `addTrack` (video) and the camera-acquisition rules of §2.3; the flow is otherwise identical.

### 2.3 `getUserMedia` — audio (V1) and video `[V1.1]`

```ts
// apps/web/src/lib/media-devices.ts  (sketch)
export async function getLocalStream(kind: 'audio' | 'video' /* [V1.1] */) {
  const constraints: MediaStreamConstraints =
    kind === 'video' // [V1.1]
      ? { audio: { echoCancellation: true, noiseSuppression: true }, video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } }
      : { audio: { echoCancellation: true, noiseSuppression: true }, video: false };
  return navigator.mediaDevices.getUserMedia(constraints); // throws on denial → caught by useCall
}
```

- **V1 requests audio only** — an audio call must never trigger a camera prompt. `[V1.1]` the camera is requested only for video calls.
- **Must** acquire media on the caller **before** sending the offer, and on the callee **only after accept** (don't light the mic — and `[V1.1]` the camera LED — while a call is merely ringing — a privacy expectation and a battery cost).
- Permission state is read via `navigator.permissions.query({ name: 'microphone' })` to pre-flight the UI ("mic blocked — fix in browser settings") rather than failing mid-call. `[V1.1]` adds `'camera'`.

### 2.4 Relay-only enforcement (the privacy default)

This is a locked decision and the highest-value privacy control in the whole feature. Two layers, both required:

| Layer | Mechanism | Why both |
|---|---|---|
| Client | `iceTransportPolicy: 'relay'` when the user setting is relay-only (default) | Browser only generates/uses relay candidates; host/srflx never leave the device. |
| Credential | Issue **relay-only-capable** TURN creds; for relay-only users the API may scope creds so direct is unusable | Defense-in-depth: a tampered client can't bypass privacy by flipping the flag, because without working STUN reflexive paths and with relay-scoped creds the only route is the relay. (coturn-side enforcement detailed in [03](./03-infrastructure-turn-and-networking.md).) |

> **Honest caveat:** `iceTransportPolicy: 'relay'` is a *client* setting. A modified browser/client could ignore it. That's why the privacy guarantee must also be anchored server/relay-side for relay-only users — the client flag is the UX, the relay scoping is the enforcement. Per [WebRTC Softphone Security — best practices](https://dev.to/sheerbittech/webrtc-softphone-security-explained-encryption-browser-risks-best-practices-n91), forcing `relay` is the standard way to stop private-IP leakage, at the cost of latency and a hard dependency on TURN availability. We accept that cost as the default and let power users opt into `'all'`.

Opt-in to direct P2P (`'all'`) is a deliberate, explained setting toggle — the UI must state plainly: *"Faster calls, but the person you call can learn your IP address."*

> **V1 operational consequence:** because relay-only is the default and coturn is the only media path for every default user, **coturn availability == calling availability**. This makes coturn uptime a **Phase-0 operational concern**, not a P3 nice-to-have: Phase-0 ships a coturn health/uptime alert and a one-page runbook stub (TURN down / over quota / cert expired), and the compose sketch carries a coturn healthcheck — see [03 §3.1](./03-infrastructure-turn-and-networking.md) and [08 P0](./08-roadmap-and-delivery-slices.md).

### 2.5 Ephemeral TURN credentials

Never ship a static TURN secret to the browser (invariant 2 — no secrets/creds in client or logs). Use the standard **time-limited REST credential** scheme ([WebRTC Softphone Security](https://dev.to/sheerbittech/webrtc-softphone-security-explained-encryption-browser-risks-best-practices-n91): "Never run an open relay; use REST API time-limited credentials… a token grants access for only the duration of that call"):

```ts
// apps/web/src/lib/turn-credentials.ts  (sketch)
export async function fetchTurnCreds(): Promise<RTCIceServer[]> {
  // API computes username = `${expiryUnix}:${userId}` and
  // credential = base64(HMAC-SHA1(turnSharedSecret, username)).
  // turnSharedSecret lives in Key Vault → never reaches the client.
  const r = await apiGet('/api/calls/turn-credentials'); // TTL = 600s (Q6)
  return [
    { urls: r.urls /* turn:turn.4rgus.com:3478?transport=udp, turns:...:5349 */,
      username: r.username, credential: r.credential },
  ];
}
```

- Creds are fetched **per call attempt**, valid for **600s** ([09 Q6](./09-decision-log-and-open-questions.md)), and never logged (the HMAC credential is a secret-class value).
- The API endpoint must be authenticated + tenant-scoped and gated on an **accepted friendship** with the callee (currently friendships do *not* gate messaging — this gate would be **new** logic; see [04](./04-server-api-and-database.md)).

### 2.6 Crypto-blindness of signaling **and authenticated sender** (invariants 1 & 4)

SDP and ICE candidates are metadata-revealing (codecs, IPs, relay addresses). Per [02](./02-signaling-protocol-and-state-machine.md), signaling payloads ride **inside MLS ciphertext** — the client encrypts `{kind:'call.offer'|'call.answer'|'call.ice'|'call.end', ...}` with the conversation's `Conversation.encrypt`, and the server/gateway forwards the opaque blob exactly as it forwards chat ciphertext. The gateway sees `ciphertext/alg/epoch` only; it never parses SDP.

**This is NOT zero-new-crypto.** The MITM defense — binding the call to a verified sender so a malicious server can't splice in its own offer — requires the client to know *which MLS member encrypted the call signal*. Today `packages/crypto`'s `decrypt()` returns a **bare string and surfaces no sender identity**. So V1 needs a **new, crypto-reviewer-gated authenticated-sender decrypt path** in `packages/crypto` that returns `{ plaintext, senderLeafIndex/senderCredential }`, letting `useCall` reject any `call_offer` whose authenticated sender is not the expected conversation peer. **This new path is a hard Phase-0 predecessor of the first connecting call** — without it there is no sender authentication and the "server is crypto-blind but calls are still MITM-safe" claim does not hold. Do not describe this as "reuse only." See [01](./01-architecture-and-crypto-model.md) and the Phase-0 line in [08](./08-roadmap-and-delivery-slices.md).

The DTLS-SRTP fingerprint may **additionally** `[V1.1]` be bound to the MLS exporter secret (`mlsExporter`, available but unexposed today) — but per the chair ruling ([09 Q5](./09-decision-log-and-open-questions.md)) the exporter binding is **not in V1**; the exporter shim is an async follow-up (see [08 S12](./08-roadmap-and-delivery-slices.md)). **Media itself is E2EE by DTLS-SRTP regardless** — coturn relays ciphertext.

### 2.7 Trickle ICE

Trickle is mandatory, not optional — it's the difference between ~1s and ~5s call setup. Each local candidate is sent immediately via `call_ice` as `onicecandidate` fires; remote candidates are `addIceCandidate`'d as they arrive.

> **Hard problem flagged in grounding:** the realtime layer is **best-effort, drop-if-offline, no backfill**. For chat, REST backfill saves a dropped frame. **Call signaling has no backfill — a dropped ICE candidate or offer silently breaks the call.** V1 mitigations:
> - **End-of-candidates + short buffer:** the *initiating* side may also generate a non-trickle full offer as a fallback; or buffer the candidate list and resend on `iceConnectionState === 'disconnected'`.
> - **Bounded resend:** resend unacked offer/answer up to N times with backoff until the peer's first ICE arrives (implicit ack).
> - **Correct failure mode (V1):** if signaling can't complete, the call **fails fast** with a clear "Couldn't connect" — never a silent black screen. This is the right failure mode and is acceptable for V1. (Mid-call ICE-restart recovery is `[V1.1]`, §4.)

### 2.8 In-call controls

| Control | Implementation | Note |
|---|---|---|
| Mute mic | `audioTrack.enabled = false` | Keeps the track/transceiver; instant, no renegotiation. Show muted state to the muting user; the remote can't be *told* muted without a (future) datachannel signal. **V1 control.** |
| Switch mic | `enumerateDevices()` → `getUserMedia(newDeviceId)` → `sender.replaceTrack(newTrack)` | `replaceTrack` avoids renegotiation — the clean modern path. **V1 control.** |
| Hang up | `call_end{reason}` + `pc.close()` + stop all local tracks | Always stop tracks to drop the mic LED. **V1 control.** |
| Camera off `[V1.1]` | `videoTrack.enabled = false` | No renegotiation; remote sees a frozen/blank frame. For true privacy, also `stop()` + `replaceTrack(null)` (LED off), at the cost of a re-acquire on re-enable. |
| Switch camera `[V1.1]` | `getUserMedia({video:{facingMode:'environment'}})` + `replaceTrack` | Front/back on mobile. |
| Screen share | `getDisplayMedia()` + `replaceTrack`/`addTrack` | **Future, post-V1.1.** Listed so the architecture leaves room; needs renegotiation and a UI affordance. |

---

## 3. Call UI state machine & components

### 3.1 States

The **V1 state machine** is the solid path below. `reconnecting` is `[V1.1]` (dashed): in V1, transport loss that the browser can't self-heal goes straight to `ended{reason:'connection-lost'}`.

```
        ┌─────────┐  start (caller)      ┌─────────┐
        │  idle   │ ───────────────────► │ outgoing│
        └─────────┘                       └────┬────┘
            ▲  ▲    incoming (foreground WS)    │ answer recv
            │  └──────────────┐                ▼
            │           ┌─────────┐  accept  ┌──────────┐  connected ┌────────┐
            │           │ incoming│ ───────► │connecting│ ─────────► │ in-call│
            │           └────┬────┘          └────┬─────┘            └───┬────┘
            │  decline/timeout│                   │ fail/timeout         │ net loss
            │                ▼                    ▼                      ▼
            │            (call_end)           ┌────────┐           ┌────────────┐
            └────────────────────────────────│ ended  │◄──────────│reconnecting│ [V1.1]
                          hangup/remote-end   └────────┘  give-up   └─────┬──────┘
                                                                          │ recovered [V1.1]
                                                                          └──► in-call
```

| State | UI | Component | Phase |
|---|---|---|---|
| `idle` | nothing | — | V1 |
| `outgoing` | full-screen "Calling… [name]", cancel button, ringback (optional) | `OutgoingCallModal.tsx` | V1 |
| `incoming` | **ring** UI: caller name/avatar, Accept / Decline (audio badge) | `IncomingCallModal.tsx` | V1 |
| `connecting` | "Connecting…" spinner over the in-call shell | `InCallScreen.tsx` (transient banner) | V1 |
| `in-call` | local + remote `<audio>` (and `[V1.1]` `<video>`), `CallControls` (mute/switch/hangup), elapsed timer | `InCallScreen.tsx` + `CallControls.tsx` | V1 |
| `reconnecting` | non-blocking banner "Reconnecting…", mute disabled | `InCallScreen.tsx` banner | **`[V1.1]`** |
| `ended` | brief "Call ended" + duration, auto-dismiss | toast / `InCallScreen.tsx` end state | V1 |

### 3.2 Hook + context sketch

```ts
// apps/web/src/features/call/useCall.ts  (sketch)
type Media = 'audio'; // V1; widens to 'audio'|'video' in [V1.1]

type CallState =
  | { kind: 'idle' }
  | { kind: 'outgoing'; peer: UserId; media: Media }
  | { kind: 'incoming'; peer: UserId; media: Media; offer: EncryptedOffer }
  | { kind: 'connecting' | 'in-call'; peer: UserId; media: Media }
  // | { kind: 'reconnecting'; ... }  // [V1.1]
  | { kind: 'ended'; reason: string };

export function useCall(deps: { signaling: CallSignaling; conversation: Conversation; relayOnly: boolean }) {
  const [state, setState] = useState<CallState>({ kind: 'idle' });
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localRef = useRef<MediaStream | null>(null);
  const [remote, setRemote] = useState<MediaStream | null>(null);

  async function startCall(peer: UserId) { /* §2.2 caller path (audio) */ }
  async function acceptCall() { /* getUserMedia(audio) → createPeer → answer */ }
  function declineCall() { /* call_end{reason:'declined'}; teardown */ }
  function hangup() { /* call_end; pc.close(); stop tracks; setState ended */ }
  function toggleMute() { /* track.enabled flip */ }
  async function switchDevice(id: string) { /* replaceTrack (audio) */ }
  // [V1.1] toggleCamera(), switchCamera(), reconnecting handling (§4)

  // wire signaling.onCallOffer/Answer/Ice/End → state transitions
  // verify the AUTHENTICATED SENDER of call_offer (§2.6) before showing the ring
  return { state, remote, localRef, startCall, acceptCall, declineCall, hangup, toggleMute, switchDevice };
}
```

`CallContext` wraps `useCall` once near `ChatScreen` so `ChatHeader` triggers it and a top-level `<CallLayer/>` renders the modals/screen. Demo mode (`VITE_DEMO_MODE=1`, which nulls the real managers) needs a fake signaling + fake media path so the UI is e2e-testable (§6).

### 3.3 Single-device per user (V1)

V1 is **single-device per user** — this is one of the simplifications the audio-first cut buys (it also sidesteps the multi-device-MLS prerequisite; see [00 §4](./00-overview-and-goals.md)). The gateway routes per `(tenant, sub)` and has **no `deviceId` dimension**, so an incoming-call notify already fans out to all of a user's sockets; in V1 we assume **one active socket per user** and do not implement answered-elsewhere arbitration.

`[V1.1] multi-device ring-all`: every device rings, the **first to accept wins**, and the accept broadcasts a `call_cancel`-style frame so the others stop ringing (CallKit-style "answered elsewhere"). True per-device addressing requires adding a device dimension to `VerifiedAuth` — out of scope for V1, noted in [02](./02-signaling-protocol-and-state-machine.md).

---

## 4. Reconnection & ICE-restart UX — `[V1.1]`

> **This entire section is V1.1.** In V1, a `failed` connection ends the call with a clear "Couldn't connect / call again" message — there is no in-call recovery. The cut is deliberate (see [00 §4](./00-overview-and-goals.md) and [08](./08-roadmap-and-delivery-slices.md)).

Network changes (Wi-Fi→cellular, NAT rebind) are the common case, not the exception, so V1.1 adds:

- On `connectionState === 'disconnected'`: enter `reconnecting`, keep playing the last audio buffer, **don't** tear down — many disconnects self-heal in seconds.
- On `connectionState === 'failed'`: perform an **ICE restart** — `pc.createOffer({ iceRestart: true })`, send a fresh `call_offer` over signaling, re-gather candidates (re-fetch TURN creds if the old ones expired, §2.5).
- Give-up timer (e.g. 30s in `reconnecting`) → `ended{reason:'connection-lost'}` with a clear message and a "Call again" affordance.
- The DTLS-SRTP session survives an ICE restart (only transport changes), so no re-keying is needed.

> **Operational note (carried into V1.1):** a **coturn restart drops ALL active relayed calls**, and ICE-restart is the only recovery — which is precisely why reconnection lands with V1.1 push-wake rather than V1. See the failure-modes row in [08](./08-roadmap-and-delivery-slices.md) and [06 §11](./06-threat-model-and-privacy.md). coturn must run `restart: unless-stopped` and be **excluded from routine `--force-recreate`** unless its config/image actually changed.

Because signaling has no backfill (§2.7), the ICE-restart offer itself can be lost — apply the same bounded-resend tactic to the restart offer.

---

## 5. HONEST PWA limitations & mitigations

This is the section to **not** sugarcoat. argus is PWA-only today; native wrappers (Capacitor) are future. Calling is the single hardest feature to deliver well in a PWA, and the limits are real. **V1's foreground-ring-only scope sidesteps the worst of these** (no push-wake means iOS receivability is not over-promised); the push-dependent mitigations below are therefore tagged `[V1.1]`.

### 5.1 The limitations

| # | Limitation | Reality | Impact on calling |
|---|---|---|---|
| 1 | **No CallKit (iOS) / ConnectionService (Android)** | PWAs cannot use the OS telephony UI. There is no full-screen native incoming-call screen, no **ring** on the lock screen, no integration with Do-Not-Disturb/"Allow Calls From". | Incoming calls cannot reliably **ring** a locked/asleep phone like WhatsApp does. **This is the dealbreaker-class limit** and the reason V1 is foreground-only. |
| 2 | **Web Push to wake — installed-PWA only, iOS 16.4+** `[V1.1]` | iOS only delivers Web Push to a PWA **added to the Home Screen**, iOS 16.4+. Subscriptions are reported to silently "disappear" on iOS even in iOS 18. ([MagicBell](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide), [PWA Push on iOS 2026](https://webscraft.org/blog/pwa-pushspovischennya-na-ios-u-2026-scho-realno-pratsyuye?lang=en)) | A user on a Safari tab (not installed) gets **no** push → no wake-banner / tap-to-join banner on iOS. Even installed, push reliability for time-critical signaling is poor. |
| 3 | **No silent / high-priority push on iOS** `[V1.1]` | iOS Web Push must be `userVisibleOnly: true` — every push shows a notification; no silent data push to wake JS. ([MagicBell](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide)) | You can show a **tap-to-join banner**, but you cannot auto-launch a **ring**. The user must tap. |
| 4 | **Background-tab throttling** | Backgrounded tabs are heavily throttled (timers, rAF). A `RTCPeerConnection` in a background tab may degrade. | Active calls survive better than incoming notification logic; a backgrounded peer can stutter. |
| 5 | **Autoplay restrictions** | Audio playback (and ringtone playback) needs a user gesture or the page to be audible/visible. | The remote-audio element may not autoplay; a ringtone may be blocked until interaction. |
| 6 | **Permission prompts** | mic prompts appear per-origin and can be permanently denied; no programmatic re-prompt. | First-call friction; denial must be handled gracefully (§5.3). |

### 5.2 Declarative Web Push — a partial improvement, not a fix `[V1.1]`

Safari 18.5 / WWDC 2025 introduced **Declarative Web Push**: the push payload itself declaratively describes the notification, reducing JS overhead and improving delivery reliability ([WWDC 2025 — Declarative Web Push](https://dev.to/arshtechpro/wwdc-2025-declarative-web-push-dn4)). This **helps** the V1.1 "show a reliable incoming-call notification" path but does **not** grant CallKit-style ringing — it's a more reliable **tap-to-join banner**, still tap-to-act, still installed-PWA-only on iOS.

### 5.3 Mitigations (tiered)

**Must (V1):**
- **Foreground ring is the primary — and only — V1 path.** When the PWA is open/visible, **ring** via WS instantly (no push dependency) with an in-app `IncomingCallModal` + ringtone (played after the first user gesture in the session to satisfy autoplay; otherwise fall back to a visual-only ring + the OS notification sound).
- **Set honest expectations in-product.** A one-time explainer: *"Calls work best with argus open on both devices. You'll see an incoming call only while argus is open. Reliable background calling is coming."* Don't let users discover this via a missed call. Surface **call-readiness as a warning, not a hard block** ([09 Q4](./09-decision-log-and-open-questions.md)).
- **Screen Wake Lock during active calls.** Acquire `navigator.wakeLock.request('screen')` on `in-call` so the screen doesn't sleep mid-call; release on end. Re-acquire on `visibilitychange` (the lock is dropped when the tab is hidden).
- **Handle permission denial gracefully.** If `getUserMedia` throws `NotAllowedError`/`NotFoundError`: don't crash the call — show "Microphone access is blocked. Enable it in your browser settings to make calls," with a deep-link hint. Pre-flight with `permissions.query` so the trigger button can warn before dialing.
- **Autoplay-safe remote media.** Attach the remote stream to an `<audio autoplay>` element; call `.play()` inside the accept gesture; if it rejects, surface a "Tap to unmute" control rather than failing silently. (`[V1.1]` video uses `<video autoplay playsinline>` — `playsinline` is mandatory on iOS or video goes fullscreen.)

**Should `[V1.1]`:**
- **Push-wake + missed-call ledger.** Add the content-free `incoming_call` push branch (§5.4) so backgrounded Android gets a **wake-banner** and iOS gets a **tap-to-join banner**. If the callee doesn't join, the caller's `call_end{reason:'no-answer'}` produces a normal encrypted chat "Missed call" so it's visible on next open — graceful degradation. This is where the metadata/ledger + 30-day retention + prune chain lands (see [04](./04-server-api-and-database.md), [09 Q3](./09-decision-log-and-open-questions.md)).
- **Connection-quality indicator** from `getStats()` (bitrate/packet-loss) shown as bars; metadata only.

**Enterprise-optional / future:**
- **Capacitor wrapper** to get real CallKit/ConnectionService, true lock-screen **ring**, and background call UI. This is the *only* way to match native calling reliability and is explicitly a future phase. If "rings a locked phone" ever becomes a hard requirement, Capacitor is a **V1 prerequisite — a decision fork, not a deferral** ([09 Q4](./09-decision-log-and-open-questions.md)). Documented here so the PWA architecture (signaling, peer wrapper, hooks) stays wrapper-portable.

> **Bottom line for the solo EU dev:** **V1 PWA calling is good when both users have the app open** (real **ring**), and that is the only thing it promises. `[V1.1]` adds an **acceptable** tier when installed + notifications on (Android wake-banner; iOS tap-to-join banner), and **never** promises WhatsApp-grade ringing of a locked iPhone without Capacitor.

### 5.4 Service-worker push handler sketch — `[V1.1]`

> **V1 has no push-wake.** This handler is the V1.1 deliverable. It extends the existing `apps/web/src/sw.ts` handler (today: generic `{"type":"new_message"}` → "New message"). The push stays **content-free** (invariant 2): no caller name, no conversation id, no SDP — just a type.

```ts
// apps/web/src/sw.ts  (additions, sketch) — [V1.1]
self.addEventListener('push', (event: PushEvent) => {
  const data = (() => { try { return event.data?.json(); } catch { return {}; } })();
  if (data?.type === 'incoming_call') {
    event.waitUntil(
      self.registration.showNotification('Incoming call', {
        body: 'Tap to answer in argus',          // NO caller identity (crypto-blind)
        tag: 'argus-incoming-call',              // collapses repeats
        renotify: true,
        requireInteraction: true,                // stays until acted on
        // vibrate where supported; iOS ignores most of this
      }),
    );
    return;
  }
  // existing new_message branch unchanged
  event.waitUntil(self.registration.showNotification('New message', { tag: 'argus-new-message' }));
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = all.find((c) => 'focus' in c);
    if (existing) { await existing.focus(); existing.postMessage({ type: 'incoming-call-clicked' }); }
    else { await self.clients.openWindow('/?call=incoming'); }
    // The PAGE (not the SW) connects WS, drains the encrypted offer,
    // verifies the authenticated sender (§2.6), and shows the join UI.
  })());
});
```

The SW deliberately does **not** parse SDP or know who is calling — it surfaces a generic banner; the foreground page does the crypto-aware work after focus. On Android this is a **wake-banner**; on iOS it is a **tap-to-join banner** (not a ring).

---

## 6. Accessibility

The repo already runs `a11y-responsive.spec.ts` + `wcag-audit.spec.ts` in e2e — call UI must not regress them.

- **Roles & focus:** `IncomingCallModal`/`OutgoingCallModal` use the existing `Modal` (focus-trap, `role="dialog"`, `aria-modal`). On a **ring**, move focus to **Accept**; Escape declines.
- **Live regions:** state changes ("Connecting", `[V1.1]` "Reconnecting", "Call ended") announced via `aria-live="polite"`; an incoming **ring** uses `aria-live="assertive"` (or `role="alert"`).
- **Buttons:** all controls keyboard-reachable with `aria-label` + `aria-pressed` for toggles (mute; `[V1.1]` camera). The existing `ChatHeader` `Phone`/`Video` buttons already have labels ("Start voice call"/"Start video call") — keep the voice label; the video trigger is `[V1.1]`.
- **Captions of state, not media:** show textual call status alongside icons (don't rely on color/icon alone — WCAG 1.4.1).
- **Reduced motion:** honor `prefers-reduced-motion` for the ringing pulse animation.
- **Non-visual ring:** OS notification sound + vibration where available so the call isn't purely visual.

---

## 7. Playwright e2e strategy (DoD gate)

The DoD makes the `e2e` CI job gate merges: new user-facing flows get an E2E test, and removed/renamed UI interactions must update their assertions in the same commit. The chat already runs in **demo mode** (`VITE_DEMO_MODE=1`, OIDC blanked, managers nulled, seed data like "Sarah Chen"). Calling needs a fake media + fake signaling path under that flag. V1 specs cover **audio only**.

### 7.1 Fake media

Chromium supports fake devices via launch flags — wire them in `playwright.config.ts` for the call spec (or a dedicated project):

```ts
// apps/web/playwright.config.ts  (additions, sketch)
use: {
  // ...
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',     // auto-accept mic prompt
      '--use-fake-device-for-media-stream', // synthetic mic, no hardware
    ],
  },
},
```

Plus per-context permission grants (the repo uses none today):

```ts
await context.grantPermissions(['microphone'], { origin: 'http://localhost:5173' });
```

### 7.2 What to test (single-page, no real second peer)

A true two-browser P2P call is heavy and flaky in CI. For V1 e2e, **mock the signaling + peer** in demo mode so the spec exercises the **UI state machine and controls**, not real ICE:

| Spec | Asserts |
|---|---|
| Outgoing | Click `ChatHeader` "Start voice call" → `OutgoingCallModal` visible → cancel returns to chat. |
| Incoming (ring) | Inject a fake `call_offer` via the demo signaling stub → `IncomingCallModal` (**ring**) with Accept/Decline → Accept → `InCallScreen` shows local + remote audio elements + elapsed timer. |
| Sender auth | A `call_offer` whose demo authenticated-sender ≠ expected peer is **rejected** — no ring shown (asserts §2.6 wiring via a test hook). |
| Controls | Mute toggles `aria-pressed`; switch-device; hangup → "Call ended" → idle. |
| Permission denial | Force `getUserMedia` rejection (demo flag) → "microphone blocked" message, no crash. |
| Relay-only setting | Toggle persists; the demo peer factory receives `iceTransportPolicy:'relay'` by default, `'all'` only after opt-in (assert via an exposed test hook). |
| A11y | `call.spec` reuses the axe pass; focus lands on Accept; Escape declines. |

> The **real** P2P/ICE/coturn path is verified by an integration smoke (two headless contexts on a dev coturn) **outside** the merge-gating e2e job, because UDP-relay flows in CI are environment-fragile. Keep the merge gate on the deterministic mocked-media specs; run the live two-peer smoke as a non-gating nightly (mirrors the existing nightly DAST posture).

### 7.3 Demo/fake path

`VITE_DEMO_MODE=1` already nulls the real managers; add a `createDemoCallSignaling()` and a `createDemoPeer()` (resolves tracks from the fake device, never opens a real `RTCPeerConnection` unless a flag requests it) so `useCall` is fully drivable from the spec. The demo signaling stub also exposes an authenticated-sender field so the §2.6 rejection path is testable. This mirrors how chat demo seeds render without real auth.

---

## 8. Phase → PR-sized slices

Audio-core slices map 1:1 to the ~9-slice critical path in [08](./08-roadmap-and-delivery-slices.md). `[V1.1]` slices are listed but deferred.

| Slice | Phase | Scope | Gate |
|---|---|---|---|
| **P0** | Phase-0 | **Authenticated-sender decrypt path in `packages/crypto`** (§2.6) — hard predecessor of the first connecting call | **crypto-reviewer (Opus/max)** + unit tests |
| C1 | V1 | `lib/peer-connection.ts` + `lib/media-devices.ts` (audio) + unit tests (no UI) | typecheck/test |
| C2 | V1 | `lib/call-signaling.ts` (sibling to `ws.ts`) + `call_*` frames; demo signaling stub | controller/contract specs for the gateway frames (see [02](./02-signaling-protocol-and-state-machine.md)) |
| C3 | V1 | `features/call/useCall.ts` + `CallContext`; wire inert `ChatHeader` voice button; sender-auth gate | unit + a11y |
| C4 | V1 | Call UI: `IncomingCallModal`/`OutgoingCallModal`/`InCallScreen`/`CallControls` (audio); autoplay/wake-lock | **e2e `call.spec.ts` (mocked media)** — DoD gate |
| C5 | V1 | TURN creds fetch (`turn-credentials.ts`, 600s TTL) + relay-only setting UI + friendship gate | boundary review + threat-model note |
| C6 `[V1.1]` | V1.1 | Video (camera acquisition, `<video>`, camera/switch controls) | e2e (video mocked media) |
| C7 `[V1.1]` | V1.1 | SW `incoming_call` push branch (wake-banner / tap-to-join banner) + missed-call ledger + 30-day prune | boundary + threat-model |
| C8 `[V1.1]` | V1.1 | ICE-restart/reconnection UX + bounded signaling resend | live two-peer nightly smoke |
| C9 `[V1.1]` | V1.1 | multi-device ring-all (answered-elsewhere) | requires `deviceId` on `VerifiedAuth` |
| Future | post-V1.1 | screen-share, exporter-key fingerprint binding ([09 Q5](./09-decision-log-and-open-questions.md)), Capacitor wrapper (CallKit/ConnectionService) | separate phase |

---

## Sources

- [WebRTC Softphone Security Explained — Encryption, Browser Risks, Best Practices (2025)](https://dev.to/sheerbittech/webrtc-softphone-security-explained-encryption-browser-risks-best-practices-n91) — `iceTransportPolicy: relay` for IP-leak prevention; time-limited TURN REST credentials; DTLS 1.3 migration.
- [PWA iOS Limitations and Safari Support — 2026 guide (MagicBell)](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide) — installed-PWA-only push, `userVisibleOnly`, no silent push.
- [PWA Push Notifications on iOS in 2026: What Really Works](https://webscraft.org/blog/pwa-pushspovischennya-na-ios-u-2026-scho-realno-pratsyuye?lang=en) — iOS 16.4+ requirement, disappearing subscriptions.
- [WWDC 2025 — Declarative Web Push (DEV)](https://dev.to/arshtechpro/wwdc-2025-declarative-web-push-dn4) — Safari 18.5 declarative push, reduced JS overhead, still tappable banner not CallKit.
