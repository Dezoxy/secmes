import { useEffect } from 'react';

/**
 * Work around an iOS standalone-PWA compositor bug: after the app is backgrounded/resumed, or when
 * WebKit restores the installed PWA into an already-visible document, WebKit can keep a *stale*
 * composited snapshot of the safe-area strips. The DOM is correct — any real route repaint clears
 * it — so the fix is to force a one-frame recomposite of the app subtree on first foreground paint
 * and whenever the PWA returns to the foreground.
 *
 * We nudge `#root`'s opacity to a value imperceptibly below 1 (forcing a fresh raster + stacking
 * context) and restore it on the next frames. Opacity is used rather than `transform` so we don't
 * momentarily turn `#root` into a containing block for its `position: fixed` descendants.
 */
export function useResumeRepaint(): void {
  useEffect(() => {
    const root = document.getElementById('root');
    if (!root) return;

    let frame1 = 0;
    let frame2 = 0;

    const repaint = () => {
      // Drop any in-flight restore frames from a previous resume event so we don't leak handles
      // when pageshow + visibilitychange fire back-to-back on the same resume.
      window.cancelAnimationFrame(frame1);
      window.cancelAnimationFrame(frame2);
      root.style.opacity = '0.9999';
      // Force a synchronous reflow so the opacity change can't be coalesced away.
      void root.offsetHeight;
      frame1 = window.requestAnimationFrame(() => {
        frame2 = window.requestAnimationFrame(() => {
          root.style.opacity = '';
        });
      });
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') repaint();
    };
    // pageshow fires on bfcache restore and on some installed-PWA foreground restores that don't
    // flip visibility before React mounts. Repainting is visually imperceptible and avoids relying
    // on a route change (e.g. visiting Transparency) to refresh the safe-area raster.
    const onPageShow = () => repaint();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    if (document.visibilityState === 'visible') {
      frame1 = window.requestAnimationFrame(repaint);
    }

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.cancelAnimationFrame(frame1);
      window.cancelAnimationFrame(frame2);
      root.style.opacity = '';
    };
  }, []);
}
