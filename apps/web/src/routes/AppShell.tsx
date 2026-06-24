import { useLayoutEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { BottomNav, TAB_PATHS } from '../features/ui/BottomNav';

function getTabIndex(pathname: string): number {
  return TAB_PATHS.findIndex((p) => pathname === p || pathname.startsWith(p + '/'));
}

export default function AppShell() {
  const location = useLocation();
  const currentIndex = getTabIndex(location.pathname);

  const prevIndexRef = useRef<number>(currentIndex);
  const isFirstRef = useRef(true);

  // Compute direction synchronously during render, before updating the ref.
  let motionClass = '';
  if (!isFirstRef.current && currentIndex !== -1 && prevIndexRef.current !== -1) {
    if (currentIndex > prevIndexRef.current) motionClass = 'argus-tab-enter-right';
    else if (currentIndex < prevIndexRef.current) motionClass = 'argus-tab-enter-left';
  }

  useLayoutEffect(() => {
    isFirstRef.current = false;
    prevIndexRef.current = currentIndex;
  });

  return (
    <div className="flex h-[100dvh] flex-col bg-[#0f0f16] text-white">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div key={location.pathname} className={`absolute inset-0 ${motionClass}`}>
          <Outlet />
        </div>
      </div>
      <BottomNav />
    </div>
  );
}
