import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { BottomNav, TAB_PATHS } from '../features/ui/BottomNav';
import { useSwipeTabs } from '../features/ui/useSwipeTabs';
import { NavVisibilityContext } from './NavVisibilityContext';

function getTabIndex(pathname: string): number {
  return TAB_PATHS.findIndex((p) => pathname === p || pathname.startsWith(p + '/'));
}

export default function AppShell() {
  const location = useLocation();
  const navigate = useNavigate();
  const currentIndex = getTabIndex(location.pathname);

  const prevIndexRef = useRef<number>(currentIndex);
  const isFirstRef = useRef(true);
  const contentRef = useRef<HTMLDivElement>(null);

  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 1024);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)');
    const update = () => setIsMobile(mq.matches);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  // Swipe right (finger moves right) → previous tab; swipe left → next tab.
  const onSwipePrev = useCallback(() => {
    const prev = Math.max(currentIndex - 1, 0);
    if (prev !== currentIndex) navigate(TAB_PATHS[prev]!);
  }, [currentIndex, navigate]);

  const onSwipeNext = useCallback(() => {
    const next = Math.min(currentIndex + 1, TAB_PATHS.length - 1);
    if (next !== currentIndex) navigate(TAB_PATHS[next]!);
  }, [currentIndex, navigate]);

  useSwipeTabs(contentRef, onSwipePrev, onSwipeNext, isMobile);

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

  const [navVisible, setNavVisible] = useState(true);

  return (
    <div className="flex h-[100dvh] flex-col bg-[#0f0f16] text-white">
      <div ref={contentRef} className="relative min-h-0 flex-1 overflow-hidden">
        <div key={location.pathname} className={`absolute inset-0 ${motionClass}`}>
          <NavVisibilityContext.Provider value={setNavVisible}>
            <Outlet />
          </NavVisibilityContext.Provider>
        </div>
      </div>
      {navVisible && <BottomNav />}
    </div>
  );
}
