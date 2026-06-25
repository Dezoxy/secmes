import { useCallback, useEffect, useRef } from 'react';

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
 * bottom control (the nav pills or the chat composer), and return a callback ref to attach to it.
 *
 * The clearance a scroller reserves at its bottom = the control's measured height + the floating
 * bottom offset + a small gap. Deriving it from a live measurement (instead of a hardcoded rem
 * guess) means content rests exactly above the control on every device safe-area inset and at
 * every in-app font-size level — no oversized dead band below the control, and nothing hidden
 * behind it. The `env(safe-area-inset-bottom)` part lives inside the CSS `calc()`, so the browser
 * already recomputes the offset on orientation/inset changes; we only need to track the element's
 * own height, which a ResizeObserver covers.
 *
 * A callback ref (rather than a passed-in RefObject) is used so the observer always tracks the
 * node the control currently renders: if the control swaps its element (e.g. the composer flips
 * between its disabled banner and the live input), React re-invokes the ref and we re-observe the
 * new node instead of leaving the observer on a detached one.
 */
export function useFloatingClearance(
  cssVar: string,
  { gapRem = 0.75, keepLastOnUnmount = false }: FloatingClearanceOptions = {},
): (node: HTMLElement | null) => void {
  const observerRef = useRef<ResizeObserver | null>(null);

  const setNode = useCallback(
    (node: HTMLElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;

      const root = document.documentElement;
      if (!node) {
        if (!keepLastOnUnmount) root.style.removeProperty(cssVar);
        return;
      }
      if (typeof ResizeObserver === 'undefined') return;

      const apply = () => {
        root.style.setProperty(
          cssVar,
          `calc(${node.offsetHeight}px + var(--argus-floating-mobile-bottom) + ${gapRem}rem)`,
        );
      };
      apply();
      const observer = new ResizeObserver(apply);
      observer.observe(node);
      observerRef.current = observer;
    },
    [cssVar, gapRem, keepLastOnUnmount],
  );

  // Defensive: tear the observer down on unmount even if the ref-detach path didn't run.
  useEffect(() => () => observerRef.current?.disconnect(), []);

  return setNode;
}
