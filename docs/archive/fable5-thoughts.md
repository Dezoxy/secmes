# What Fable 5 thinks — multi-hat repo review

> An AI-assisted, multi-perspective review of the argus repo (code + `docs/planning/roadmap/README.md`), written 2026-06-10.
> Method: five parallel deep-dives over the actual source — frontend (`apps/web`), backend (`apps/api`),
> crypto (`packages/crypto` + `packages/contracts`), infra/CI (`infra/`, `compose*.yaml`, workflows), and the
> docs/threat-model corpus — then consolidated here. Opinions are point-in-time; checkpoint numbers refer to
> `docs/planning/roadmap/README.md`.

**TL;DR:** This is one of the most disciplined solo-built codebases I've reviewed. The security engineering
is genuinely strong — not security theater. The real risks aren't in the code: they're operational (single
VM, untested restore, unbooked audits), product-shaped (single-device, no search, verification friction),
and structural (ts-mls bus factor, everything hinging on one "arming" event that hasn't happened yet).

---

## 🔐 Security engineer hat

This is the strongest dimension. What stands out:

- **The invariants are enforced mechanically, not by intention.** `withTenant()` drops to a non-bypass role
  and sets the RLS var inside every transaction; FORCE RLS + WITH CHECK + composite-FK tenant pinning on all
  16 migrations means cross-tenant access fails at *three* layers. The crypto-blind claim is **proven by a
  test** (the two-device harness asserts plaintext bytes never appear in wire blobs) — that's rare.
- **37 threat-model notes that are real analyses.** They name residual risks honestly ("TOFU gap",
  "multi-tab send window", "backup overwrite bricks recovery") instead of declaring victory. The Codex P1/P2
  findings recorded and fixed in the welcome-delivery work (device-bound consume with Ed25519
  proof-of-possession) show the review loop actually works.
- **The crypto package is misuse-resistant**: pinned single ciphersuite with downgrade-resistant
  KeyPackages, Argon2id floor *and* ceiling validation before the KDF runs, AAD-bound headers, a
  per-conversation op mutex preventing ratchet/nonce reuse, fresh CSPRNG IVs everywhere, and tamper tests
  dominating the test suite.
- **Logging hygiene is default-deny**, not blocklist: the Sentry scrubber strips everything except four
  allowed headers, plus an Alloy scrub stage as defense-in-depth.

What worries me:

1. **ts-mls is a young, single-maintainer library and the entire product stands on it.** MIT-forkable, yes —
   but G4 (independent crypto review) is the only thing that converts "we used MLS correctly" from belief to
   evidence, and **S2 (booking the paid audits) is still unchecked**. The roadmap itself calls lead time the
   schedule risk. This is the #1 to-do.
2. **The safety-number MITM defense is built but only proven against a loopback peer.** Until checkpoint
   20's live-remote-peer residual closes, the server is still a trusted introducer in practice.
3. **JS can't truly wipe keys, and IndexedDB is one XSS away.** The sealed-at-rest keystore + strict CSP +
   SRI narrows this as far as a PWA can — but a PWA delivers its crypto code on every load. Plan §3.2 says
   "don't oversell it"; hold to that on the marketing page.
4. **The metadata graph (who talks to whom, when) lives on the server and at Cloudflare.** Accepted and
   documented — but for the journalist/M&A buyers being targeted, metadata *is* often the secret. Be
   explicit about this in sales material.

## 🏗️ Backend engineer hat

Grade: **A-**. ~5.1K LOC, clean module layering, Zod at every boundary, 404-as-no-oracle authz factored
into one shared `requireMembership`, idempotency done right, rate limits keyed on verified identity with
per-threat caps. Concrete criticisms:

1. **`MessagingService` is a 671-line god-object** — conversations, messages, welcomes, device proofs,
   receipts, and sync in one class. Split it into Conversation/Message/Welcome/Receipt services before it
   gets worse; it's a few hours and no API change.
2. **6 of 10 controllers have no spec files.** The service and RLS layers are well-tested (the live-DB RLS
   specs are excellent), but the DTO-mapping/validation boundary is uncovered — a NestJS or Zod upgrade
   could silently break it.
3. **No end-to-end attachment test against a real S3** (MinIO is right there in the compose stack — use
   testcontainers or the dev stack in CI).
4. **Audit writes happen in a separate transaction after commit** — a crash in between loses the audit row.
   Small window, but for a product selling tamper-resistant audit logs, document or fix it.
5. **DTO/`@ApiProperty` duplication across 30+ classes** is a growing maintenance tax.

## 🎨 Frontend / UX hat

Grade: **B+ overall, A on fundamentals**. ~10.7K LOC, feature-first structure, strict TS, 73 ARIA
references with real focus management and E2E a11y tests — better than most production PWAs. But:

1. **`ChatScreen` is becoming a god-component** (478 LOC, 14 `useState`). Extract modal/sidebar/
   mobile-animation state into hooks now, while it's cheap.
2. **Zero component render tests.** 32 test files cover crypto/storage/API/hooks superbly, but
   `MessageList`, `ChatHeader`, `ConversationList` etc. have no RTL coverage — a refactor there breaks
   silently between E2E runs.
3. **Offline UX is the weakest link for a *PWA messenger***: no send queue (offline send fails
   immediately), no `navigator.onLine` indicator outside live conversations, no skeletons during backfill.
   Users on flaky mobile networks will feel this daily. A persistent IndexedDB send queue ranks above
   several roadmap items.
4. **The verification UX is a product risk, not just a UX nit.** Gating conversation creation on
   out-of-band safety-number comparison is cryptographically right and adoption-poison if forced. Signal
   makes verification optional with a visible state. Consider TOFU-with-prominent-badge as default and
   mandatory-verify as a per-tenant policy — that maps neatly onto the B2B model.
5. **Single-device + no message search + history lost on recovery** is a hard UX cliff. All deliberate, all
   documented — but together they define the product's ceiling. The first beta-user complaints will be
   these three, in this order.

## ⚙️ Platform / DevOps hat

Honestly excellent for a solo project: keyless cosign + digest-pinned pulls + exact-SHA deploy bundles,
SHA-pinned actions, two-layer deploy gating, zero published ports enforced by a CI guard, every container
non-root/read-only/cap-dropped/limited, secrets as files from Key Vault via Managed Identity with zero
static creds anywhere. The supply chain is better than most funded startups'.

The risks are operational, not code:

1. **Nothing is deployed.** The whole Phase-0 track is "built as gated code." Reality will diverge from
   code the day it's armed — budget real time for the arming + first-deploy debugging, and treat 8a
   (staging) as the very first arming step, not an afterthought.
2. **Single VM = hard SPOF, 24h RPO** — fine for beta, but it needs to be in the DPA/SLA language honestly.
3. **The restore drill (#49) hasn't run.** An untested backup is a hope, not a backup. Also: the age
   private key being offline-only means losing *it* loses every backup — make sure it physically exists in
   two places.
4. **Alertmanager has no receiver wired** — observability that pages no one is a dashboard, not alerting.
5. Migrate Terraform state to an encrypted remote backend before anyone else touches the repo.

## 📋 Process / roadmap hat

- The roadmap is the best part *and* showing strain: the status paragraph and per-item annotations have
  become **multi-thousand-word single blobs** that are effectively write-only. The history is valuable —
  move it to per-checkpoint changelog notes and keep the roadmap to one-line statuses. Same for checkpoint
  41a (a ~1,500-word checklist item).
- **README drift**: it still says "Status: Phase 0" and "api (Phase 0: health + version only)" while the
  project is deep in Phase 5/6. Five-minute fix, big first-impression win for the audits about to be
  commissioned.
- The threat-model notes mostly sit at `DRAFT — ratify` forever. Add a one-line "RATIFIED date" ritual so
  the gate signal is real.

## Bottom line

**Engineering: top-decile.** The six invariants are real, enforced by code, CI, and tests rather than by
docs. If this discipline holds, G4/G5 should be remediation exercises, not surprises.

**Priority order:**

1. **Book G4/G5 now** (S2) — lead time is the critical path and it's external.
2. **Arm staging** (8a) — every `[~]` item is blocked on contact with reality.
3. **Close the live-remote-peer verification residual** (#20) — the last open crypto-design item.
4. **Run the restore drill + wire Alertmanager receivers** — cheap, and the difference between having ops
   and believing you do.
5. **Offline send queue + rethink mandatory verification** — the two changes that most affect whether real
   users stay.

The thing to watch isn't the code — it's that the product's deliberate constraints (single device, no
search, no compliance mode, verification friction) all stack on the same buyer conversation. The
engineering has earned the right to ship; the go-to-market honesty plan §15 demands will decide whether it
sells.
