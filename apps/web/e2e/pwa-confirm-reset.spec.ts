import { expect, test } from '@playwright/test';

// PWA update / storage-eviction "needs-confirm-reset" gate.
//
// When a PWA update reloads the page and the session cookie has expired, the login ceremony
// stashes the unlock key while IndexedDB is (partially) evicted under storage pressure from the
// update download. The old code would silently create a brand-new device, making any surviving
// message history permanently inaccessible. The fix pauses in 'needs-confirm-reset' and surfaces
// an explicit warning before any data is lost.
//
// Triggering the real gate requires:
//   - The app running WITHOUT demo mode (so DeviceContext runs the real keystore path)
//   - At least one record in GROUP_STORE / MSGLOG_STORE / PENDING_STORE with an identity
//     that doesn't match the one about to be created (simulating storage eviction)
//   - A live passkey assertion to derive the unlock key (not available in CI)
//
// Both positive paths are therefore documented + skipped (mirroring device-linking.spec.ts and
// sync-lost.spec.ts). The live assertion below is the regression guard: the warning card must
// NOT appear during normal demo-mode operation (i.e. the 'ready' shortcut path).

test('needs-confirm-reset warning card is absent during normal operation', async ({ page }) => {
  await page.goto('/chat');

  // Wait for the chat to settle before checking absence — without this the assertions would
  // pass trivially while React is still mounting (same pattern as sync-lost.spec.ts).
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible();

  // In demo mode DeviceContext jumps straight to 'ready' — the warning card should never render.
  await expect(
    page.getByRole('heading', { name: 'Conversation history may be inaccessible' }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start fresh (data will be lost)' })).toHaveCount(
    0,
  );
});

// Full flow requires a non-demo session with orphaned IndexedDB state and a live passkey.
// Skipped until CI can provision a real authenticated context with IndexedDB pre-seeded.
// Steps to verify manually:
//   1. Log in to the app on a real device; use it so GROUP_STORE/MSGLOG_STORE have entries.
//   2. Clear only the STORE key from IndexedDB (DevTools → Application → IndexedDB → argus-keystore
//      → STORE → delete the 'self' record) while leaving GROUP_STORE/MSGLOG_STORE intact.
//   3. Reload. Log in again (passkey prompt). The 'needs-confirm-reset' card should appear:
//      - Heading: "Conversation history may be inaccessible"
//      - Subtitle mentions the device credential is missing and data loss is permanent
//      - Button: "Start fresh (data will be lost)" (disabled while busy)
//   4. Click "Start fresh" — the app provisions a new device and enters the chat with empty history.
//   5. Confirm the old GROUP_STORE/MSGLOG_STORE records are gone (clearDevice wipes all stores).
test.skip('needs-confirm-reset: warning appears then clears after explicit confirmation (needs live passkey + seeded IndexedDB)', () => {
  // No assertions run while skipped; steps documented above keep the intent auditable.
  expect(true).toBe(true);
});

// Verify the auto-unlock fix: 'needs-create' must NOT auto-trigger unlock when a pending key exists.
// Full verification requires a non-demo context with an empty STORE but a stashed PRF key in memory.
// Steps to verify manually:
//   1. Log in; immediately clear STORE from IndexedDB (see step 2 above).
//   2. Observe that the "Set up this device" button is displayed — the gate does NOT auto-proceed.
//   3. Click the button manually; the device is created (or the warning card shown if orphaned data).
test.skip('needs-create: gate shows "Set up this device" button and does not auto-unlock (needs live passkey)', () => {
  expect(true).toBe(true);
});
