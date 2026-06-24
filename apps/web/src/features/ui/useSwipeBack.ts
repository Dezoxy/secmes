import { type RefObject, useEffect } from 'react';

const EDGE_ZONE = 28;
const MIN_TRAVEL = 60;

export function useSwipeBack(
  ref: RefObject<HTMLElement | null>,
  onBack: () => void,
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
      if (!t || t.clientX > EDGE_ZONE) {
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
      const dx = t.clientX - startX;
      const dy = Math.abs(t.clientY - startY);
      if (dy > Math.abs(dx)) {
        armed = false;
        return;
      }
      // Prevent the browser's own edge-swipe back-navigation from also firing
      // while we own this gesture. Non-passive so preventDefault() is allowed.
      e.preventDefault();
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!armed) return;
      armed = false;
      const t = e.changedTouches[0];
      if (!t) return;
      if (t.clientX - startX >= MIN_TRAVEL) onBack();
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    // Non-passive so we can call preventDefault() to suppress the browser's
    // native history-back gesture on the same left-edge swipe.
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
    };
  }, [ref, onBack, enabled]);
}
