import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { BottomNav, TAB_PATHS } from '../features/ui/BottomNav';
import { useSwipeTabs } from '../features/ui/useSwipeTabs';
import { NavVisibilityContext } from './NavVisibilityContext';

const TAB_ANIM_MS = 280;

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
  const navigatingRef = useRef(false);

  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 1024);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1023px)');
    const update = () => setIsMobile(mq.matches);
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  const animatedNavigateTo = useCallback(
    (to: string) => {
      if (navigatingRef.current) return;
      const targetIndex = getTabIndex(to);
      if (targetIndex === currentIndex) return;

      const container = contentRef.current;
      const inner = container?.firstElementChild as HTMLElement | null;

      if (inner && container) {
        navigatingRef.current = true;
        const exitClass =
          targetIndex > currentIndex ? 'argus-tab-exit-left' : 'argus-tab-exit-right';
        const clone = inner.cloneNode(true) as HTMLElement;
        // Strip any enter class that may be on the live node so the clone doesn't re-animate.
        clone.classList.remove('argus-tab-enter-left', 'argus-tab-enter-right');
        clone.classList.add(exitClass);
        clone.style.pointerEvents = 'none';
        container.appendChild(clone);
        navigate(to);
        setTimeout(() => {
          clone.remove();
          navigatingRef.current = false;
        }, TAB_ANIM_MS);
      } else {
        navigate(to);
      }
    },
    [currentIndex, navigate],
  );

  // Swipe right (finger moves right) → previous tab; swipe left → next tab.
  const onSwipePrev = useCallback(() => {
    const prev = Math.max(currentIndex - 1, 0);
    if (prev !== currentIndex) animatedNavigateTo(TAB_PATHS[prev]!);
  }, [currentIndex, animatedNavigateTo]);

  const onSwipeNext = useCallback(() => {
    const next = Math.min(currentIndex + 1, TAB_PATHS.length - 1);
    if (next !== currentIndex) animatedNavigateTo(TAB_PATHS[next]!);
  }, [currentIndex, animatedNavigateTo]);

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
      {navVisible && <BottomNav onNavigate={animatedNavigateTo} />}
    </div>
  );
}
