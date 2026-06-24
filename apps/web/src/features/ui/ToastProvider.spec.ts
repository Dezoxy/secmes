// @vitest-environment jsdom
// jsdom (devDep): the provider renders a live React tree, so it needs a DOM.
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_DURATION_MS, EXIT_MS, ToastProvider } from './ToastProvider';
import { useToast } from './ToastContext';

function Trigger() {
  const { toast } = useToast();
  return createElement(
    'button',
    { onClick: () => toast('Hello toast', { variant: 'success' }) },
    'go',
  );
}

describe('ToastProvider', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('shows a toast on demand inside a live region, then auto-dismisses it', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(ToastProvider, null, createElement(Trigger)));
    });

    // The toast layer portals to <body> (so it stacks above body-level modals), so query the
    // live region + toast text from document.body, not the render container.
    const region = document.body.querySelector('[role="status"]');
    expect(region).not.toBeNull();
    expect(document.body.textContent).not.toContain('Hello toast');

    // Trigger a toast.
    const btn = container.querySelector('button')!;
    await act(async () => {
      btn.click();
    });
    expect(document.body.textContent).toContain('Hello toast');

    // Auto-dismiss: advance past the visible duration + the exit animation.
    await act(async () => {
      vi.advanceTimersByTime(DEFAULT_DURATION_MS + EXIT_MS + 10);
    });
    expect(document.body.textContent).not.toContain('Hello toast');

    await act(async () => root.unmount());
  });
});
