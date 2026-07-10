import { BottomNav } from '@argus/web';

// BottomNav is `position: absolute` against its own positioned ancestor (the app shell) — the
// preview supplies that ancestor plus enough height for the floating pill bar to sit at the bottom.
// The active-tab highlight comes from the ambient MemoryRouter every preview is wrapped in
// (cfg.provider.props.initialEntries: ["/chat"]) — react-router forbids a second, nested Router,
// so there's no per-story route override here.
export function Default() {
  return (
    <div style={{ position: 'relative', height: 140, width: 420 }}>
      <BottomNav onNavigate={() => {}} />
    </div>
  );
}
