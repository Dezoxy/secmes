# /design-sync notes for argus (secmes)

## Repo shape (why config looks the way it does)

- `@argus/web` (`apps/web/`) is a **private Vite app**, not a published component-library
  package — there is no `dist/` entry with a `.d.ts` tree to bundle. The converter runs in
  **synth-entry mode** via an explicit `--entry`/`cfg.entry` pointing at
  `.design-sync/synth/entry.tsx`, a hand-curated barrel that re-exports exactly the 16 scoped
  components (real re-exports, no reimplementation — see the file's own header comment).
  - We deliberately did NOT let the converter fall back to its built-in "no dist → synthesize from
    every `src/` file" behavior: that walks the *entire* `apps/web/src` tree and does
    `export * from` on every non-test `.tsx`/`.jsx` file (routes, service-worker glue, the whole
    app) into one bundle — way outside scope, and risky (name collisions, side effects).
  - `.design-sync/synth/package.json` is a tiny stub (`{"name":"@argus/web","version":"0.0.0"}`)
    that exists *only* so the converter's `--entry` package.json walk-up lands on the right
    package identity (PKG_DIR). It has no dependencies and is never installed/run — it just gives
    `.design-sync/synth/entry.tsx` a named parent so `PKG_DIR` resolves to `.design-sync/synth/`
    rather than the repo root (`argus`).
  - `componentSrcMap` paths are therefore relative to `.design-sync/synth/`, i.e.
    `../../apps/web/src/...`.

## Component scope

- **Primitives**: everything exported from `apps/web/src/features/ui/index.ts` except
  `TAB_PATHS`, `useToast`, the `motion.ts` exports, the `theme.ts` token/accent exports, and
  `applyThemeToDocument` — none of those are components (pruned via `componentSrcMap: null`
  is unnecessary here since synth-entry component discovery is driven entirely by
  `componentSrcMap`'s explicit keys, not by scanning the barrel — see below).
- **v2 composites**: `V2Badge`, `V2CommandBar`, `V2AsidePanel`, `V2FactRow` — all four live in the
  single file `apps/web/src/v2/shell/V2Shell.tsx` (there is no separate file per component). The
  full-page `V2*Sketch` compositions (`V2ChatSketch`, `V2LandingSketch`, etc.) are explicitly OUT
  of scope — they're screen compositions, not reusable primitives.
- Because our `entry.tsx` only exports the 16 scoped names, and `componentSrcMap` only lists those
  16 keys, there is no over-inclusion risk from barrel/src scanning — the component list is
  exactly what we pinned. (The `Excluded non-components` pruning described in the original plan
  turned out to be unnecessary in practice: synth-entry's discovery adds names FROM
  `componentSrcMap` rather than scanning the barrel and needing exclusions.)

## Styling pipeline

- `features/ui/*` primitives use **literal Tailwind v4 utility classes** (`bg-purple-500`,
  `ring-purple-400/60`, ...) — none of them reference `var(--color-*)` directly. Tailwind's own
  `@theme` block in `apps/web/src/index.css` is what turns those into real CSS backed by
  `:root{--color-purple-*: ...}` custom properties. **The DS ships the DEFAULT purple accent
  statically** — `applyThemeToDocument()` (the runtime accent-switcher) is NOT part of the sync;
  previews always render the default purple theme.
- The four `v2/shell` atoms use a **separate, self-contained token system**
  (`apps/web/src/v2/design/tokens.ts` → `v2ClassNames`), teal-accented, entirely literal Tailwind
  utility strings (including arbitrary-value classes like `bg-[#0b0d10]`) — no CSS custom
  properties at all. Simpler to style than the main primitives, but needs its own `@source` scan
  target since the classes are stored as string constants in a `.ts` file, not inline JSX
  `className` props.
- `cfg.cssEntry` = `.design-sync/synth/styles.compiled.css`, a **static Tailwind v4 CLI build**
  (`@tailwindcss/cli`, isolated in `.ds-sync/node_modules`, NOT the repo's Vite pipeline) run over
  a wrapper (`.design-sync/synth/tailwind-entry.css`) that `@import`s the real `index.css` (so the
  `@theme`/`:root` token definitions travel) and adds explicit `@source` directives for
  `features/ui/`, `v2/shell/V2Shell.tsx`, and `v2/design/tokens.ts`.

## Provider chain

- `BottomNav` (react-router `Link`/`useLocation`) and `V2CommandBar` (`useNavigate`) need router
  context. `cfg.provider` wraps every preview in `MemoryRouter` → `ToastProvider`.
- `MemoryRouter` is not one of our own DS components, so it's exposed via
  `cfg.extraEntries: ["react-router-dom"]` (merges react-router-dom's exports onto
  `window.ArgusDS` so the provider gate can find it as a bundle export).
- `cfg.provider.props.initialEntries: ["/chat"]` — so `BottomNav`'s active-tab highlight shows
  something (the default `["/"]` matches no tab). **react-router v7 throws if a preview nests a
  second `MemoryRouter`** ("cannot render a `<Router>` inside another `<Router>`") — don't try to
  give an individual story its own route; the ambient provider's route is shared by every card.
- `useToast` (for the `ToastProvider` preview) isn't a component either, so it's exposed via
  `cfg.extraEntries: ["../../apps/web/src/features/ui/ToastContext.tsx"]` — a repo-relative path
  entry, which `package-build.mjs` bundles into the SAME module graph as the main entry (unlike a
  plain relative import from inside the preview `.tsx`, which would create a second `ToastContext`
  instance and break `useToast()`'s "must be used inside a ToastProvider" check via context
  identity mismatch). Toasts only appear via the imperative `toast()` call, so the preview triggers
  one on mount with a `useEffect` — there's no static "open" prop.

## The dark-shell finding (read this before authoring/reviewing any new preview)

**9 of the 16 first-wave components needed an explicit dark background wrapper in their preview
`.tsx`, or the absolute-grading capture (`package-capture.mjs`'s per-cell screenshots, distinct
from the full render-check) showed them as blank/illegible.** Root cause: `StateBlock` (and its
family — `EmptyState`/`ErrorState`/`LoadingState`/`ReconnectBanner`), `IconButton`,
`SettingsRow`, and the v2 `V2AsidePanel`/`V2Badge`/`V2FactRow` all use translucent
fills/borders and white/near-white text, designed to sit on the app's dark shell
(`bg-[#12121a]` for primitives, `bg-[#0b0d10]` for v2) — they never paint their own opaque
background. The full render-check (`<Name>.html`, contact sheets) happened to look fine because
that page loads `styles.css`'s `body{background:...}` rule; **the isolated per-cell grading
capture does not carry that ambient page background**, so the same content rendered on white was
white-text-on-white.

Fix applied: every affected preview wraps its story content in
`{ background: '#12121a', padding: 16, borderRadius: 12 }` (or `#0b0d10` for v2). This is not a
workaround for the grading tool — it's the true ambient context these components are ALWAYS
composed in (`App.tsx`'s panel bg), so it's correct in both capture contexts. **Any newly-authored
preview for one of these 9 components (or a similar translucent-on-dark component) needs the same
wrapper, or the grading capture will misread it as broken.** `Button`, `Avatar`, `Modal`,
`ToastProvider`'s toast bubble, `BottomNav`'s nav pill, and `V2CommandBar` are self-contained
(opaque fills) and don't need it.

## Fresh-clone / environment setup

- `.design-sync/synth/node_modules` is a **symlink to `apps/web/node_modules`** (gitignored,
  recreate after a fresh clone): `ln -sfn ../../apps/web/node_modules .design-sync/synth/node_modules`.
  Without it, `ts-morph`'s `.d.ts` prop extraction can't find `@types/react` from
  `.design-sync/synth/` (a directory outside any real `node_modules` tree), and every component
  with inherited React props (`ButtonHTMLAttributes`, etc.) emits an empty `.d.ts` body
  (`[DTS_REACT]`).
- `@tailwindcss/cli` (matching the app's `tailwindcss@^4.3.2`) is installed into `.ds-sync/`
  (isolated converter deps, gitignored) — NOT a repo dependency. Recompile the static stylesheet
  after any change to `apps/web/src/index.css`'s `@theme` block or the scoped components' Tailwind
  classes:
  `./.ds-sync/node_modules/.bin/tailwindcss -i .design-sync/synth/tailwind-entry.css -o .design-sync/synth/styles.compiled.css`
  — `.design-sync/synth/styles.compiled.css` itself is gitignored (build artifact); re-run this
  before `package-build.mjs` on any re-sync.
- Playwright's chromium cache lives at `~/Library/Caches/ms-playwright/` on macOS, NOT the
  Linux-default `~/.cache/ms-playwright/` — `playwright install chromium` may report nothing to do
  even on a machine that looks like it has no cache at the path you'd expect; check with
  `DEBUG=pw:install` if `ls ~/.cache/ms-playwright` comes up empty.

## Re-sync risks (read this before re-running)

- The v2 sketchbook is explicitly a **design-direction exploration**, not the shipped UI — if the
  product pivots away from it, the four v2 atoms may need re-scoping or removal from
  `componentSrcMap`/`entry.tsx`.
- `styles.compiled.css` is a **build artifact of a hand-run Tailwind CLI pass**, not wired into any
  npm script — if `apps/web/src/index.css`'s `@theme` block changes (new tokens, renamed accent
  scale), `styles.compiled.css` goes stale silently until the next `/design-sync` re-sync
  regenerates it. There is no CI check tying the two together.
- `applyThemeToDocument()` / the runtime accent system is entirely unmodeled in the DS — every
  design built from this sync assumes the default purple accent. If argus ships more accent
  options as first-class brand identity, that's a future sync enhancement (e.g. multiple preview
  variants per component), not something the current sync captures.
- `.design-sync/synth/entry.tsx` and `componentSrcMap` are the single source of truth for which
  16 components are in scope — adding a new `features/ui` component means updating BOTH files.
