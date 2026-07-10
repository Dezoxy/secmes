## Wrapping and setup

Every screen in the real app is wrapped `<BrowserRouter><ToastProvider>…</ToastProvider></BrowserRouter>` (`apps/web/src/main.tsx`). `BottomNav` and the v2 `V2CommandBar`/command palette read router context (`useLocation`/`useNavigate`) and throw without it. `ToastProvider` supplies the `useToast()` hook that triggers the bottom-center toast — nothing else needs it directly, but mount it once near the root the same way.

**Every one of these components assumes a dark ambient page.** None of them paint their own full-bleed background — they render translucent fills, borders, and white text designed to sit on the app's shell (`apps/web/src/App.tsx`: `bg-[#1a1a24]` outer → `bg-[#12121a]` panel → `bg-[#0f0f16]` scroll area). Composing any of `StateBlock`/`EmptyState`/`ErrorState`/`LoadingState`/`ReconnectBanner`/`SettingsRow`/`IconButton` (ghost/subtle variants) directly on a white or unstyled page renders them illegible — wrap them in that dark shell first. `Button`, `Avatar`, `Modal`, and `ToastProvider`'s toast bubble are self-contained (opaque fills) and don't have this requirement.

```tsx
<div style={{ background: '#12121a', padding: 16, borderRadius: 12 }}>
  <EmptyState title="No conversations yet" icon={Users} compact>
    Start a secure conversation when another member is available.
  </EmptyState>
</div>
```

## Styling idiom: Tailwind v4 utility classes, two separate token systems

**Primitives** (`Avatar`, `BottomNav`, `Button`, `IconButton`, `Modal`, `SettingsRow`, the `StateBlock` family, `ToastProvider`) use plain Tailwind utility classes backed by a custom purple accent scale registered in `apps/web/src/index.css`'s `@theme` block:

| Class family | Use |
|---|---|
| `bg-purple-500`, `hover:bg-purple-400`, `shadow-purple-500/20` | primary actions, accent fills |
| `ring-purple-400/60` | focus rings (`focus-visible:ring-2 focus-visible:ring-purple-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#12121a]`) |
| `bg-white/[0.03]`, `border-white/10`, `text-white/60` | translucent surfaces/text on the dark shell (see above) |
| `bg-rose-500/[0.06]` / `text-rose-300` | error state |
| `bg-amber-500/[0.06]` / `text-amber-300` | offline/warning state |
| `rounded-xl` / `rounded-2xl` | the app's standard corner radii |

**V2 composites** (`V2Badge`, `V2CommandBar`, `V2AsidePanel`, `V2FactRow`) belong to a **separate, self-contained token system** — `apps/web/src/v2/design/tokens.ts` (`v2ClassNames`) — teal-accented (`text-teal-300`, `ring-teal-300/70`), with its own literal dark page background (`bg-[#0b0d10]`) and arbitrary-value classes rather than the purple `@theme` scale. **Do not mix the two systems in one composition** — this is an exploratory "Minimal Messenger OS" direction, distinct from the shipped purple primitives, not a shared design language.

## Where the truth lives

- `styles.css` (root) — the full compiled stylesheet; `@import`s `_ds_bundle.css` plus the app's real token definitions (`:root`/`@theme` custom properties). Read it before styling anything new.
- Each component's `.prompt.md` — synthesized from its real prop types; the authoritative API contract.
- `apps/web/src/features/ui/` and `apps/web/src/v2/shell/V2Shell.tsx` in the source repo are the components' real implementations, if deeper behavior questions come up.

## Build snippet

A realistic composition, in the app's own idiom — real copy, the dark shell, the purple accent:

```tsx
import { Avatar, Button, SettingsRow } from '@argus/web';

<div style={{ background: '#12121a', padding: 16, borderRadius: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
    <Avatar name="Priya Sharma" size="md" />
    <div>
      <p style={{ color: 'white', fontSize: 14, fontWeight: 500 }}>Priya Sharma</p>
      <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>Online</p>
    </div>
  </div>
  <SettingsRow title="Read receipts" value="On" enabled onClick={() => {}} />
  <Button variant="primary">Send message</Button>
</div>
```
