// @vitest-environment jsdom
// jsdom: the dialog renders a live React tree with state, so it needs a DOM.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GroupCreateDialog } from './GroupCreateDialog';
import type { Friend } from '../../lib/api';
import type { GroupConversationManager } from '../../lib/conversations';
import type { MessagingDeps } from '../../lib/messaging';

// Mirrors MAX_GROUP_MEMBERS in GroupCreateDialog.tsx.
const MAX_GROUP_MEMBERS = 31;

// Module-level mock so the lookup test can keep the promise pending.
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, lookupUserByArgusId: vi.fn().mockResolvedValue(null) };
});

const NOW = new Date().toISOString();

const ALICE: Friend = {
  userId: 'a1a1a1a1-0000-4000-8000-000000000001',
  argusId: 'argus-alicealicealice-a1a',
  displayName: 'Alice',
  avatarSeed: null,
  since: NOW,
};

const BOB: Friend = {
  userId: 'b2b2b2b2-0000-4000-8000-000000000002',
  argusId: 'argus-bobbobbobbob-b2b',
  displayName: 'Bob',
  avatarSeed: null,
  since: NOW,
};

// Minimal mocks — dialog only calls manager/deps on Continue/Confirm, not during friend quick-add.
const mockManager = {} as unknown as GroupConversationManager;
const mockDeps = {} as unknown as MessagingDeps;

// React controlled-input setter — needed to trigger synthetic onChange in jsdom.
const nativeInputSetter = Object.getOwnPropertyDescriptor(
  window.HTMLInputElement.prototype,
  'value',
)?.set;

function setInputValue(input: HTMLInputElement, value: string) {
  nativeInputSetter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('GroupCreateDialog — friends suggestion', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    // vi.resetAllMocks() (in afterEach) wipes the mockResolvedValue set by vi.mock's factory —
    // re-establish the default here so tests that don't override it still get a resolved `null`.
    const { lookupUserByArgusId } = await import('../../lib/api');
    vi.mocked(lookupUserByArgusId).mockResolvedValue(null);

    // jsdom doesn't implement matchMedia; stub it so Modal.tsx doesn't throw.
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    // Unmount first so createPortal content (modal) is removed from document.body.
    act(() => {
      root.unmount();
    });
    container.remove();
    // resetAllMocks (not restoreAllMocks) so the vi.mock factory's fn() stays a mock — restoring
    // would strip its implementation entirely rather than reset it to the default above.
    vi.resetAllMocks();
  });

  function render(opts: {
    friends?: Friend[];
    selfUserId?: string;
    existingMemberIds?: Set<string>;
  }) {
    act(() => {
      root.render(
        createElement(GroupCreateDialog, {
          mode: 'create',
          manager: mockManager,
          deps: mockDeps,
          selfUserId: opts.selfUserId ?? 'self-0000-0000-0000-000000000000',
          friends: opts.friends,
          existingMemberIds: opts.existingMemberIds,
          onClose: () => undefined,
        }),
      );
    });
  }

  it('shows the "Your friends" section when friends are provided', () => {
    render({ friends: [ALICE] });
    expect(document.body.textContent).toContain('Your friends');
    expect(document.body.textContent).toContain('Alice');
  });

  it('hides the "Your friends" section when no friends are provided', () => {
    render({ friends: [] });
    expect(document.body.textContent).not.toContain('Your friends');
  });

  it('excludes friends who are already existing members', () => {
    render({ friends: [ALICE, BOB], existingMemberIds: new Set([ALICE.userId]) });
    expect(document.body.textContent).toContain('Bob');
    expect(document.body.textContent).not.toContain('Alice');
  });

  it('clicking Add shows inline confirmation for that friend', async () => {
    render({ friends: [ALICE] });

    const addBtn = document.body.querySelector('[aria-label="Add Alice"]') as HTMLButtonElement;
    expect(addBtn).not.toBeNull();
    expect(document.body.textContent).not.toContain('Add?');

    await act(async () => {
      addBtn.click();
    });

    expect(document.body.textContent).toContain('Add?');
    expect(document.body.querySelector('[aria-label="Confirm add Alice"]')).not.toBeNull();
    expect(document.body.querySelector('[aria-label="Cancel"]')).not.toBeNull();
  });

  it('confirming adds the friend to the selected list and removes them from suggestions', async () => {
    render({ friends: [ALICE] });

    await act(async () => {
      (document.body.querySelector('[aria-label="Add Alice"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (
        document.body.querySelector('[aria-label="Confirm add Alice"]') as HTMLButtonElement
      ).click();
    });

    expect(document.body.textContent).not.toContain('Add?');
    // Alice's argusId appears in the selected members list
    expect(document.body.textContent).toContain(ALICE.argusId);
    // Alice no longer appears as a suggestion
    expect(document.body.querySelector('[aria-label="Add Alice"]')).toBeNull();
  });

  it('cancelling the confirmation leaves suggestions unchanged', async () => {
    render({ friends: [ALICE] });

    await act(async () => {
      (document.body.querySelector('[aria-label="Add Alice"]') as HTMLButtonElement).click();
    });
    await act(async () => {
      (document.body.querySelector('[aria-label="Cancel"]') as HTMLButtonElement).click();
    });

    expect(document.body.textContent).not.toContain('Add?');
    // Alice still shows as a suggestion (not added)
    expect(document.body.querySelector('[aria-label="Add Alice"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain(ALICE.argusId);
  });

  it('shows a capacity error and does not add the friend once the group is full', () => {
    const manyFriends: Friend[] = Array.from({ length: MAX_GROUP_MEMBERS + 1 }, (_, i) => ({
      userId: `friend-${i}-0000-4000-8000-000000000000`,
      argusId: `argus-friend-${i}-000000-fill`,
      displayName: `Friend ${i}`,
      avatarSeed: null,
      since: NOW,
    }));

    render({ friends: manyFriends });

    // These click handlers are synchronous (no promises), so a plain (non-async) act() per
    // click is enough — avoids 62 needless microtask ticks across the fill loop.
    for (let i = 0; i < MAX_GROUP_MEMBERS; i++) {
      const label = `Friend ${i}`;
      act(() => {
        (document.body.querySelector(`[aria-label="Add ${label}"]`) as HTMLButtonElement).click();
      });
      act(() => {
        (
          document.body.querySelector(`[aria-label="Confirm add ${label}"]`) as HTMLButtonElement
        ).click();
      });
    }

    expect(document.body.textContent).toContain(`${MAX_GROUP_MEMBERS}/${MAX_GROUP_MEMBERS} added`);

    const lastLabel = `Friend ${MAX_GROUP_MEMBERS}`;
    act(() => {
      (document.body.querySelector(`[aria-label="Add ${lastLabel}"]`) as HTMLButtonElement).click();
    });
    act(() => {
      (
        document.body.querySelector(`[aria-label="Confirm add ${lastLabel}"]`) as HTMLButtonElement
      ).click();
    });

    expect(document.body.textContent).toContain(`Maximum ${MAX_GROUP_MEMBERS} members reached.`);
    expect(document.body.querySelector(`[aria-label="Add ${lastLabel}"]`)).not.toBeNull();
  }, 30000);

  it('friend buttons are disabled while an Argus-ID lookup is in progress', async () => {
    const { lookupUserByArgusId } = await import('../../lib/api');
    // Make the lookup hang indefinitely so `looking` stays true.
    vi.mocked(lookupUserByArgusId).mockReturnValue(new Promise(() => undefined));

    render({ friends: [ALICE] });

    const input = document.body.querySelector(
      '[placeholder="Add by argus-id…"]',
    ) as HTMLInputElement;
    await act(async () => {
      setInputValue(input, 'argus-test-id-xxxxxx-test');
    });

    // Click the search-row "Add" button to kick off the lookup.
    const searchAddBtn = [...document.body.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === null && b.textContent?.trim() === 'Add',
    ) as HTMLButtonElement;
    await act(async () => {
      searchAddBtn?.click();
    });

    const friendBtn = document.body.querySelector('[aria-label="Add Alice"]') as HTMLButtonElement;
    expect(friendBtn?.disabled).toBe(true);
  });
});
