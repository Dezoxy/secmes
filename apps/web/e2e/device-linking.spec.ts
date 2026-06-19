import { expect, test } from '@playwright/test';

// B2 device-linking E2E tests. The full two-device flow (D1 approves D2) requires two separate
// browser contexts plus a live backend — those tests are marked skip until the staging environment
// exposes enrollment endpoints. The static Settings modal currently hides device-linking entrypoints.

test('Devices settings section is hidden from Settings', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('button', { name: 'Devices' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Link another device' })).toHaveCount(0);
});

// The tests below require two live browser contexts authenticated as the SAME user on a real
// backend. They are skipped in the current CI environment.

test.skip('Full link flow: both devices show the same safety number, D1 confirms, D2 joins', async ({
  browser,
}) => {
  const d1 = await browser.newContext();
  const d2 = await browser.newContext();
  const d1Page = await d1.newPage();
  const d2Page = await d2.newPage();

  // D1: navigate to chat (already has an unlocked device with conversations)
  await d1Page.goto('/chat');

  // D2: navigate and unlock, then open the future device-linking entrypoint.
  await d2Page.goto('/chat');
  // ... unlock D2 with passphrase ...

  // D2: dialog appears and shows the full-width safety number (8 groups of 5 digits, not a 9-digit
  // code) for visual comparison — there is no typed entry on either device.
  const d2Dialog = d2Page.getByRole('dialog', { name: 'Link this device' });
  await expect(d2Dialog).toBeVisible();
  const d2NumberEl = d2Dialog.locator('[aria-label^="Safety number:"]');
  await expect(d2NumberEl).toBeVisible();
  const d2Number = (await d2NumberEl.getAttribute('aria-label'))?.replace('Safety number: ', '');

  // D1: enrollment_pending WS event triggers approval dialog
  const d1Dialog = d1Page.getByRole('dialog', { name: 'Approve new device' });
  await expect(d1Dialog).toBeVisible({ timeout: 10_000 });

  // D1: the number it derives from the server-relayed fingerprint must match what D2 displays
  // (a server key-swap would make them diverge — the whole point of the compare).
  const d1Number = (
    await d1Dialog.locator('[aria-label^="Safety number:"]').getAttribute('aria-label')
  )?.replace('Safety number: ', '');
  expect(d1Number).toBe(d2Number);

  // D1: confirm the match — Approve IS the human assertion, no typed code.
  await d1Dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(d1Dialog.getByText('Device approved!')).toBeVisible({ timeout: 15_000 });
  await d1Dialog.getByRole('button', { name: 'Done' }).click();

  // D2: panel transitions to linked state
  await expect(d2Dialog.getByText('Device linked!')).toBeVisible({ timeout: 15_000 });

  await d1.close();
  await d2.close();
});
