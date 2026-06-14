# Frontend Rebranding Roadmap

Status: draft  
Scope: `apps/web` React/Vite PWA  
Goal: make Argus feel like a distinct, modern, privacy-first product instead of a generic dark-purple messenger.

## 1. Decision

Invent a new product UI direction: **Argus Minimal Messenger OS**.

Argus should feel like a sparse, fast, command-driven encrypted messenger: calm, precise, modern, and intentionally quiet. The UI should make a new user immediately understand that this is private team messaging without turning the product into a heavy security dashboard.

The visual direction should move away from:

- purple-first gradients
- abstract glowing login art
- centered mobile-like desktop frames
- every surface being a rounded dark card
- security copy hidden in long text pages

The new direction should move toward:

- a desktop-native messenger shell with very low visual noise
- command/search as the primary navigation pattern
- clear information hierarchy for conversations, devices, security, and settings
- a neutral palette with a single strong accent and clear state colors
- tiny factual security states instead of large trust panels
- a design token layer that makes future rebrands cheap

## 2. Product Feel

Target feeling: **private, sharp, controlled, and trustworthy**.

Not the target:

- cyberpunk
- neon hacker
- consumer social messenger
- enterprise dashboard with no personality
- soft SaaS landing page

The UI should be attractive because it is composed, useful, and clear. New users should want more of it because it feels safer and more intentional than the tools they already use.

## 3. Brand Concept

### Core metaphor

**Sealed communication inside a secure workspace.**

Messaging is still the main action, but the brand should visually express:

- sealed messages
- verified people
- trusted devices
- clear delivery state
- encrypted local storage
- tenant/workspace boundaries

Security should appear as product evidence, not decoration.

### Signature UI idea

Add a persistent **Command Layer** as the signature interaction.

Examples:

- Global command bar: `Search or jump to conversation`
- Quick actions: `Open devices`, `Verify contact`, `Start conversation`
- Chat header: tiny factual state, e.g. `Verified` and `MLS`
- Conversation switcher: collapsible and keyboard-friendly
- Security/device surfaces: reachable from command, not always visible

This gives Argus a recognizable power-user pattern without making the UI busy.

## 4. Visual System

### Palette

Use a neutral, durable base with one primary accent and separate semantic colors.

Recommended starting palette:

| Role | Token | Value | Use |
|---|---:|---:|---|
| App background | `bg.app` | `#080B0F` | Main dark shell |
| Raised surface | `bg.surface` | `#11161D` | Panels, sidebars |
| Elevated surface | `bg.elevated` | `#18202A` | Menus, modals |
| Subtle surface | `bg.subtle` | `#0D1117` | Chat thread background |
| Border | `border.default` | `rgb(255 255 255 / 8%)` | Default separator |
| Strong border | `border.strong` | `rgb(255 255 255 / 14%)` | Active/important boundaries |
| Primary text | `text.primary` | `rgb(255 255 255 / 92%)` | Body and labels |
| Muted text | `text.muted` | `rgb(255 255 255 / 58%)` | Secondary text |
| Faint text | `text.faint` | `rgb(255 255 255 / 36%)` | Timestamps, disabled text |
| Brand accent | `accent.primary` | `#34D3C2` | Main action, selected state |
| Accent hover | `accent.hover` | `#5EEAD4` | Hover/focus |
| Accent soft | `accent.soft` | `rgb(52 211 194 / 14%)` | Badges, selected rows |
| Verified | `state.verified` | `#57D68D` | Verified/trusted |
| Warning | `state.warning` | `#F2B84B` | Caveats, pending states |
| Danger | `state.danger` | `#F0526B` | Destructive/error |
| Identity warm | `identity.warm` | `#D99A5B` | Avatar fallback variety |
| Identity blue | `identity.blue` | `#6EA8FE` | Avatar fallback variety |

Reasoning: teal gives a privacy/secure-system feel without inheriting the current purple identity. Warm and blue identity colors prevent the UI from becoming a one-hue theme.

### Light mode

Do not ship light mode in the first rebrand pass unless the implementation cost is low. But define tokens so it can exist later.

Reasoning: the product is security-heavy and current UI is dark-only. A rushed light mode will create contrast and trust-state bugs. Tokenize first, then add light mode when the component layer is ready.

### Typography

Use system fonts for now. Do not add a custom font dependency unless the identity work proves it is worth it.

Rules:

- keep UI text compact and readable
- avoid large marketing-style headings inside app surfaces
- use tabular numbers for codes, safety numbers, digests, timestamps
- use uppercase labels only for small metadata, not primary navigation

### Shape

Move from "rounded everything" to a tighter geometry:

- app shell: `16px`
- panels/cards: `10px` or `12px`
- buttons/inputs: `8px` or `10px`
- avatars: circle for people, rounded square for workspaces/groups
- modals: `16px` desktop, `20px` top sheet on mobile

Reasoning: the current `rounded-3xl` look makes the app feel like a mobile concept. Tighter radii feel more durable and enterprise-ready.

### Motion

Keep motion functional:

- message send: subtle local confirmation
- panel transitions: fast and directional
- trust-state changes: short state confirmation
- no looping glow effects
- no decorative background movement

All motion must respect `prefers-reduced-motion`.

## 5. UX Architecture

### Desktop shell

Replace the centered `90vh` app frame with a desktop-native Minimal Messenger OS shell:

- ultra-thin left rail: app mark plus 3-4 primary icons
- top command bar: `Search or jump to conversation`
- collapsible conversation switcher: visible when useful, hidden when focused
- main area: selected thread gets most of the space
- tiny inline security state: `Verified`, `MLS`

This makes Argus feel simpler and more distinctive than a standard chat app.

### Mobile shell

Keep the current mobile flow directionally:

- conversation list first
- thread opens as a full screen
- settings opens as a native-feeling sheet
- avoid crowding security state; use compact badges and drill-down panels

Mobile is already stronger than desktop, so the rebrand should refine it rather than rebuild it.

### Landing/sign-in

Replace the abstract carousel with a product-led sign-in surface:

- show a real mini preview of the app shell
- show passkey-first action clearly
- show 2-3 trust facts as compact proof badges
- keep terms/privacy links low priority but visible
- keep no password fields

Example first screen:

```text
ARGUS
Private team messaging, sealed end to end.

[Product preview: command bar + focused chat + verified state]

[Continue with passkey]

Crypto-blind server  |  MLS encryption  |  EU storage
```

### Transparency page

Turn the transparency route into a trust center:

- summary proof cards at the top
- build digest card
- cryptography model card
- data residency/sub-processors table
- PWA caveat as a clear warning card, not buried in paragraphs

This is a sales and trust asset, not just documentation.

## 6. Implementation Roadmap

### Phase 0 - Preserve the current baseline

Purpose: make sure the rebrand is not hiding regressions.

Tasks:

- keep current screenshots from desktop and mobile as visual baselines
- record the current important routes: `/`, `/chat`, `/settings`, `/security`, `/devices`, `/storage`, `/transparency`
- keep existing E2E role/name assertions unless labels intentionally change
- add or update visual smoke checks after the new shell lands

Done when:

- current behavior is documented
- no unrelated frontend behavior changes are mixed into the first rebrand PR

### Phase 1 - Build the design token foundation

Purpose: make the rebrand safe and maintainable.

Tasks:

- create one canonical token source for color, radius, spacing, shadow, and focus
- remove drift between `apps/web/src/index.css` and `apps/web/src/features/ui/theme.ts`
- replace direct `purple-*`, hard-coded hex, and repeated `white/*` opacity usage in shared components first
- add semantic component variants: `primary`, `secondary`, `quiet`, `danger`, `verified`, `warning`
- update focus rings to use semantic focus tokens, not purple

High-value files:

- `apps/web/src/index.css`
- `apps/web/src/features/ui/theme.ts`
- `apps/web/src/features/ui/Button.tsx`
- `apps/web/src/features/ui/IconButton.tsx`
- `apps/web/src/features/ui/SettingsRow.tsx`
- `apps/web/src/features/ui/StateBlock.tsx`
- `apps/web/src/features/ui/motion.ts`

Done when:

- shared UI components no longer encode the old purple brand
- changing the primary accent does not require editing feature screens
- WCAG contrast checks still pass

### Phase 2 - Redesign the app shell

Purpose: make desktop feel like a minimal command-driven messenger, not a phone mockup.

Tasks:

- replace the centered desktop chat frame with a full app shell
- add an ultra-thin global navigation rail for core product areas
- add the command/search layer
- add a collapsible conversation switcher
- keep chat fast and focused
- introduce tiny factual security badges in chat headers and security/device surfaces
- make route pages reuse the same shell instead of feeling separate

High-value files:

- `apps/web/src/features/chat/ChatScreen.tsx`
- `apps/web/src/features/chat/ConversationList.tsx`
- `apps/web/src/features/chat/ChatHeader.tsx`
- `apps/web/src/routes/RoutePageShell.tsx`
- `apps/web/src/features/settings/SettingsPanel.tsx`

Done when:

- desktop chat uses available width intentionally
- settings/devices/security/storage feel like product areas
- mobile remains at least as usable as it is today

### Phase 2a - Create the v2 folder boundary

Keep the redesign isolated under `apps/web/src/v2` until it is intentionally routed.

Recommended structure:

```text
apps/web/src/v2/
  README.md
  design/        # tokens, visual rules, motion rules
  shell/         # app rail, command bar, conversation switcher
  chat/          # v2 thread, composer, message row/bubble components
  routes/        # future route adapters and feature-flagged entry points
  mocks/         # static prototype data for screenshots and tests
```

Rules:

- v2 components should stay behind `/v2` sketch routes until a feature flag or promotion PR
- v2 can reuse stable libraries from `apps/web/src/lib`
- v2 should avoid importing v1 feature components except through explicit adapters
- use `/v2` and `/v2/*` as coded sketch routes before replacing `/chat`
- keep v2 E2E tests separate until the route is promoted

### Phase 3 - Redesign the landing and trust center

Purpose: give new users the new brand immediately.

Tasks:

- replace abstract login slides with product-led visuals
- make the first screen communicate passkey login plus privacy proof
- redesign `/transparency` as a trust center with proof cards
- update app icons only after the new visual language is stable

High-value files/assets:

- `apps/web/src/App.tsx`
- `apps/web/src/routes/TransparencyRoute.tsx`
- `apps/web/public/icon.svg`
- `apps/web/public/icon-*.png`
- `apps/web/public/images/login-slide-*.png`
- `apps/web/index.html` theme color

Done when:

- a first-time visitor can understand what Argus is in under 10 seconds
- the landing page no longer depends on abstract purple artwork
- transparency content is easier to scan and stronger as a trust artifact

### Phase 4 - Redesign feature surfaces

Purpose: make deeper product workflows match the new brand.

Tasks:

- settings sections: profile, security, privacy, notifications, appearance, storage, devices
- admin/team panels
- recovery panel
- start conversation and group create dialogs
- device link/approval panels
- attachment and image preview states

Done when:

- all feature surfaces use semantic tokens
- no old purple identity remains except in migration notes or screenshots
- dialogs and forms share consistent geometry and density

### Phase 5 - Polish and harden

Purpose: make the rebrand shippable.

Tasks:

- run responsive QA at mobile, tablet, and desktop widths
- run axe/WCAG checks
- update E2E tests for changed labels, roles, and route structure
- verify PWA icons, theme color, installability, and splash behavior
- review copy for security accuracy
- self-review the branch diff before PR

Done when:

- `pnpm --filter @argus/web typecheck`
- `pnpm --filter @argus/web test`
- `pnpm --filter @argus/web build`
- `pnpm --filter @argus/web test:e2e`
- root checks from `AGENTS.md` pass before merge

## 7. Acceptance Criteria

The rebrand is successful when:

- a new user sees a product that feels distinct from Signal/Slack/Discord clones
- the first screen communicates secure team messaging without overexplaining
- the desktop UI feels like a real workspace
- mobile remains fast and simple
- security state is visible but not noisy
- the transparency route feels credible enough to send to a buyer
- the design can be changed again by editing tokens and shared components first

## 8. Risks

### Risk: making security look decorative

Mitigation: every trust badge must map to a real product state or documented guarantee. Do not use fake "secure" badges.

### Risk: overbuilding a design system too early

Mitigation: tokenize only the primitives already used by the app: color, text, radius, spacing, shadow, focus, and component variants.

### Risk: breaking E2E tests through copy churn

Mitigation: update route and role assertions in the same PR as label changes. Grep `apps/web/e2e/` before renaming visible text.

### Risk: weakening accessibility

Mitigation: preserve existing focus management and ARIA structure while restyling. Run axe and manual keyboard checks before claiming done.

### Risk: losing the privacy story in visual polish

Mitigation: treat transparency, device trust, and verification as first-class UI, not secondary docs.

## 9. First PR Recommendation

Start with **Phase 1 only**.

Suggested PR title:

```text
Create frontend design tokens for Argus rebrand
```

Suggested scope:

- add canonical semantic tokens
- update shared UI primitives
- keep product screens visually close to current state
- no layout redesign yet

Reasoning: this pays down the hard-coded purple/dark styling first. After that, the new design can be rolled out screen by screen with smaller, safer diffs.
