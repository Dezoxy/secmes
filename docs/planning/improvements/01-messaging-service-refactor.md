# Track 1 — Split the messaging service (structural refactor, zero behavior change)

> **Status:** IMPLEMENTED 2026-06-21. Pure structural refactor — no behavior change, no new endpoints.

## Problem

`apps/api/src/messaging/messaging.service.ts` is **1,185 lines** — the largest application file in the
repo — and carries six unrelated responsibilities in one class: conversation lifecycle, MLS welcome
handling, message send/receive, commit processing, history listing, sync, and delivery receipts. Its
companion `messaging.service.spec.ts` is 747 lines.

## Why it matters

This file is the single biggest merge-conflict surface and the steepest local onboarding read in the API.
Nothing is _broken_ — it is well-tested — but every messaging change funnels through one class, so two
parallel features almost always collide here, and a new engineer must hold all six concerns in their head
at once. Shrinking the cognitive unit is the highest readability payoff in the codebase.

## Proposed approach

Keep `MessagingService` as the **single public entry point** (controllers and the realtime gateway keep
calling the exact same methods), and delegate to focused collaborator services it holds via constructor
injection. The public method surface stays byte-for-byte identical:

`isMember`, `createConversation`, `deliverWelcome`, `listMyWelcomes`, `getWelcomeMaterial`,
`consumeWelcome`, `sendMessage`, `listMessages`, `syncMessages`, `recordReceipt` (+ commit handling).

Collaborator split (new files under `apps/api/src/messaging/`):

- `conversation.service.ts` — `isMember`, `createConversation`, `getConversationMembers`.
- `welcome.service.ts` — `deliverWelcome`, `listMyWelcomes`, `getWelcomeMaterial`, `consumeWelcome` (+ the private device-proof check).
- `message-delivery.service.ts` — `sendMessage`, `postCommit`, `listCommits` (the MLS commit chain + `clientMessageId` idempotency).
- `message-history.service.ts` — `listMessages`, `syncMessages`, `recordReceipt`, `getReceipts` (+ the read-path row/cursor helpers).
- `messaging.types.ts` — the shared return-type interfaces, re-exported by the façade so existing import paths are unchanged.

`MessagingService` stays a thin façade that composes these and preserves each method's self-contained
`withTenant` transaction. The collaborators are **constructed by the façade**, not registered as separate
DI providers — this keeps the public DI surface and the contract spec (`messaging.service.spec.ts`)
byte-for-byte unchanged, so `messaging.module.ts` is untouched.

## Files touched

- New: `apps/api/src/messaging/{conversation,welcome,message-delivery,message-history}.service.ts` + `messaging.types.ts`.
- Edit: `apps/api/src/messaging/messaging.service.ts` (becomes the façade).
- Tests: `messaging.service.spec.ts` passed **unchanged** as the contract test (45/45 against a live Postgres).
- Untouched: `messaging.module.ts`, controllers, DTOs, `@argus/contracts`, all SQL/RLS — no wire or schema change.

## Risks & what could break

- **Transaction / RLS boundary drift.** Today the work runs under one `withTenant` transaction; splitting
  must not break that into multiple transactions or move a query outside the tenant context. The
  collaborators must run inside the façade's existing transaction scope.
- **Hidden ordering coupling.** `sendMessage` interacts with commit staging; the façade must preserve the
  current call order. The existing spec covers this — keep it green throughout.
- **Circular injection.** Collaborators must not inject `MessagingService` back. Shared helpers go in a
  plain util module, not a service.

## How to verify by hand

1. `pnpm --filter @argus/api test` — `messaging.service.spec.ts` passes unchanged (proves no behavior change).
2. `pnpm --filter @argus/api typecheck` — no type regressions across the façade boundary.
3. Diff the public surface: the methods listed above are still public on `MessagingService` with identical
   signatures (a `git diff` of the class declaration should show only bodies delegating out).
4. `pnpm --filter @argus/web test:e2e` chat suites still pass (send/receive/sync unchanged end-to-end).

## Out of scope

Any change to message behavior, endpoints, contracts, or the DB schema. This is mechanical only.
