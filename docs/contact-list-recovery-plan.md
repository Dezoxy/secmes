# Implementation plan: contact list survives a PWA reinstall + tap-to-resume

> **Status:** designed (security-architect ratified, two passes) — not started.
> **This doc is the implementation roadmap.** The companion *threat-model note* it calls for is a separate
> deliverable, authored in PR 1 at `docs/threat-models/contact-list-recovery.md`.
> **Tracker:** tasks #20 (PR1), #21 (PR2), #22 (PR3), #23 (PR4); prerequisite #16. Sits **behind** the
> first AWS deploy — net-new, does not block shipping.

## Owner ask

"If I uninstall the PWA I lose chat history — correct and intended. But make the **contact list** survive a
reinstall: after reinstalling, the roster of contacts reappears (empty of history), **and tapping a contact
lets me start chatting again right away.**"

## TL;DR

Two halves:

1. **Roster recovery (Option A):** the contact list is the social graph, which the server *already* stores to
   route messages (`conversation_members`, RLS). "Survive reinstall" = **read back** existing membership — no
   new table, no encrypted blob, no new key, no new metadata exposure. The roster reappears as **read-only
   placeholders**.
2. **Tap-to-resume:** tapping a placeholder **starts a fresh 1:1** with that contact (new messages only — old
   history stays gone), reusing the existing `ConversationManager`. The only genuinely new security work is
   **protecting the peer**: after you reinstall you present a *new* cryptographic identity, so the peer must be
   **warned "this contact's security code changed — verify again"** (Signal's safety-number-change pattern)
   rather than silently re-trusted. argus already has the safety-number machinery; today the verified state is
   ephemeral and that warning isn't wired — that's the gap this feature closes.

We **reject** any encrypted-roster blob — it would re-create the `key_backups` recoverable-secret surface that
task #16 removes.

## Why it works (ground truth, cited)

- **Client storage:** one IndexedDB DB `argus-keystore` ([keystore.ts](apps/web/src/lib/keystore.ts)) — `device`
  (MLS identity), `group-state` (the only local record of "I'm in conversation X"), `message-log` (history).
  Uninstall wipes all of it.
- **Reinstall = new MLS identity, unlock key returns.** Passkey survives (OS authenticator); PRF unlock key is
  deterministic ([prf.ts:26](apps/web/src/lib/prf.ts)); but MLS device keys are random and only *sealed* under
  it, and the sealed blob was wiped → `getOrCreateDevice` ([keystore.ts:214](apps/web/src/lib/keystore.ts))
  mints a brand-new identity. History unrecoverable by design.
- **Server already has the graph:** `conversation_members`
  ([0007_messaging.sql](apps/api/src/db/migrations/0007_messaging.sql), FORCE RLS). Read via existing
  `GET /devices/me/conversations` ([devices.controller.ts:281](apps/api/src/devices/devices.controller.ts)) +
  `GET /conversations/:id/members` ([messaging.controller.ts:360](apps/api/src/messaging/messaging.controller.ts)).
  Client wrappers already exist: [api.ts:886](apps/web/src/lib/api.ts) and
  [api.ts:229](apps/web/src/lib/api.ts).
- **Resume is already-built crypto.** `ConversationManager.prepare(peerUserId)` → `confirm()`
  ([conversations.ts:152,189](apps/web/src/lib/conversations.ts)) creates a fresh 1:1 group, with a built-in
  safety-number gate before `confirm()`. The reinstalled device has a fresh identity + KeyPackage pool — all it
  needs.
- **Safety numbers exist:** `safetyNumber()` ([packages/crypto/src/index.ts:203](packages/crypto/src/index.ts)),
  the `VerifySecurity` OOB panel ([VerifySecurity.tsx](apps/web/src/features/chat/VerifySecurity.tsx)), and
  [fingerprint-verification.md](docs/threat-models/fingerprint-verification.md). **Gap:** verified state is
  ephemeral `useState` (`verifiedByConv`, [ChatScreen.tsx:147](apps/web/src/features/chat/ChatScreen.tsx)), and
  the live "peer key changed" signal "is not built yet" (fingerprint-verification.md §6).

## Mechanism decisions (the non-obvious calls)

- **Resume = fresh group, NOT re-add to the old group.** The user's old device is gone, so the client can't
  re-add itself to the old MLS group (no current member to issue the Commit); only the peer could, which fails
  "immediately." Multi-device enrollment ([conversations.ts:38](apps/web/src/lib/conversations.ts),
  [devices.service.ts:155](apps/api/src/devices/devices.service.ts)) requires a *surviving* device → **does not
  apply to reinstall.** So resume reuses the normal "start a 1:1" path: new MLS group, **new conversationId**.
- **conversationId reconciliation = client-side replace-in-place.** The old id can't be reused (would force the
  server to bless a new device into an existing group — an authz violation). On resume, drop the placeholder and
  insert the new live conversation keyed by the contact's `userId`; the existing one-direct-conversation-
  per-contact guard `findConversationWith` ([ChatScreen.tsx:284](apps/web/src/features/chat/ChatScreen.tsx))
  collapses them to one entry. **No server change.** Residual: the peer keeps a stale dead thread until they
  also resume (bounded, 1:1 only, accepted).
- **Identity-change handling (the crux).** Persist verified safety numbers keyed by **peer `userId`**, covering
  **every currently-present peer device** — primary **and** secondaries (the 1:1 start flow already claims
  `peerSecondaryDevices` and verifies each) — as a **set** of per-device numbers, **not** a single number.
  (A single number per user would let a *replaced secondary device* slip through: the primary still matches the
  stored number, so the reset never fires.) Store it **sealed under the PRF session key in the `argus-keystore`
  IndexedDB** — the `userId ↔ verified-number` association is social-graph metadata, so **never** plain
  `localStorage`, and **never sent to the server**. On the **peer's** side, when a new/resumed conversation's
  set of present peer-device safety numbers differs from the stored set → don't auto-trust; gate it and surface
  "{contact}'s security code changed (they may have reinstalled) — verify before sending." Computed entirely
  client-side from public keys.

## The trade-off, in one paragraph (for the owner)

Reinstalling still loses your message history — that's the deliberate guarantee. What we add: your **contact
list comes back** (read from membership the server already keeps to route your messages — nothing new stored,
no encryption weakened), and **tapping a contact starts a fresh secure chat immediately**. Because a reinstall
makes a brand-new cryptographic "you," the person you message will see a one-time "this contact's security code
changed — verify again" prompt (exactly like Signal). That prompt is the safety check that stops an imposter
from pretending to be you; it's the honest cost of being able to pick your conversations back up.

## Scope

**In:** roster reappears (read-only placeholders); tap a placeholder → fresh 1:1 (new messages only); peer is
warned on the identity change and re-verifies.

**Out / deferred:** restoring message history (impossible by design); re-adding the new device to the *old* MLS
group; cryptographic "proof it's the same human" beyond OOB safety-number re-verify (deferred "sealed identity
transfer", multi-device-enrollment.md §5.4); group (N-party) safety numbers; any encrypted-roster blob /
server-stored recoverable secret (rejected — contradicts #16).

## Invariants — all hold

#1 crypto-blind (reuses opaque commit/welcome/ciphertext; identity-change signal is client-side, metadata-only,
never sent) · #2 no secret/content logging (trust state client-local, never logged) · #3 RLS (no new tables;
existing reads member/owner-scoped) · #4 no hand-rolled crypto (reuses `@argus/crypto` `safetyNumber` +
`ConversationManager`) · #5 Key Vault untouched · #6 no admin path.

---

## PR sequence (relative to task #16)

Each slice is independently shippable. Per-PR process for **every** PR: `/code-review` (medium) over the branch
diff → fix findings → commit → push → `gh pr create` → request **both** reviews (`@codex review` +
`@claude … VERDICT:`) → gate with `.claude/hooks/review-status.sh <pr> --wait`.

### PR 0 — prerequisite: land PRF PR-2 (task #16)

Tear out `key_backups` + `backups/me` + client recovery remnants. Gates: `security-boundary-auditor`,
`/db-migration`, `pnpm -r typecheck && pnpm -r test`. First, so the threat-model note can state "no
recoverable-secret surface" against a clean codebase.

### PR 1 — threat-model note, before any feature code (task #20)

Create `docs/threat-models/contact-list-recovery.md` via the `/feature-threat-model` skill, covering **both**
halves: roster recovery (Option A) **and** tap-to-resume + the identity-change section. Threats to document:
- **T-resume-1:** a malicious server fabricates "contact reinstalled" and hands the peer an *attacker* key under
  the victim's `userId` → mitigated by the peer-side "security code changed" signal + OOB safety number;
  residual = TOFU / user skips comparison (accepted, matches fingerprint-verification.md §6).
- **T-resume-2:** stale "verified" badge after resume → mitigated by keying verified-state to the safety number
  and resetting on change.
- **T-resume-3:** two-threads-per-contact residual (peer keeps the dead 1:1) — bounded, accepted.
- **T-resume-4 (roster injection):** the server fabricates the roster itself — inserting a `userId` into
  `conversation_members` for a contact the user never spoke to, so an unexpected name appears in the recovered
  roster. Not a *new* server capability (it already controls routing), but name it explicitly; mitigated by the
  same safety-number gate that runs before any message is sent (an injected contact can't be silently messaged).

Cross-reference fingerprint-verification.md (§3 stale trust, §6 deferred live key-change),
multi-device-enrollment.md (§5.4 deferred sealed identity transfer; reinstall is **outside** the enrollment
path), metadata-exposure.md (no new metadata). **Gate: `security-architect` review of the note before code —
mandatory, because the feature touches MLS lifecycle + identity.**

### PR 2 — read-only roster recovery (Option A slice) (task #21) — no crypto

Extend `useConversationHistoryRehydration`
([useConversationBackfill.ts:243](apps/web/src/features/chat/useConversationBackfill.ts)): when the local roster
is empty but the session is valid (the reinstall case), repopulate placeholders from
`GET /devices/me/conversations` + `GET /conversations/:id/members`; render **read-only** (no composer) until
live. Reuse `peer-naming.ts` for names/avatars. No server change, no `@argus/contracts` change.
- **Direct conversations only.** Build recoverable contact placeholders from **exactly-two-member (direct)**
  conversations. Group (3+ member) rows must **not** become resumable placeholders — group recovery + N-party
  safety numbers are deferred (see *Out of scope*), and a group row must never feed tap-to-resume (which is 1:1
  only). Either skip group rows in PR2, or render them as inert, clearly-non-resumable entries; do **not** wire
  them to the resume path.
- Gates: `security-boundary-auditor` (both reads RLS + member-only, no content); unit tests for the placeholder
  builder; one Playwright E2E (fresh keystore + valid session → roster appears, history empty, send disabled).
- **No `crypto-reviewer`** — say so in the PR body. The safe foundation.

### PR 3 — persist + reset verified-state by peer `userId`; peer-side "security code changed" signal (task #22) — crypto

The security spine of tap-to-resume; lands **before** PR 4 so the peer is never silently switched.
- Move `verifiedByConv` from ephemeral `useState` to a **persisted** record keyed by `peerUserId` holding the
  **set of per-device safety numbers** for every present peer device (primary + secondaries), **sealed under the
  PRF session key in the `argus-keystore` IndexedDB** — **not** plain `localStorage` (the `userId ↔ number`
  association is social-graph metadata), and **never sent to the server**.
- On an incoming new/resumed conversation whose set of present peer-device safety numbers **differs from the
  stored set** for that `peerUserId` (a changed *or* replaced device) → gate it unverified and surface the
  re-verify prompt, routing into the existing `VerifySecurity` panel.
- Reuses `@argus/crypto` `safetyNumber` ([packages/crypto/src/index.ts:203](packages/crypto/src/index.ts)).
- Gates: **`crypto-reviewer` REQUIRED** (touches the safety-number/trust model) + `security-boundary-auditor`
  (confirm nothing leaves the client). Unit tests (key-change resets verified; same-key keeps it); E2E
  (simulated peer identity change → warning appears, send gated).

### PR 4 — tap-to-resume action (task #23) — crypto

Wire the placeholder tap → `ConversationManager.prepare(peerUserId)` → `VerifySecurity` gate → `confirm()`
([conversations.ts:152,189](apps/web/src/lib/conversations.ts)), which creates a fresh 1:1 MLS group; then
replace-in-place via `findConversationWith(peerUserId)`
([ChatScreen.tsx:284](apps/web/src/features/chat/ChatScreen.tsx)). Reuses `ConversationManager` unchanged; no
server/schema change.
- **Pin the replace-in-place mechanics (PR4 spec):** `findConversationWith` only *finds*; `handleStarted`
  ([ChatScreen.tsx:296](apps/web/src/features/chat/ChatScreen.tsx)) only *adds*. PR4 must specify the exact
  state mutation: **after `confirm()` succeeds**, remove the placeholder row (the dead `conversationId`) from
  the `conversations` state array and insert the new live conversation in one update, so the contact never
  appears twice and a failed/cancelled `confirm()` leaves the placeholder intact.
- Gates: **`crypto-reviewer` REQUIRED** (drives MLS group creation + Welcome from the recovery flow) +
  `security-boundary-auditor`. E2E: reinstall → tap placeholder → verify safety number → send → peer receives
  under the new group; old placeholder gone, one conversation per contact.

### PR 5 — OPTIONAL: `GET /conversations` convenience endpoint

Only if the two round-trips (list ids → fetch members per id) hurt UX. One read-only endpoint returning
`{ conversationId, members[] }` over existing RLS-protected tables. Gates: `security-boundary-auditor`;
`/api-spec` → regenerate `apps/api/openapi.json` → 42Crunch audit (target 90+, fix all incl. LOW); Zod response
schema in `@argus/contracts`. **Default: skip.**

## DB / schema

**None.** `conversation_members` already has `tenant_id` + FORCE RLS + leading-`tenant_id` index
([0007_messaging.sql](apps/api/src/db/migrations/0007_messaging.sql)). All new trust state is client-local and
never sent. PR 5's optional endpoint reads existing tables only.

## How to start (new session)

1. Confirm #16 (PRF PR-2) is landed first.
2. Begin with **PR 1** (the threat-model note) and get `security-architect` sign-off before writing feature code.
3. Then PR 2 → PR 3 → PR 4 in order (PR 4 depends on PR 3). Branch each off `main`; one PR per slice.
