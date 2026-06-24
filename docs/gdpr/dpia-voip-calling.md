# DPIA — VoIP 1:1 Calling

**Regulation**: GDPR Art. 35 (Data Protection Impact Assessment)
**Controller**: Argus Secure Messaging (operator entity — fill in legal name)
**DPO contact**: dpo@[operator-domain] (fill in)
**Last updated**: 2026-06-24
**Status**: assessed for **V1 (1:1 audio, relay-only, foreground-ring, single-device, ephemeral)**; V1.1 items (video, push-wake, missed-call ledger, direct-P2P opt-in, multi-device) are pre-assessed as *future* surface and re-confirmed before each ships.

> Companion documents: [`../threat-models/voip-calling.md`](../threat-models/voip-calling.md) (call/signaling threat model — source of truth), [`../threat-models/voip-turn.md`](../threat-models/voip-turn.md) (relay infra), [`article-30-records.md`](./article-30-records.md) (ROPA), [`data-residency.md`](./data-residency.md). This DPIA records the **legal basis per processing activity** and the residual-risk acceptance; the threat models carry the full technical analysis.

---

## 1. Is a DPIA required?

A DPIA is appropriate (not strictly mandated by the Art. 35(3) high-risk triggers, but warranted) because VoIP introduces **new categories of personal data** (transient peer IP addresses at a relay), a **real-time presence signal**, and the platform's **first public network ingress**. argus is privacy-first by design, so this DPIA documents that the new processing is **minimised and proportionate**, not high-risk. No special-category (Art. 9) data, no profiling, no automated decision-making, no large-scale systematic monitoring is involved.

## 2. Description of the processing

1:1 calling lets two **accepted friends** place an end-to-end-encrypted audio call. Media is encrypted browser-to-browser (WebRTC DTLS-SRTP); the server and the self-hosted coturn relay are **crypto-blind** (they forward opaque ciphertext and hold no media key). Call **signaling** (SDP/ICE offer/answer) is encrypted inside the existing per-conversation MLS group and relayed as opaque ciphertext over the existing WebSocket gateway. By default (and the only V1 mode) media is forced through the relay so peers never learn each other's IP.

**Data flows and what each party sees:**
- **Call media (audio):** E2EE; visible only to the two endpoints. Server/relay: never.
- **Signaling (SDP/ICE):** E2EE (MLS); the server routes it as an opaque blob by server-verified `(tenant, sub)`. Server sees: that a signal flowed between two identities, and when.
- **Relay 5-tuples (peer IPs):** processed transiently in coturn memory during the call; never logged or persisted.
- **Call-routing metadata:** caller/callee identity + timing, observable to the operator in real time; **no durable record in V1**.
- **TURN credential minting:** the api derives a 600s HMAC credential per call from a Key-Vault secret; the credential is secret-equivalent and never logged.

## 3. Necessity & proportionality

- **Necessity:** real-time calling inherently requires routing signaling between the two parties (call graph) and, for relay-only privacy, relaying media through a server that sees both IPs. These are the minimum needed to deliver the service.
- **Proportionality / minimisation:** V1 **persists nothing** about calls (no ledger). Relay IPs are transient and unlogged. Push-wake and any durable missed-call metadata are deferred to V1.1, where they are content-free / 30-day-TTL respectively. No recording, transcription, or content analysis exists or can be added without breaking invariants 1 & 6. Self-hosting the relay keeps all metadata in the EU and avoids adding a third-party TURN sub-processor.

## 4. Legal basis per processing activity

| # | Processing activity | Personal data | Legal basis (Art. 6) | Notes |
|---|---|---|---|---|
| 1 | **Call signaling routing** (deliver offer/answer/ICE/hangup between two users) | Caller/callee UUIDs, conversation ID, timing | **6(1)(b) — contract** | Core service the user requested; ephemeral, no persistence in V1. |
| 2 | **Transient relay IP processing** (coturn forwards encrypted media, sees peer 5-tuples) | Peer IP/port | **6(1)(b) — contract** (necessary to deliver the call) + **6(1)(f) — legitimate interest** (relay-only privacy default that *protects* the other peer's IP) | In-memory only; never logged or persisted; in-region (EU VM). |
| 3 | **TURN credential minting** (HMAC creds bound to the user, ≥1-friend gated) | User `sub`, derived credential | **6(1)(b) — contract** | Credential is secret-equivalent, 600s TTL, never logged. |
| 4 | **Online-reachability signal** (a call connects only if the callee is reachable now) | Implicit presence | **6(1)(b) — contract** | V1 bounds this to "app currently open" (foreground-ring only, no push); no presence/last-seen service exists or is added. |
| 5 | **Call-wake push** *(V1.1 only — dormant in V1)* | Content-free push to the subscriber's browser push service (APNs/FCM/autopush) | **6(1)(b) — contract** | No caller/conversation/content in the payload; sub-processor named in the ROPA. |
| 6 | **Missed-call metadata ledger** *(V1.1 only — dormant in V1)* | Caller/callee UUIDs, conversation ID, timestamps (metadata only) | **6(1)(b) — contract** + **6(1)(f)** (showing the user their missed calls) | 30-day TTL, `tenant_id` + RLS, no content. |
| 7 | **Direct-P2P opt-out** *(V1.1 only — dormant in V1)* | Peer's real IP disclosed to the other peer | **6(1)(a) — consent** | Strictly opt-in; honest UI copy ("the other person will see your IP address") is the consent surface; conservative-AND (relay wins if either peer requires it). |

## 5. Risks to data subjects & mitigations

| Risk | Likelihood / impact | Mitigation | Residual |
|---|---|---|---|
| Operator infers **who-calls-whom / when** (call-graph + timing) | Medium / Medium | No persistence in V1; route by server-verified identity only; no analytics/counters | **Accepted** — inherent to any routed signaling; same class as message metadata |
| Relay operator sees **both peers' IPs** | Medium / Medium | Self-hosted EU relay; **unlogged, unpersisted**; relay-only itself *blinds peers to each other* (a net privacy gain vs. direct P2P) | **Accepted** — deliberate trade |
| **Presence oracle** (caller learns callee is online) | Medium / Low | Foreground-ring-only bounds it to "app open"; friendship gate; planned uniform ring timeout so connect-speed isn't a probe | **Reduced**; uniform-timeout UX ships with V1 |
| **MITM** on call setup (fingerprint substitution) | Low / High | SDP inside MLS ciphertext + the new authenticated-sender decrypt path binds the DTLS fingerprint to the verified MLS member → fails closed | **Reduced to detectable**; the authenticated-sender path is a hard pre-call gate (`crypto-reviewer`) |
| Peer IP disclosed in **direct P2P** (V1.1) | Medium / Medium | Absent in V1; V1.1 opt-in only, explicit consent, default off | **Accepted by user choice** (V1.1) |
| **Relay abuse** (open-relay / SSRF / amplification) | Low / High | 600s HMAC creds, ≥1-friend gate, `denied-peer-ip` RFC1918, quotas, resource limits | **Reduced**; `infra-reviewer`-gated config |
| **First public ingress** widens attack surface | Medium / High | Three narrow NSG allows; coturn non-root/read-only/caps-dropped/crypto-blind; HTTP origin stays tunnel-only | **Reduced**; see [`voip-turn.md`](../threat-models/voip-turn.md) |

## 6. Data-subject rights

- **Access / portability (Art. 15/20):** with no durable call log in V1, there is **nothing to export** for calls — the strongest posture. V1.1 missed-call metadata, if present, is included in the self-export.
- **Erasure (Art. 17):** nothing to erase for calls in V1. V1.1 missed-call metadata self-expires at 30 days and is removed on account deletion.
- **Rectification:** N/A (no stored call profile).
- **Objection / restriction:** the user can simply not place/accept calls; unfriending removes the ability to be called.

## 7. Conclusion

The V1 VoIP processing is **necessary, proportionate, and minimised**: E2EE media the server can't read, no call recording (a permanent non-goal), no durable call records, transient unlogged relay IPs, EU-only residency, and a friendship gate that limits who can call whom. **Residual risk is acceptable** for V1 subject to the hard gates already tracked in [`voip-calling.md`](../threat-models/voip-calling.md) §10 (authenticated-sender path before any connecting call; coturn hardening + availability alert; uniform ring timeout). This DPIA is **re-opened before each V1.1 activity** (video, push-wake, missed-call ledger, direct-P2P consent, multi-device) ships.

**Sign-off:** _pending human ratification (solo DPO/controller)._
