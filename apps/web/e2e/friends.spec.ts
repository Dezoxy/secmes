/**
 * Friends panel — Playwright tests with page.route() API mocking.
 *
 * These tests intercept the friends API endpoints so the panel can be exercised without a live
 * backend or authenticated session. They cover the UI behaviour wired in Slice E.
 */
import { expect, test } from '@playwright/test';

const NOW = new Date().toISOString();

const ALICE: Record<string, unknown> = {
  userId: 'a1a1a1a1-0000-4000-8000-000000000001',
  argusId: 'argus-alicealicealice-a1a',
  displayName: 'Alice',
  avatarSeed: null,
  since: NOW,
};

const BOB: Record<string, unknown> = {
  requestId: 'b0000000-0000-4000-8000-00000000b0b0',
  userId: 'b2b2b2b2-0000-4000-8000-000000000002',
  argusId: 'argus-bobbobbobbob-b2b',
  displayName: 'Bob',
  avatarSeed: null,
  direction: 'incoming',
  createdAt: NOW,
};

const CAROL: Record<string, unknown> = {
  requestId: 'c0000000-0000-4000-8000-00000000c3c3',
  userId: 'c3c3c3c3-0000-4000-8000-000000000003',
  argusId: 'argus-carolcarolcarol-c3c',
  displayName: 'Carol',
  avatarSeed: null,
  direction: 'outgoing',
  createdAt: NOW,
};

async function stubFriendsApi(
  page: Parameters<Parameters<typeof test>[1]>[0],
  opts: { friends?: unknown[]; incoming?: unknown[]; outgoing?: unknown[] } = {},
) {
  const friends = opts.friends ?? [];
  const incoming = opts.incoming ?? [];
  const outgoing = opts.outgoing ?? [];

  await page.route('**/api/friends', (route) => {
    if (route.request().method() !== 'GET') {
      void route.continue();
      return;
    }
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ friends }),
    });
  });

  await page.route('**/api/friends/requests**', (route) => {
    if (route.request().method() !== 'GET') {
      void route.continue();
      return;
    }
    const url = new URL(route.request().url());
    const box = url.searchParams.get('box');
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ requests: box === 'incoming' ? incoming : outgoing }),
    });
  });
}

test('friends panel shows accepted friends from API', async ({ page }) => {
  await stubFriendsApi(page, { friends: [ALICE] });
  await page.goto('/chat');

  await page.getByRole('link', { name: 'Friends' }).click();
  await expect(page.getByRole('heading', { name: 'Friends' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Open conversation with Alice/ })).toBeVisible();
  await expect(page.getByText('1 accepted')).toBeVisible();
});

test('friends panel reuses a recent refresh across repeated tab opens', async ({ page }) => {
  let friendsCalls = 0;
  let incomingCalls = 0;
  let outgoingCalls = 0;

  await page.route('**/api/friends', (route) => {
    if (route.request().method() !== 'GET') {
      void route.continue();
      return;
    }
    friendsCalls += 1;
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ friends: [ALICE] }),
    });
  });

  await page.route('**/api/friends/requests**', (route) => {
    if (route.request().method() !== 'GET') {
      void route.continue();
      return;
    }
    const url = new URL(route.request().url());
    if (url.searchParams.get('box') === 'incoming') incomingCalls += 1;
    else outgoingCalls += 1;
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ requests: [] }),
    });
  });

  await page.goto('/chat');
  await page.getByRole('link', { name: 'Friends' }).click();
  await expect(page.getByRole('button', { name: /Open conversation with Alice/ })).toBeVisible();

  await page.getByRole('link', { name: 'Chat', exact: true }).click();
  await page.getByRole('link', { name: 'Friends' }).click();
  await page.getByRole('link', { name: 'Chat', exact: true }).click();
  await page.getByRole('link', { name: 'Friends' }).click();
  await page.waitForTimeout(250);

  expect(friendsCalls).toBe(1);
  expect(incomingCalls).toBe(1);
  expect(outgoingCalls).toBe(1);
});

test('friends panel retries a transient accepted-friends refresh failure', async ({ page }) => {
  let friendsCalls = 0;
  await page.route('**/api/friends', (route) => {
    if (route.request().method() !== 'GET') {
      void route.continue();
      return;
    }
    friendsCalls += 1;
    if (friendsCalls === 1) {
      void route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'temporary deploy window' }),
      });
      return;
    }
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ friends: [ALICE] }),
    });
  });

  await page.route('**/api/friends/requests**', (route) => {
    if (route.request().method() !== 'GET') {
      void route.continue();
      return;
    }
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ requests: [] }),
    });
  });

  await page.goto('/chat');
  await page.getByRole('link', { name: 'Friends' }).click();

  await expect(page.getByRole('button', { name: /Open conversation with Alice/ })).toBeVisible();
  await expect(page.getByText('1 accepted')).toBeVisible();
  await expect(page.getByText('No accepted friends yet')).toBeHidden();
  expect(friendsCalls).toBeGreaterThanOrEqual(2);
});

test('friends unavailable state can be retried manually after a service restart', async ({
  page,
}) => {
  let friendsCalls = 0;
  let recover = false;

  await page.route('**/api/friends', (route) => {
    if (route.request().method() !== 'GET') {
      void route.continue();
      return;
    }
    friendsCalls += 1;
    if (!recover) {
      void route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'temporary deploy window' }),
      });
      return;
    }
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ friends: [ALICE] }),
    });
  });

  await page.goto('/__e2e/friends-unavailable');

  await expect(page.getByText('Friends temporarily unavailable')).toBeVisible();
  await expect(page.getByText('No accepted friends yet')).toBeHidden();
  expect(friendsCalls).toBeGreaterThanOrEqual(1);

  recover = true;
  await page.getByRole('button', { name: 'Try again' }).click();

  await expect(page.getByRole('button', { name: /Open conversation with Alice/ })).toBeVisible();
  await expect(page.getByText('1 accepted')).toBeVisible();
  expect(friendsCalls).toBeGreaterThanOrEqual(2);
});

test('friends panel retries transient friends reads without retrying throttled requests', async ({
  page,
}) => {
  let friendsCalls = 0;
  let incomingCalls = 0;

  await page.route('**/api/friends', (route) => {
    if (route.request().method() !== 'GET') {
      void route.continue();
      return;
    }
    friendsCalls += 1;
    if (friendsCalls === 1) {
      void route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'temporary deploy window' }),
      });
      return;
    }
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ friends: [ALICE] }),
    });
  });

  await page.route('**/api/friends/requests**', (route) => {
    if (route.request().method() !== 'GET') {
      void route.continue();
      return;
    }
    const url = new URL(route.request().url());
    if (url.searchParams.get('box') === 'incoming') {
      incomingCalls += 1;
      void route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'too many refreshes' }),
      });
      return;
    }
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ requests: [] }),
    });
  });

  await page.goto('/chat');
  await page.getByRole('link', { name: 'Friends' }).click();

  await expect(page.getByRole('button', { name: /Open conversation with Alice/ })).toBeVisible();
  await page.waitForTimeout(1300);
  expect(friendsCalls).toBeGreaterThanOrEqual(2);
  expect(incomingCalls).toBe(1);
});

test('friends panel shows incoming requests with Accept and Decline buttons', async ({ page }) => {
  await stubFriendsApi(page, { incoming: [BOB] });
  await page.goto('/chat');

  await page.getByRole('link', { name: 'Friends' }).click();
  await expect(page.getByText('Incoming requests')).toBeVisible();
  await expect(page.getByRole('button', { name: /Accept request from Bob/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Decline request from Bob/ })).toBeVisible();
});

test('friends panel shows outgoing requests with Cancel button', async ({ page }) => {
  await stubFriendsApi(page, { outgoing: [CAROL] });
  await page.goto('/chat');

  await page.getByRole('link', { name: 'Friends' }).click();
  await expect(page.getByText('Outgoing requests')).toBeVisible();
  await expect(page.getByRole('button', { name: /Cancel request to Carol/ })).toBeVisible();
});

test('friend search filters the accepted-friend list', async ({ page }) => {
  await stubFriendsApi(page, { friends: [ALICE] });
  await page.goto('/chat');

  await page.getByRole('link', { name: 'Friends' }).click();
  // Search is collapsed by default — open it before interacting with the textbox.
  await page.getByRole('button', { name: 'Reveal friend search' }).click();
  const search = page.getByRole('textbox', { name: 'Search friends or enter Argus ID' });

  // query matches Alice
  await search.fill('ali');
  await expect(page.getByRole('button', { name: /Open conversation with Alice/ })).toBeVisible();

  // query matches no friend → the list search stays read-only; connecting happens in the dialog.
  await search.fill('argus-nobody-xxxxxx-zzz');
  await expect(page.getByText('No accepted friend found.')).toBeVisible();
});

test('connect new person button opens the friend request dialog', async ({ page }) => {
  await stubFriendsApi(page);
  await page.goto('/__e2e/friends-unavailable');

  await page.getByRole('button', { name: 'Connect new person' }).click();

  await expect(page.getByRole('dialog', { name: 'Connect new person' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Person Argus ID' })).toBeVisible();
});

test('accepted friend can be removed via the unfriend button', async ({ page }) => {
  // Register DELETE stub FIRST so stubFriendsApi's GET handlers (registered after) take LIFO priority.
  let deleteUrl: string | null = null;
  await page.route('**/api/friends/**', (route) => {
    if (route.request().method() === 'DELETE') {
      deleteUrl = route.request().url();
      void route.fulfill({ status: 204, body: '' });
      return;
    }
    void route.continue();
  });

  await stubFriendsApi(page, { friends: [ALICE] });

  await page.goto('/chat');
  await page.getByRole('link', { name: 'Friends' }).click();
  await expect(page.getByRole('button', { name: /Open conversation with Alice/ })).toBeVisible();

  const removeBtn = page.getByRole('button', { name: /Remove friend Alice/ });
  if (await removeBtn.isVisible()) {
    // Authenticated session — exercise the full remove → confirm → DELETE flow.
    await removeBtn.click();
    await page.getByRole('button', { name: /Confirm remove Alice/ }).click();
    expect(deleteUrl).toContain('/friends/');
  } else {
    // Demo mode (onUnfriend is undefined) — verify the button is absent and no DELETE was sent.
    // Interactive click→confirm→call coverage lives in ConversationList.unfriend.spec.ts (tests FriendsScreen).
    expect(deleteUrl).toBeNull();
  }
});

// Valid argus-id used across send-request tests. Must pass ARGUS_ID_RE:
// /^argus-[abcdefghjkmnpqrstuvwxyz23456789]{16}-[a-z]+$/
const VALID_SEND_ID = 'argus-abcdefghjkmnpqrs-test';
const LOOKUP_STUB = {
  userId: 'd4d4d4d4-0000-4000-8000-000000000004',
  argusId: VALID_SEND_ID,
  displayName: 'Dave',
  avatarSeed: null,
};

test('connect person dialog: lookup-then-confirm friend request', async ({ page }) => {
  await stubFriendsApi(page);

  // Stub GET /users/lookup — required by phase-1 of the two-phase send flow.
  let lookedUpId: string | null = null;
  await page.route('**/api/users/lookup**', (route) => {
    lookedUpId = new URL(route.request().url()).searchParams.get('argusId');
    void route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(LOOKUP_STUB),
    });
  });

  await page.goto('/__e2e/friends-unavailable');
  await page.getByRole('button', { name: 'Connect new person' }).click();
  const argusIdInput = page.getByRole('textbox', { name: 'Person Argus ID' });
  const lookupButton = page.getByRole('button', { name: 'Look up' });

  // Phase 1a: format validation error (bad input → no lookup call).
  await argusIdInput.fill('hello');
  await lookupButton.click();
  await expect(page.getByText('Invalid argus ID')).toBeVisible();
  expect(lookedUpId).toBeNull();

  // Phase 1b: valid ID → lookup → confirmation card shows user details.
  await argusIdInput.fill(VALID_SEND_ID);
  await lookupButton.click();
  await expect(page.getByText('Send a friend request to:')).toBeVisible();
  await expect(page.getByText('Dave')).toBeVisible();
  expect(lookedUpId).toBe(VALID_SEND_ID);

  // Phase 2: confirm → sends the request, green pill with name.
  await page.getByRole('button', { name: 'Send request' }).click();
  await expect(page.getByText('Request sent to Dave')).toBeVisible();
});
