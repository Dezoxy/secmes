// Curated synth-entry for /design-sync (claude.ai/design). @argus/web is a private app, not a
// published component-library `dist/` — the converter needs an explicit entry naming exactly the
// components we want in the design system, or its built-in fallback would `export *` from every
// .tsx file in the app (routes, service-worker glue, etc.). This file is that curated list, real
// re-exports of the app's actual components — no reimplementation. See .design-sync/NOTES.md.
export { Avatar } from '../../apps/web/src/features/ui/Avatar';
export { BottomNav } from '../../apps/web/src/features/ui/BottomNav';
export { Button } from '../../apps/web/src/features/ui/Button';
export { IconButton } from '../../apps/web/src/features/ui/IconButton';
export { Modal } from '../../apps/web/src/features/ui/Modal';
export { SettingsRow } from '../../apps/web/src/features/ui/SettingsRow';
export {
  EmptyState,
  ErrorState,
  LoadingState,
  ReconnectBanner,
  StateBlock,
} from '../../apps/web/src/features/ui/StateBlock';
export { ToastProvider } from '../../apps/web/src/features/ui/ToastProvider';

// Selected v2 "Minimal Messenger OS" composites — the reusable atoms in the sketchbook, not the
// full-page V2*Sketch compositions.
export {
  V2Badge,
  V2CommandBar,
  V2AsidePanel,
  V2FactRow,
} from '../../apps/web/src/v2/shell/V2Shell';
