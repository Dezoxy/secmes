# Mobile pivot — native iOS + Android (React Native + Expo)

> **Status:** planning. Entry point for the argus mobile-native plan set. The PWA pivots to **native iOS + Android apps as the primary client**, built on **React Native + Expo**, because the iOS PWA cannot deliver the capability that drives the whole pivot — ringing a locked phone for a call — and inherits a pile of background/push/install/storage limitations ("the backfire").
>
> **One-line thesis:** keep the entire stack in **one language (TypeScript)** by reusing the pure-TS MLS engine (`packages/crypto`) and Zod contracts (`packages/contracts`) *in-language* on React Native, rewrite only the throwaway browser-presentation layer, and unlock native **CallKit/ConnectionService + VoIP push** — gating the whole commitment on a fail-closed Phase-0 spike that proves the one hard technical risk (the MLS engine's X25519 key exchange currently needs a browser crypto API that React Native lacks).

---

## The decision in one breath

| Option | Fit | Verdict |
|---|---|---|
| **React Native + Expo** | **8/10** | **Chosen.** One language across API + web + mobile; reuses the crypto engine and contracts in-language; the only path to native locked-phone calling. |
| Capacitor (wrap the PWA) | 6.5/10 | Runner-up. Fastest for *messaging*, no crypto spike — but **cannot** do backgrounded/locked-phone two-way audio. A legitimate time-boxed *bridge*, not the destination. |
| Flutter (Dart) | 3/10 | Rejected. Dart can't run `ts-mls`; forces a *different* MLS implementation and an unbounded cross-implementation interop gamble + a permanent two-language tax. |
| Native Swift + Kotlin | 3/10 | Rejected. ~0% reuse, two codebases, demands Swift + Kotlin + Rust. Capability ceiling, unsustainable solo. |

Full scoring and the source-level evidence are in [00 — Overview & decision](./00-overview-and-decision.md).

## Why not the "obvious" choices

- **Flutter is the trap, not the shortcut.** Its Google backing and UI DX are real, but irrelevant here: your crown jewels (`packages/crypto`, `packages/contracts`, ~9.7k lines of business logic) are TypeScript. Dart throws all of it away and forces you to bet whole-fleet E2EE correctness on undocumented `ts-mls` ↔ Rust-OpenMLS interop.
- **Capacitor is genuinely tempting** — the WebView has full crypto (incl. X25519 since iOS 18.4), so `packages/crypto` runs *unmodified* and ~90% of the TS ships verbatim. It fixes the messaging backfire fast. But WKWebView **mutes the microphone shortly after the app backgrounds**, and the only native-WebRTC bridge plugin is ~5 years stale — so it structurally cannot do the locked-phone call that motivated the pivot.

## The one risk that gates everything

`ts-mls` performs its X25519 key exchange (the core of every group/Welcome operation) through the browser's `crypto.subtle` API. **React Native's Hermes engine has no `crypto.subtle`, and no polyfill implements X25519.** So the messaging engine is dead on React Native until a custom crypto provider backs that operation with `@noble/curves` (a library already in the dependency tree).

- This is **bounded and ownable** — a reviewer-gated shim under a known interface, with **zero interop risk** (you keep running the same engine your web clients use).
- It is the **linchpin** of Phase 0. If it proves intractable upstream, the framework decision re-opens. See [02 — Phase-0 spike](./02-phase-0-spike.md).

## Reading order

1. **[00 — Overview & decision](./00-overview-and-decision.md)** — the verdict, full scoreboard, source evidence, decision log, open questions.
2. **[01 — Code reuse & monorepo](./01-code-reuse-and-monorepo.md)** — what ports verbatim, what gets adapted, what's thrown away; the `packages/client-core` extraction and `apps/mobile` wiring.
3. **[02 — Phase-0 spike](./02-phase-0-spike.md)** — the fail-closed gate: four checks with concrete exit criteria, before any UI.
4. **[03 — Roadmap (iOS first, then Android)](./03-roadmap-ios-then-android.md)** — phased delivery with estimates, verification, and risks.
5. **[04 — Security & threat model](./04-security-and-threat-model.md)** — trust-boundary changes, hardware-wrapped key storage (no PRF on native), content-free push, native passkey, the six invariants, sequencing prerequisites.

## Provenance

This plan set was produced from a multi-agent codebase audit (2026-06-25): five parallel readers over `packages/crypto`, `packages/contracts`, `apps/web`, the PWA platform shim, and the `apps/api` realtime/calls/auth surface; four framework evaluations with live web research; a `security-architect` trust-boundary pass; and an adversarial stress-test of the recommendation. The decisive crypto claim (X25519 → `crypto.subtle`) was verified at the `node_modules` source level.

**Cross-review (2026-06-26):** an external architecture memo (repo-blind) independently reached the same framework decision. Its strongest additions were folded in — the `GroupCryptoEngine` engine boundary ([01](./01-code-reuse-and-monorepo.md) §9), native call-state-machine-as-source-of-truth ([03](./03-roadmap-ios-then-android.md) Phase 4), tightened solo OTA governance ([03](./03-roadmap-ios-then-android.md) Phase 5), the crash-recovery test + acceptance checklist ([02](./02-phase-0-spike.md)), lint-enforced boundary discipline ([01](./01-code-reuse-and-monorepo.md) §7), and the `ts-mls`-unaudited launch gate ([04](./04-security-and-threat-model.md) §8.5). Its one substantive divergence — a hardware-wrapped keystore instead of PRF-derived unlock — was routed to `security-architect` and **adopted** ([00](./00-overview-and-decision.md) locked decision #8): native at-rest uses a biometric-gated, hardware-wrapped random key, no PRF (PRF stays web-only). This **retired Phase-0 CHECK 4a**, leaving CHECK 1 (the crypto reroute) as the sole framework-invalidating gate.
