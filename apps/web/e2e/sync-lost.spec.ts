import { expect, test } from '@playwright/test';

// Track 4 slice 5c — the "sync-lost" recovery affordance.
//
// A conversation becomes sync-lost when the MLS commit it needs to advance its epoch was pruned (or
// the device was offline beyond retention). The client then drops the broken group state, surfaces a
// "needs reconnecting" banner, suppresses the composer, and re-joins fresh once a current member
// re-adds it (full out-of-band safety-number re-check).
//
// Driving a REAL sync-lost end-to-end needs a live backend that can prune a conversation commit plus
// two devices sharing a group — which the demo-mode E2E harness (VITE_DEMO_MODE=1: seed conversations,
// no socket, no backend) cannot provide. This is exactly the constraint that keeps the device-linking
// full flow skipped (see device-linking.spec.ts). So the positive flow is documented + skipped pending
// staging, and the live assertion here is the guard: the affordance must NOT leak into a healthy chat.

test('healthy conversation shows no sync-lost affordance and keeps the composer', async ({
  page,
}) => {
  await page.goto('/chat');

  // A seed conversation is selected by default and is healthy (no `recovery` flag) — neither the
  // banner title nor its body copy should render.
  await expect(page.getByText('Conversation out of sync')).toHaveCount(0);
  await expect(page.getByText('fell too far behind to sync')).toHaveCount(0);
  // The composer stays available on a healthy conversation (the suppression is sync-lost-only).
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible();
});

// Requires a live backend that can prune the commit a lagging device needs (or hold a device offline
// past retention) so the client's `classifyCommitDrain` returns 'sync-lost'. Skipped until staging
// supports it, mirroring the skipped device-linking full flow. The flow to assert once enabled:
//   1. Two devices/users share a conversation that has at least one membership commit.
//   2. The server prunes the commit the lagging device needs (or it stays offline past retention).
//   3. On reconnect the lagging device detects sync-lost: the "Conversation out of sync" banner
//      appears (role="status") and the composer is suppressed.
//   4. A current member re-adds the device (fresh Welcome); it re-joins at the current epoch, the
//      banner clears, and the composer returns — with the out-of-band safety number re-checked.
test.skip('sync-lost banner appears then clears after the device is re-added (needs live backend)', () => {
  // No assertions run while skipped; this body documents the flow (see steps above) and keeps the
  // test non-empty. Enable once staging exposes commit pruning + a second authenticated device.
  expect(true).toBe(true);
});
