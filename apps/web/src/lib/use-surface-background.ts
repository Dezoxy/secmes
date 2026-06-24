import { useEffect } from 'react';

/**
 * Sets the document canvas background (html + body) to a surface colour while the calling
 * component is mounted, restoring the previous value on unmount.
 *
 * Why: in an installed iOS PWA the home-indicator strip at the very bottom sits BELOW the
 * layout viewport, so a `position: fixed` / `100dvh` full-screen surface can't paint it — that
 * strip shows the document canvas (the html/body background) instead. With a single app-bg that
 * strip is a different shade from each screen's darker content (the "bottom hole"). Matching the
 * canvas to the on-screen surface makes the strip blend in, edge to edge.
 */
export function useSurfaceBackground(color: string): void {
  useEffect(() => {
    const html = document.documentElement;
    const { body } = document;
    const prevHtml = html.style.backgroundColor;
    const prevBody = body.style.backgroundColor;
    html.style.backgroundColor = color;
    body.style.backgroundColor = color;
    return () => {
      html.style.backgroundColor = prevHtml;
      body.style.backgroundColor = prevBody;
    };
  }, [color]);
}
