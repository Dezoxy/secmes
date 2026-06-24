import { type RefObject, useEffect } from 'react';

const EDGE_ZONE = 28;
const MIN_TRAVEL = 80;

export function useSwipeTabs(
  ref: RefObject<HTMLElement | null>,
  onSwipePrev: () => void,
  onSwipeNext: () => void,
  enabled: boolean,
): void {
  useEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el) return;

    let startX = 0;
    let startY = 0;
    let armed = false;

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      // Reserve the left edge for useSwipeBack; don't compete with it.
      if (t.clientX < EDGE_ZONE) {
        armed = false;
        return;
      }
      startX = t.clientX;
      startY = t.clientY;
      armed = true;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!armed) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = Math.abs(t.clientX - startX);
      const dy = Math.abs(t.clientY - startY);
      // Abort when vertical scroll dominates to avoid fighting scrollable content.
      if (dy > dx) armed = false;
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!armed) return;
      armed = false;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      if (Math.abs(dx) < MIN_TRAVEL) return;
      // Rightward drag (dx > 0) = swipe-right gesture → go to previous tab.
      // Leftward drag (dx < 0) = swipe-left gesture → go to next tab.
      if (dx > 0) onSwipePrev();
      else onSwipeNext();
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [ref, onSwipePrev, onSwipeNext, enabled]);
}
