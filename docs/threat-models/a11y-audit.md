# Accessibility audit sign-off: WCAG 2.1 AA (#44)

> This is an audit note, not a feature threat model — no new trust boundary or
> data flow. Written post-implementation as the sign-off record for checkpoint #44.

## Scope

Argus web PWA (`apps/web`). Target standard: **WCAG 2.1 AA**.  
Audit date: 2026-06-11. Tool: `@axe-core/playwright` v4.11.x, Chromium.

---

## Criteria checked

| Criterion | Description | Result |
|-----------|-------------|--------|
| 1.1.1 Non-text content | Decorative icons silenced with `aria-hidden`; interactive icons have accessible names via `aria-label` on the parent button | Pass |
| 1.3.1 Info and relationships | Semantic landmarks (`main`, `complementary`, `navigation`, `region`), lists, and heading hierarchy verified via axe | Pass |
| 1.4.3 Contrast (text) | All body/label/hint text ≥ `/60` Tailwind opacity (≥ 7:1 on `#12121a`, ≥ 6:1 on `#1a1a26`). CSS variable `--argus-color-text-muted` raised from 45% to 60%. Disabled-state text is exempt per WCAG 1.4.3 exception. | Pass |
| 1.4.11 Non-text contrast | Interactive icon-only controls at `/40` opacity: computed contrast ~4.1–4.3:1 against dark panel bg, exceeds the 3:1 threshold for UI components | Pass |
| 1.4.13 Content on hover/focus | Floating menus and tooltips are dismissible, persistent, and hoverable | Pass |
| 2.1.1 Keyboard | All interactive controls reachable and operable via keyboard; Tab order follows visual order | Pass |
| 2.1.2 No keyboard trap | `Modal.tsx` focus trap implemented with Tab/Shift-Tab wrapping; verified it traps inside open dialogs and releases on close | Pass |
| 2.4.3 Focus order | Focus moves into dialog on open and returns to trigger on close (verified in `a11y-responsive.spec.ts`) | Pass |
| 2.4.4 Link purpose | Placeholder "Terms of Service" / "Privacy Policy" elements converted to inert `<span aria-disabled="true">` — not in tab order | Pass |
| 3.3.2 Labels or instructions | All form inputs have visible labels or `aria-label`; `UnlockGate` password inputs labelled | Pass |
| 4.1.2 Name, role, value | Buttons, menus, dialogs, and form controls carry correct ARIA roles and states (expanded, pressed, haspopup, modal, live) | Pass |
| 4.1.3 Status messages | Attachment chip list wrapped in `role="status" aria-live="polite"` | Pass |

---

## Automated scan

`pnpm --filter @argus/web test:e2e -- --grep @a11y` runs `e2e/wcag-audit.spec.ts` which scans:

- `/chat` desktop
- `/chat` mobile 390×844
- Settings dialog open
- Landing page `/`
- Image attachment preview (skipped when no seed image is visible)

All views must pass with **zero axe violations** tagged `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`.

---

## Code changes in this checkpoint

| File | Change |
|------|--------|
| `apps/web/src/index.css` | `--argus-color-text-muted` 45% → 60% |
| `apps/web/src/lib/pref.ts` | Extracted `prefersReducedMotion()` helper (shared by App.tsx + ChatScreen.tsx) |
| `apps/web/src/App.tsx` | Carousel auto-play guards `prefers-reduced-motion`; ToS/Privacy links made inert `<span>`; text `/30`, `/40` → `/60` |
| `apps/web/src/features/ui/Modal.tsx` | Focus trap on Tab/Shift-Tab |
| `apps/web/src/features/device/UnlockGate.tsx` | `aria-label` on all password inputs; contrast fixes |
| `apps/web/src/features/chat/ConversationList.tsx` | `aria-hidden` on decorative Search icon |
| `apps/web/src/features/chat/ChatInput.tsx` | `aria-live` region on attachment chips |
| `apps/web/src/features/chat/ChatHeader.tsx` | Contrast fixes; `aria-hidden` on decorative icons |
| `apps/web/src/features/chat/MessageBubble.tsx` | Dynamic `aria-label` on status icons; contrast fixes |
| `apps/web/src/features/chat/ChatScreen.tsx` | Contrast fix; removed duplicate `prefersReducedMotion` |
| `apps/web/src/features/chat/AttachmentImage.tsx` | Contrast fixes on error/loading states |
| `apps/web/src/features/chat/StartConversation.tsx` | `aria-hidden` on decorative Search icon; contrast fix |
| `apps/web/src/features/chat/VerifySecurity.tsx` | Contrast fix on loading state |
| `apps/web/src/features/ui/StateBlock.tsx` | Contrast fixes |
| `apps/web/src/features/ui/SettingsRow.tsx` | Contrast fix |
| `apps/web/src/features/settings/*.tsx` | Contrast fixes across all settings components |
| `apps/web/src/features/recovery/RecoveryPanel.tsx` | Contrast fixes; `aria-hidden` on decorative icons |
| `apps/web/src/routes/RoutePageShell.tsx` | Contrast fix |
| `apps/web/e2e/wcag-audit.spec.ts` | New axe audit spec (tag: `@a11y`) |

---

## Deferred items (not a WCAG 2.1 AA violation)

- **Target size 44×44 px** (WCAG 2.5.5) — this is a **AAA** criterion under WCAG 2.1, not AA. Several icon buttons are smaller. Will be revisited if WCAG 2.2 AA is targeted.
- **Live screen-reader pass (NVDA/VoiceOver)** — automated axe covers structural and role correctness; a manual AT pass is out of scope for this sprint but recommended before GA.
- **`text-white/40` on icon-only interactive controls** — passes WCAG 1.4.11 (non-text contrast 3:1); kept at `/40` to preserve visual hierarchy. If the design bar is raised to AAA text contrast uniformly, bump to `/60`.

---

## Security invariant check

This checkpoint touches only frontend presentation layer — no new server paths, no new data stored or transmitted, no crypto changes. All six invariants from `AGENTS.md` are unaffected.

---

*Signed off: Dezoxy, 2026-06-11*
