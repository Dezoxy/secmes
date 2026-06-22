// @vitest-environment jsdom
// jsdom (devDep): the editor is an interactive React form, so it needs a DOM to render into.
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { hooks, mockToast } = vi.hoisted(() => ({
  hooks: {
    profile: null as null | Record<string, unknown>,
    refreshProfile: vi.fn().mockResolvedValue(undefined),
  },
  mockToast: vi.fn(),
}));

vi.mock('../../lib/api', () => ({ updateProfile: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ profile: hooks.profile, refreshProfile: hooks.refreshProfile }),
}));
vi.mock('../ui', () => ({ useToast: () => ({ toast: mockToast }) }));

import { DisplayNameEditor } from './DisplayNameEditor';

const BOUND = {
  displayName: 'Ada',
  isBreakglass: false,
  argusId: 'argus-aaaaaaaaaaaaaaaa-ada',
  userId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  role: 'member',
};

function mount() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

afterEach(() => {
  hooks.profile = null;
  mockToast.mockClear();
});

describe('DisplayNameEditor', () => {
  it('renders an editable display-name input prefilled with the current name + a Save button', async () => {
    hooks.profile = { ...BOUND };
    const { container, root } = mount();
    await act(async () => {
      root.render(createElement(DisplayNameEditor));
    });

    const input = container.querySelector<HTMLInputElement>('#display-name');
    expect(input).not.toBeNull();
    expect(input!.readOnly).toBe(false);
    expect(input!.value).toBe('Ada');
    const save = Array.from(container.querySelectorAll('button')).some((b) =>
      b.textContent?.includes('Save'),
    );
    expect(save).toBe(true);

    await act(async () => root.unmount());
  });

  it('toasts the character policy (error) and marks the field invalid when saving an invalid name', async () => {
    hooks.profile = { ...BOUND };
    const { container, root } = mount();
    await act(async () => {
      root.render(createElement(DisplayNameEditor));
    });

    const input = container.querySelector<HTMLInputElement>('#display-name')!;
    // React tracks the value internally — set via the native setter, then fire `input` to trigger onChange.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, '!!!');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    expect(mockToast).toHaveBeenCalledTimes(1);
    expect(mockToast.mock.calls[0]?.[1]).toMatchObject({ variant: 'error' });
    // The field stays flagged after the (self-dismissing) toast.
    expect(input.getAttribute('aria-invalid')).toBe('true');

    await act(async () => root.unmount());
  });

  it('renders nothing for a breakglass profile (display name is immutable)', async () => {
    hooks.profile = { ...BOUND, isBreakglass: true };
    const { container, root } = mount();
    await act(async () => {
      root.render(createElement(DisplayNameEditor));
    });

    expect(container.querySelector('#display-name')).toBeNull();

    await act(async () => root.unmount());
  });
});
