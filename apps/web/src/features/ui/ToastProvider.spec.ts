// @vitest-environment jsdom
// jsdom (devDep): the provider renders a live React tree, so it needs a DOM.
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToastProvider } from './ToastProvider';
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

    // The aria-live region is always present; no toast text yet.
    const region = container.querySelector('[role="status"]');
    expect(region).not.toBeNull();
    expect(container.textContent).not.toContain('Hello toast');

    // Trigger a toast.
    const btn = container.querySelector('button')!;
    await act(async () => {
      btn.click();
    });
    expect(container.textContent).toContain('Hello toast');

    // Auto-dismiss: advance past the visible duration + the exit animation.
    await act(async () => {
      vi.advanceTimersByTime(2500 + 200 + 10);
    });
    expect(container.textContent).not.toContain('Hello toast');

    await act(async () => root.unmount());
  });
});
