import { useEffect } from 'react';

/**
 * Work around an iOS standalone-PWA compositor bug: after the app is backgrounded and resumed,
 * WebKit can restore a *stale* composited snapshot of the top safe-area, leaving a 1px silver
 * seam under the status bar. The DOM is correct — any re-render (e.g. navigating away and back)
 * clears it — so the fix is simply to force a one-frame recomposite of the app subtree when the
 * PWA returns to the foreground.
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
    // pageshow fires on bfcache restore (a common iOS resume path that doesn't flip visibility).
    const onPageShow = () => repaint();

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.cancelAnimationFrame(frame1);
      window.cancelAnimationFrame(frame2);
      root.style.opacity = '';
    };
  }, []);
}
