import { useEffect, type RefObject } from 'react';

interface FloatingClearanceOptions {
  /** Extra breathing room above the control, in rem. */
  gapRem?: number;
  /**
   * Keep the last measured value when the control unmounts instead of clearing the var back to the
   * stylesheet fallback. Use only for fixed-height controls whose consumers outlive a transient
   * unmount (the nav, which hides in a conversation): reverting would briefly re-inflate the dead
   * band. Leave off for variable-height controls (the composer) — a stale tall value left behind
   * after the composer unmounts would itself become a dead band.
   */
  keepLastOnUnmount?: boolean;
}

/**
 * Keep a scroll-clearance CSS variable in sync with the *real* rendered height of a floating
 * bottom control (the nav pills or the chat composer).
 *
 * The clearance a scroller reserves at its bottom = the control's measured height + the floating
 * bottom offset + a small gap. Deriving it from a live measurement (instead of a hardcoded rem
 * guess) means content rests exactly above the control on every device safe-area inset and at
 * every in-app font-size level — no oversized dead band below the control, and nothing hidden
 * behind it. Falls back to the stylesheet default before the first measurement (and, unless
 * `keepLastOnUnmount`, on unmount).
 */
export function useFloatingClearance(
  ref: RefObject<HTMLElement | null>,
  cssVar: string,
  { gapRem = 0.75, keepLastOnUnmount = false }: FloatingClearanceOptions = {},
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
      if (!keepLastOnUnmount) {
        // Drop the measured value so a scroller that outlives this control reverts to the static
        // fallback rather than holding a now-wrong height (e.g. a grown composer that just unmounted).
        root.style.removeProperty(cssVar);
      }
    };
  }, [ref, cssVar, gapRem, keepLastOnUnmount]);
}
