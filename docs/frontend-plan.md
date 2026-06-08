# Frontend Upgrade Implementation Plan (`apps/web`)

> **For agentic workers:** Implement this plan task-by-task using the repo's agent instructions and the tools available in your environment. Steps use checkbox (`- [ ]`) syntax for tracking. Keep each task in its own commit unless the user asks to batch changes.

**Goal:** Make the Argus frontend easier to extend without weakening the E2EE, passkey-first, pseudonymous product direction.

**Architecture:** The client remains a static React/Vite PWA. The server stays crypto-blind, so plaintext, private keys, passphrases, and decrypted attachments stay inside the browser. Future UI work should separate product shell, route pages, local encrypted state, API contracts, and reusable components instead of growing one large chat surface.

**Tech Stack:** React 19, Vite, TypeScript, Tailwind v4, `vite-plugin-pwa`, `@argus/contracts` with Zod, `packages/crypto`, WebSocket gateway, IndexedDB, versioned localStorage keys, Vitest, Playwright.

---

## Step Count

Implement this as **14 steps**.

Reasoning:

- Fewer than 8 steps would mix design-system, routing, auth, chat, tests, and PWA work into risky oversized changes.
- More than 15 steps would create too much planning overhead for a solo project.
- 14 steps keeps the PR automation and Playwright safety net early, then splits UI primitives into creation and adoption, which makes diffs easier to review.

Each step should leave the app runnable at the canonical local SPA URL, `http://localhost:5173/chat`.
If Vite prints a different fallback port because `5173` is already occupied, use that printed URL only for browser inspection and do not change OIDC redirect assumptions.

## Non-Negotiables

- The frontend may decrypt content locally, but the server must never receive plaintext.
- Do not add username/password UI. The app direction is Zitadel-managed registration and passkey-first login.
- Do not store auth tokens, plaintext message content, private keys, passphrases, or presigned URLs in logs.
- Any browser persistence must use versioned keys and migration/fallback logic.
- Any new server call must go through typed client functions and shared contracts where available.
- Mobile layouts must be designed intentionally, not just compressed desktop panels.
- Do not render raw errors if they may contain request data, URLs, tokens, stack traces, or message content.
- Do not introduce new dependencies unless the current complexity earns them.

## Identity Model

Use precise language:

- **Zitadel identity:** stable authenticated subject, used for authentication, authorization, and storage scoping.
- **Argus profile:** pseudonymous app identity, generated Argus ID, optional user-chosen display name, and bounded avatar.

Rules:

- Do not infer app display identity from email address.
- Do not display the Zitadel subject ID as the user's app identity.
- Use the authenticated subject only for storage scoping and authorization boundaries.
- The Argus UI should expose only the generated Argus ID, optional display name, and bounded avatar.

## Current Stack Decision

- Keep **React + Vite + TypeScript**.
- Keep the app as a **static SPA/PWA**, not SSR.
- Keep **Vite** for local development and production bundling.
- Keep **Zitadel** as the auth provider.
- Keep **passkey-first** as the preferred user-facing login direction.
- Keep **Tailwind v4**, but move shared visual decisions into Argus tokens and reusable components.
- Keep the existing `react-router-dom` `BrowserRouter`/`Routes` boundary and extend it for the planned route split. Do not add another routing library or parallel custom route switch unless route complexity clearly requires it.

## Local Dev URL Rule

The canonical local SPA origin is `http://localhost:5173` because Vite defaults to port `5173`, and the local Zitadel redirect URI, `.env.example`, Makefile, and auth docs are configured around that origin.
Alternate Vite fallback ports are temporary browser-inspection URLs only; do not bake them into docs, tests, OIDC settings, or screenshots.

## Browser Storage Classification

| Data type | localStorage | IndexedDB | Memory only | Notes |
| --- | --- | --- | --- | --- |
| Theme and accent settings | Allowed | Optional | Allowed | Versioned keys |
| UI preferences | Allowed | Optional | Allowed | Scope by subject when account-specific |
| Argus pseudonymous profile | Allowed if scoped/versioned | Allowed | Allowed | No email-derived identity |
| Plaintext messages | Not allowed | Not allowed unless encrypted | Temporary only | Never persist plaintext |
| Private keys | Not allowed | Only if wrapped/encrypted | Temporary preferred | Never log |
| Passphrases | Not allowed | Not allowed | Temporary only | Never persist |
| Auth tokens | Avoid | Not allowed | Preferred | Never log |
| Presigned URLs | Not allowed | Not allowed | Temporary only | Never log or cache |
| Decrypted attachments | Not allowed | Not allowed unless explicitly encrypted | Temporary only | Avoid persistence |

Storage key rules:

- Use namespaced, versioned keys.
- Scope account-specific records by authenticated subject id.
- Prefer keys like `argus:v1:profile:<subjectId>`, `argus:v1:settings:<subjectId>`, `argus:v1:device`, and `argus:v1:theme`.
- Avoid generic keys like `profile`, `settings`, `user`, `token`, and `messages`.
- Define fallback behavior for corrupted, unmigratable, or quota-limited state. Fallback may wipe only the affected Argus namespace, never unrelated browser storage.

## Current Screen Map

| Screen or area | Current state | Plan action |
| --- | --- | --- |
| Landing/auth entry | Exists | Align copy and UI with passkey-first flow |
| Zitadel login theme | Partially styled outside app | Keep app-side UI mirrored; avoid forking Zitadel unless policy/theme limits block us |
| OIDC callback | Exists | Keep auth callback isolated from chat rendering |
| Chat shell | Exists | Split into smaller route-owned components |
| Conversation list | Exists | Stabilize mobile behavior and empty/error states |
| Chat header actions menu | Exists | Keep as conversation details entry point |
| Composer | Exists | Keep attachment controls grouped and height-stable |
| Settings | Exists | Split into section components and reusable rows |
| Security/recovery | Exists in settings | Keep recovery embedded under security, no separate recover button path |
| Profile | Exists | Keep Argus ID, user-chosen display name, and bounded avatar handling |
| Attachments | Exists in current main | Keep UI behind capability-aware states |
| Devices/storage | Placeholder-style UI | Turn into real pages when backend contracts are ready |

## Implementation Steps

### Step 1: Frontend Inventory and Route Ownership

**Purpose:** Make the frontend surface explicit before refactoring.

**Files:**

- Modify: `docs/frontend-plan.md`
- Inspect: `apps/web/src/App.tsx`
- Inspect: `apps/web/src/features/chat/ChatScreen.tsx`
- Inspect: `apps/web/src/features/settings/SettingsPanel.tsx`
- Inspect: `apps/web/src/lib/auth.ts`

- [ ] Confirm every user-facing surface has an owner: auth, callback, chat, settings, recovery, devices, storage, attachments.
- [ ] Document which surfaces are real, placeholder, or blocked by backend work.
- [ ] Do not move code in this step.

**Verification:**

```bash
git diff -- docs/frontend-plan.md
```

Expected: documentation-only diff.

**Commit:**

```bash
git add docs/frontend-plan.md
git commit -m "docs: update frontend upgrade plan"
```

### Step 2: Automated Frontend PR Gate

**Purpose:** Make Codex able to run the frontend verification and PR review loop without manual clicking or ad hoc commands.

**Files:**

- Modify: `package.json`
- Create: `scripts/frontend-pr-gate.sh`
- Create: `scripts/fetch-pr-review-threads.py`
- Modify: `docs/frontend-plan.md`

- [ ] Add root script `frontend:verify`.
- [ ] If `apps/web` already has `test:e2e`, include it in `frontend:verify`; otherwise print a clear skip message until Step 3 adds it.
- [ ] Add `scripts/fetch-pr-review-threads.py` using `gh api graphql` to print unresolved review threads with `id`, `isResolved`, `isOutdated`, `path`, `line`, author, and body.
- [ ] Add `scripts/frontend-pr-gate.sh` that detects the current PR with `gh pr view --json number,url`.
- [ ] The gate script must wait for CI with `gh pr checks <number> --watch`.
- [ ] The gate script must comment `@codex review`.
- [ ] The gate script must poll until a `chatgpt-codex-connector` review for the current head commit appears.
- [ ] The gate script must fetch unresolved review threads and exit nonzero if unresolved actionable Codex findings remain.
- [ ] The gate script must print the exact review thread ids and URLs needed for follow-up replies.
- [ ] Add `--merge` only if it can prove CI is green and the latest Codex review is clean; otherwise leave merge manual.

**Verification:**

```bash
pnpm frontend:verify
shellcheck scripts/frontend-pr-gate.sh
python3 -m py_compile scripts/fetch-pr-review-threads.py
```

Expected: `frontend:verify` runs available checks, shell script passes ShellCheck if installed, and Python compiles. If ShellCheck is not installed locally, document the skip in the PR body.

**Commit:**

```bash
git add package.json scripts/frontend-pr-gate.sh scripts/fetch-pr-review-threads.py docs/frontend-plan.md
git commit -m "chore: automate frontend pr gate"
```

### Step 3: Baseline Frontend Smoke Tests

**Purpose:** Add regression safety before route, settings, primitives, or chat refactors.

**Files:**

- Modify: `apps/web/package.json`
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/e2e/chat.spec.ts`
- Create: `apps/web/e2e/settings.spec.ts`
- Create: `apps/web/e2e/auth.spec.ts`

- [ ] Add a Playwright smoke test command.
- [ ] Test `/chat` renders successfully.
- [ ] Test settings can be opened.
- [ ] Test mobile settings section navigation works.
- [ ] Test profile save works with generated avatar.
- [ ] Test the auth/passkey entry route does not show app-owned username/password login fields.

**Verification:**

```bash
pnpm --filter @argus/web test
pnpm --filter @argus/web test:e2e
pnpm --filter @argus/web typecheck
```

Expected: unit tests and Playwright smoke tests pass locally.

**Commit:**

```bash
git add apps/web/package.json apps/web/playwright.config.ts apps/web/e2e
git commit -m "test(web): add frontend smoke tests"
```

### Step 4: Argus Design Tokens

**Purpose:** Put colors, spacing, radius, shadows, and accent choices behind stable tokens.

**Files:**

- Modify: `apps/web/src/index.css`
- Modify: `apps/web/tailwind.config.*` if present
- Create: `apps/web/src/features/ui/theme.ts`
- Create: `apps/web/src/features/ui/theme.spec.ts`

- [ ] Define tokens for app background, panel, panel-subtle, border, text, muted text, danger, success, and accent colors.
- [ ] Keep purple as the default accent.
- [ ] Preserve the existing user-selectable accent color list.
- [ ] Add a test that validates each accent has `id`, `label`, `hex`, and `soft` values.

**Verification:**

```bash
pnpm --filter @argus/web test -- theme.spec.ts
pnpm --filter @argus/web typecheck
```

Expected: theme tests and typecheck pass.

**Commit:**

```bash
git add apps/web/src/index.css apps/web/src/features/ui/theme.ts apps/web/src/features/ui/theme.spec.ts
git commit -m "feat(web): add argus design tokens"
```

### Step 5: Create Reusable UI Primitives

**Purpose:** Create shared UI components without broad adoption churn.

**Files:**

- Create: `apps/web/src/features/ui/Button.tsx`
- Create: `apps/web/src/features/ui/IconButton.tsx`
- Create: `apps/web/src/features/ui/Modal.tsx`
- Create: `apps/web/src/features/ui/Avatar.tsx`
- Create: `apps/web/src/features/ui/SettingsRow.tsx`
- Create: `apps/web/src/features/ui/StateBlock.tsx`
- Create: `apps/web/src/features/ui/index.ts`

- [ ] Create primitives and use each in at most one safe location.
- [ ] `IconButton` must require `aria-label`.
- [ ] `Button` must support `disabled` and `loading` states.
- [ ] `Modal` must set `role="dialog"`, `aria-modal="true"`, an accessible label/title, close-on-escape behavior, and visible focus styles.
- [ ] Clickable row-like controls must be keyboard-friendly.
- [ ] `Avatar` must reuse the safe avatar source boundary.
- [ ] Do not redesign chat or settings in this step.

**Verification:**

```bash
pnpm --filter @argus/web typecheck
pnpm --filter @argus/web test
pnpm lint
```

Expected: no TypeScript, test, or lint failures.

**Commit:**

```bash
git add apps/web/src/features/ui apps/web/src/features/settings apps/web/src/features/chat
git commit -m "feat(web): create shared ui primitives"
```

### Step 6: Adopt UI Primitives Mechanically

**Purpose:** Replace duplicated UI styling without changing behavior.

**Files:**

- Modify: `apps/web/src/features/chat`
- Modify: `apps/web/src/features/settings`
- Modify: `apps/web/src/routes` if route files already exist

- [ ] Replace duplicated button classes with `Button`.
- [ ] Replace icon-only buttons with `IconButton`.
- [ ] Replace repeated modal shells with `Modal`.
- [ ] Replace repeated avatar image rendering with `Avatar`.
- [ ] Replace repeated settings rows with `SettingsRow`.
- [ ] Keep visual output as close as possible to the baseline screenshots.

**Verification:**

```bash
pnpm --filter @argus/web typecheck
pnpm --filter @argus/web test
pnpm --filter @argus/web test:e2e
pnpm lint
```

Expected: baseline smoke tests still pass.

**Commit:**

```bash
git add apps/web/src/features/chat apps/web/src/features/settings apps/web/src/features/ui apps/web/src/routes
git commit -m "refactor(web): adopt shared ui primitives"
```

### Step 7: App Shell and Route Structure

**Purpose:** Make pages explicit and keep chat from owning the whole app.

**Files:**

- Modify: `apps/web/src/App.tsx`
- Create: `apps/web/src/routes/AuthCallbackRoute.tsx`
- Create: `apps/web/src/routes/ChatRoute.tsx`
- Create: `apps/web/src/routes/SettingsRoute.tsx`
- Create: `apps/web/src/routes/SecurityRoute.tsx`
- Create: `apps/web/src/routes/DevicesRoute.tsx`
- Create: `apps/web/src/routes/StorageRoute.tsx`

- [ ] Keep `/chat` as the main product route.
- [ ] Keep `/auth/callback` isolated from chat rendering.
- [ ] Add route shells for settings, security, devices, and storage.
- [ ] Route components own layout boundaries.
- [ ] Route components must not make direct untyped backend calls.
- [ ] Extend the existing `react-router-dom` route configuration instead of adding another router dependency or a parallel custom route switch.

**Verification:**

```bash
pnpm --filter @argus/web typecheck
pnpm --filter @argus/web test
pnpm --filter @argus/web test:e2e
```

Expected: app compiles and baseline smoke tests pass.

**Commit:**

```bash
git add apps/web/src/App.tsx apps/web/src/routes
git commit -m "feat(web): add route-owned app shell"
```

### Step 8: Settings Section Split

**Purpose:** Make settings maintainable and mobile-first.

**Files:**

- Modify: `apps/web/src/features/settings/SettingsPanel.tsx`
- Create: `apps/web/src/features/settings/ProfileSettings.tsx`
- Create: `apps/web/src/features/settings/SecuritySettings.tsx`
- Create: `apps/web/src/features/settings/PrivacySettings.tsx`
- Create: `apps/web/src/features/settings/NotificationSettings.tsx`
- Create: `apps/web/src/features/settings/AppearanceSettings.tsx`
- Create: `apps/web/src/features/settings/DataStorageSettings.tsx`
- Create: `apps/web/src/features/settings/DeviceSettings.tsx`

- [ ] Keep the mobile behavior: first show section list, then open selected section.
- [ ] Keep account recovery embedded under Security & Recovery.
- [ ] Keep Privacy values on default.
- [ ] Keep Push notifications on Auto.
- [ ] Keep Appearance dark-only, no language selector, no density, no reduce motion.
- [ ] Keep font size as 10 selectable levels.
- [ ] Keep color changer with default purple plus the approved accent list.

**Verification:**

```bash
pnpm --filter @argus/web typecheck
pnpm --filter @argus/web test
pnpm --filter @argus/web test:e2e
```

Manual browser checks:

- Open settings on desktop width.
- Open settings on mobile width.
- Select each section.
- Save profile with generated avatar.
- Upload a supported avatar and verify no layout break.

**Commit:**

```bash
git add apps/web/src/features/settings
git commit -m "refactor(web): split settings sections"
```

### Step 9: Auth and Pseudonymous Profile Boundary

**Purpose:** Keep passkey-first auth decisions separate from local profile preferences.

**Files:**

- Modify: `apps/web/src/lib/auth.ts`
- Modify: `apps/web/src/features/auth/AuthContext.tsx`
- Modify: `apps/web/src/features/settings/ProfileSettings.tsx`
- Modify: `apps/web/src/features/chat/ChatScreen.tsx`

- [ ] Keep app UI free of username/password login controls.
- [ ] Treat Zitadel as the registration/passkey authority.
- [ ] Keep Argus profile fields local: generated Argus ID, optional display name, bounded avatar.
- [ ] Keep profile storage scoped by authenticated subject id.
- [ ] Keep mismatched legacy profile records discarded.
- [ ] Do not infer display identity from email.
- [ ] Do not display the Zitadel subject id as the user's app identity.

**Verification:**

```bash
pnpm --filter @argus/web typecheck
pnpm --filter @argus/web test
pnpm --filter @argus/web test:e2e
```

Manual browser checks:

- Open login entry.
- Start OIDC flow.
- Return to `/auth/callback`.
- Open chat.
- Open profile settings.

**Commit:**

```bash
git add apps/web/src/lib/auth.ts apps/web/src/features/auth apps/web/src/features/settings apps/web/src/features/chat
git commit -m "feat(web): harden pseudonymous profile boundary"
```

### Step 10: Typed API Client Boundary

**Purpose:** Keep components from hand-rolling backend calls.

**Files:**

- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/lib/api-client.ts`
- Create: `apps/web/src/lib/api-client.spec.ts`
- Inspect: `packages/contracts/src`

- [ ] Centralize request creation, auth headers, JSON parsing, and Zod validation.
- [ ] Rely on inferred types from `@argus/contracts` Zod schemas instead of duplicate hand-written response types.
- [ ] Return typed success/error results instead of throwing from component code.
- [ ] Keep tokens out of logs.
- [ ] Keep presigned URLs out of logs.
- [ ] If a backend contract changes, the frontend build should fail at compile time or validation tests should fail.

**Verification:**

```bash
pnpm --filter @argus/web test -- api-client.spec.ts
pnpm --filter @argus/web typecheck
```

Expected: API client tests cover success, validation failure, auth failure, and network failure.

**Commit:**

```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/api-client.ts apps/web/src/lib/api-client.spec.ts
git commit -m "refactor(web): centralize typed api client"
```

### Step 11: Browser Persistence Versioning

**Purpose:** Make localStorage and IndexedDB changes upgrade-safe.

**Files:**

- Create: `apps/web/src/lib/persistence.ts`
- Create: `apps/web/src/lib/persistence.spec.ts`
- Modify: `apps/web/src/features/chat/ChatScreen.tsx`
- Modify: `apps/web/src/features/settings/ProfileSettings.tsx`

- [ ] Define versioned key helpers for localStorage records.
- [ ] Add safe JSON parse helpers.
- [ ] Add quota-safe write helpers.
- [ ] Add migration behavior for legacy anonymous/pseudonymous profile keys.
- [ ] Add fallback/wipe behavior for unmigratable records and corrupted Argus state.
- [ ] Wipe only known Argus namespaced keys, not unrelated browser storage.
- [ ] Keep plaintext message content out of localStorage.
- [ ] Keep private keys, passphrases, auth tokens, presigned URLs, and decrypted attachments out of localStorage.

**Verification:**

```bash
pnpm --filter @argus/web test -- persistence.spec.ts
pnpm --filter @argus/web typecheck
```

Expected: tests cover missing record, invalid JSON, version mismatch, quota failure, legacy profile migration, and scoped namespace wipe.

**Commit:**

```bash
git add apps/web/src/lib/persistence.ts apps/web/src/lib/persistence.spec.ts apps/web/src/features/chat apps/web/src/features/settings
git commit -m "feat(web): add versioned browser persistence"
```

### Step 12: Chat Feature Decomposition

**Purpose:** Keep chat UI changes small and safer.

**Files:**

- Modify: `apps/web/src/features/chat/ChatScreen.tsx`
- Create: `apps/web/src/features/chat/useChatState.ts`
- Create: `apps/web/src/features/chat/useLiveConversations.ts`
- Create: `apps/web/src/features/chat/useMessageSending.ts`
- Create: `apps/web/src/features/chat/useConversationBackfill.ts`

- [ ] Split this step if the diff becomes large.
- [ ] Step 12A: extract read-only chat state.
- [ ] Step 12B: extract message sending.
- [ ] Step 12C: extract WebSocket/live conversation behavior.
- [ ] Step 12D: extract backfill/history behavior.
- [ ] Keep crypto and live WebSocket behavior in hooks with narrow inputs.
- [ ] Use stable refs, callbacks, and memo boundaries for rapidly changing live state.
- [ ] Do not add Zustand or another local store unless profiling or real UI lag proves it is needed.
- [ ] Preserve the current live conversation behavior.
- [ ] Preserve current-user profile normalization for new and existing conversations.

**Verification:**

```bash
pnpm --filter @argus/web typecheck
pnpm --filter @argus/web test
pnpm --filter @argus/web test:e2e
```

Manual browser checks:

- Select seed conversation.
- Start new conversation when device is unlocked.
- Send demo message.
- Send live message when live conversation is available.
- Open settings and change profile name.

**Commit:**

```bash
git add apps/web/src/features/chat
git commit -m "refactor(web): split chat state hooks"
```

### Step 13: Async, Empty, and Safe Error States

**Purpose:** Make incomplete backend or offline states understandable without leaking sensitive data.

**Files:**

- Create: `apps/web/src/lib/safe-ui-error.ts`
- Create: `apps/web/src/lib/safe-ui-error.spec.ts`
- Modify: `apps/web/src/features/ui/StateBlock.tsx`
- Modify: `apps/web/src/features/chat/ConversationList.tsx`
- Modify: `apps/web/src/features/chat/ChatInput.tsx`
- Modify: `apps/web/src/features/settings`
- Modify: `apps/web/src/routes`

- [ ] Add `toSafeUiError(error)` or equivalent.
- [ ] Do not render raw `error.message` directly if the error may contain request data, response data, URLs, tokens, stack traces, or message content.
- [ ] UI errors should show only safe metadata and human-readable generic messages.
- [ ] Add reusable loading state.
- [ ] Add reusable empty state.
- [ ] Add reusable error state.
- [ ] Add reconnect/offline banner for WebSocket loss.

**Verification:**

```bash
pnpm --filter @argus/web test -- safe-ui-error.spec.ts
pnpm --filter @argus/web typecheck
pnpm --filter @argus/web test:e2e
```

Manual browser checks:

- Disable backend API and reload.
- Open chat.
- Open settings.
- Confirm UI shows usable error states without crashing or exposing raw internals.

**Commit:**

```bash
git add apps/web/src/lib/safe-ui-error.ts apps/web/src/lib/safe-ui-error.spec.ts apps/web/src/features/ui apps/web/src/features/chat apps/web/src/features/settings apps/web/src/routes
git commit -m "feat(web): add safe frontend async states"
```

### Step 14: PWA, Security Headers, Performance, and Privacy-Safe Observability

**Purpose:** Make production frontend behavior predictable without collecting or caching sensitive content.

**Files:**

- Modify: `apps/web/vite.config.ts`
- Modify: `apps/web/src/lib/ws.ts`
- Create: `apps/web/src/lib/telemetry.ts`
- Create: `apps/web/src/lib/telemetry.spec.ts`
- Create: `docs/threat-models/frontend-observability.md`

- [ ] Prefer static asset caching only at first.
- [ ] Do not cache `/auth/callback`.
- [ ] Do not cache authorization-bearing requests.
- [ ] Do not cache presigned attachment URLs.
- [ ] Do not cache API responses containing sensitive user-specific data unless intentionally designed.
- [ ] Do not cache decrypted content.
- [ ] Keep runtime caching explicit and narrow.
- [ ] Add bundle size visibility.
- [ ] Keep route-level lazy loading where it reduces initial load without complicating chat startup.
- [ ] Add privacy-safe telemetry helpers for event names and technical metadata only.
- [ ] Add tests that reject message content, tokens, keys, passphrases, presigned URLs, and full authorization headers.
- [ ] Document target hosting headers: `Content-Security-Policy`, `Referrer-Policy`, `Permissions-Policy`, `X-Content-Type-Options`, `frame-ancestors`, `base-uri`, and optional COOP/COEP later if needed.
- [ ] Add a threat-model note for frontend telemetry, browser persistence, PWA caching, and hosting headers.

**Verification:**

```bash
pnpm --filter @argus/web test -- telemetry.spec.ts
pnpm --filter @argus/web typecheck
pnpm --filter @argus/web build
```

Expected: tests, typecheck, and production build pass.

**Commit:**

```bash
git add apps/web/vite.config.ts apps/web/src/lib/ws.ts apps/web/src/lib/telemetry.ts apps/web/src/lib/telemetry.spec.ts docs/threat-models/frontend-observability.md
git commit -m "feat(web): add privacy-safe frontend observability"
```

## Review Guidance

Recommended default for the first frontend upgrade pass:

1. Keep Step 1 for shared understanding.
2. Keep Step 2 so Codex can run the PR loop by command.
3. Keep Step 3 before any UI refactor.
4. Keep Steps 4-8 for UI maintainability and immediate velocity.
5. Keep Steps 9-11 for auth/profile/persistence safety.
6. Keep Step 12 split into smaller commits if the chat diff grows.
7. Keep Step 14 only if PWA, telemetry, performance, or deployment headers are part of the next milestone.

Best first implementation batch after review:

- Step 1: Frontend Inventory and Route Ownership
- Step 2: Automated Frontend PR Gate
- Step 3: Baseline Frontend Smoke Tests
- Step 4: Argus Design Tokens
- Step 5: Create Reusable UI Primitives
- Step 6: Adopt UI Primitives Mechanically
- Step 8: Settings Section Split

## Standard Verification Before Each PR

Preferred single command after Step 2 exists:

```bash
pnpm frontend:verify
```

Until Step 2 exists, run:

```bash
pnpm --filter @argus/web typecheck
pnpm --filter @argus/web test
pnpm lint
pnpm format:check
```

For UI-heavy PRs, also run:

```bash
pnpm --filter @argus/web test:e2e
```

Manual checks:

- Desktop chat at `http://localhost:5173/chat`, or the actual Vite fallback URL printed by `pnpm --filter @argus/web dev` when port `5173` is occupied
- Mobile chat width
- Settings open/close
- Settings section navigation
- Profile save
- Conversation selection
- Composer send button alignment

## PR Review Gate

Preferred single command after Step 2 exists:

```bash
scripts/frontend-pr-gate.sh
```

Every frontend PR must follow this loop before merge:

- [ ] Push the PR branch.
- [ ] Wait for CI checks.
- [ ] Ping Codex review on the PR:

```bash
gh pr comment <PR_NUMBER> --body '@codex review'
```

- [ ] Wait for the `chatgpt-codex-connector` review to post.
- [ ] Inspect every unresolved Codex review thread.
- [ ] If Codex finds a real issue, fix it locally, run the relevant verification, commit, and push the PR update.
- [ ] After every pushed PR update, ping Codex again and repeat the loop.
- [ ] If a Codex finding is intentionally not fixed, reply on the PR with the technical justification before merge.
- [ ] Merge only when both are true:
  - CI is green.
  - Latest Codex review has no unresolved actionable findings, or every remaining finding has an explicit PR justification.

Do not merge on green CI alone.
