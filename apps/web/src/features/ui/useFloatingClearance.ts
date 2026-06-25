import { useEffect, type RefObject } from 'react';

/**
 * Keep a scroll-clearance CSS variable in sync with the *real* rendered height of a floating
 * bottom control (the nav pills or the chat composer).
 *
 * The clearance a scroller reserves at its bottom = the control's measured height + the floating
 * bottom offset + a small gap. Deriving it from a live measurement (instead of a hardcoded rem
 * guess) means content rests exactly above the control on every device safe-area inset and at
 * every in-app font-size level — no oversized dead band below the control, and nothing hidden
 * behind it. Falls back to the stylesheet default before the first measurement and on unmount.
 */
export function useFloatingClearance(
  ref: RefObject<HTMLElement | null>,
  cssVar: string,
  gapRem = 0.75,
): void {
  useEffect(() => {
    const initial = ref.current;
    if (!initial || typeof ResizeObserver === 'undefined') return;

    const root = document.documentElement;
    // Read ref.current live (not a captured element) so the value stays correct even if the
    // observed control's DOM node is swapped out from under us.
    const apply = () => {
      const el = ref.current;
      if (!el) return;
      root.style.setProperty(
        cssVar,
        `calc(${el.offsetHeight}px + var(--argus-floating-mobile-bottom) + ${gapRem}rem)`,
      );
    };

    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(initial);
    window.addEventListener('resize', apply);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', apply);
      // Intentionally keep the last measured value rather than removing it: if the control unmounts
      // (e.g. the nav hides for a conversation) while a scroller still consumes this var, reverting
      // to the static rem fallback could re-inflate the dead band. The control re-measures on remount.
    };
  }, [ref, cssVar, gapRem]);
}
