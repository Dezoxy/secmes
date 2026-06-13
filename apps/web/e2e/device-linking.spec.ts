import { expect, test } from '@playwright/test';

// B2 device-linking E2E tests. The full two-device flow (D1 approves D2) requires two separate
// browser contexts plus a live backend — those tests are marked skip until the staging environment
// exposes enrollment endpoints. The single-device UI tests below run against the static PWA.

test('Devices settings section is accessible from Settings', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Devices' }).click();

  await expect(page.getByRole('heading', { name: 'Devices' })).toBeVisible();
  await expect(page.getByText('Current device')).toBeVisible();
});

test('Link another device button absent when no device is provisioned', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();
  await page.getByRole('button', { name: 'Devices' }).click();

  // In demo mode (OIDC unconfigured) deviceId is null — the button should not render.
  await expect(page.getByRole('button', { name: 'Link another device' })).toHaveCount(0);
});

// The tests below require two live browser contexts authenticated as the SAME user on a real
// backend. They are skipped in the current CI environment.

test.skip('Full link flow: D2 shows code, D1 approves, D2 joins pre-existing conversation', async ({
  browser,
}) => {
  const d1 = await browser.newContext();
  const d2 = await browser.newContext();
  const d1Page = await d1.newPage();
  const d2Page = await d2.newPage();

  // D1: navigate to chat (already has an unlocked device with conversations)
  await d1Page.goto('/chat');

  // D2: navigate and unlock, then open Settings → Devices → Link another device
  await d2Page.goto('/chat');
  // ... unlock D2 with passphrase ...
  await d2Page.getByRole('button', { name: 'Open settings' }).click();
  await d2Page.getByRole('button', { name: 'Devices' }).click();
  await d2Page.getByRole('button', { name: 'Link another device' }).click();

  // D2: dialog appears and shows a 9-digit code
  const d2Dialog = d2Page.getByRole('dialog', { name: 'Link this device' });
  await expect(d2Dialog).toBeVisible();
  const codeEl = d2Dialog.locator('[aria-live]');
  await expect(codeEl).not.toHaveText('--- --- ---');
  const code = await codeEl.innerText();

  // D1: enrollment_pending WS event triggers approval dialog
  const d1Dialog = d1Page.getByRole('dialog', { name: 'Approve new device' });
  await expect(d1Dialog).toBeVisible({ timeout: 10_000 });

  // D1: enter the code from D2 and approve
  await d1Dialog.getByLabel('Code shown on new device').fill(code);
  await d1Dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(d1Dialog.getByText('Device approved!')).toBeVisible({ timeout: 15_000 });
  await d1Dialog.getByRole('button', { name: 'Done' }).click();

  // D2: panel transitions to linked state
  await expect(d2Dialog.getByText('Device linked!')).toBeVisible({ timeout: 15_000 });

  await d1.close();
  await d2.close();
});

test.skip('Fingerprint mismatch: wrong code blocks approval', async ({ browser }) => {
  const d1 = await browser.newContext();
  const d1Page = await d1.newPage();

  await d1Page.goto('/chat');

  const d1Dialog = d1Page.getByRole('dialog', { name: 'Approve new device' });
  await d1Dialog.getByLabel('Code shown on new device').fill('000 000');
  await d1Dialog.getByRole('button', { name: 'Approve' }).click();

  await expect(d1Dialog.getByText("Code doesn't match")).toBeVisible();

  await d1.close();
});
