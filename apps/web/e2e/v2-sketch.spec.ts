import { expect, test } from '@playwright/test';

const v2Routes = [
  '/v2',
  '/v2/chat',
  '/v2/landing',
  '/v2/settings',
  '/v2/security',
  '/v2/devices',
  '/v2/storage',
  '/v2/invite',
  '/v2/callback',
  '/v2/transparency',
];

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const hasOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth + 1,
  );

  expect(hasOverflow).toBe(false);
}

for (const route of v2Routes) {
  test(`${route} renders the v2 sketch surface`, async ({ page }) => {
    await page.goto(route);

    await expect(page.locator('body')).toContainText(/Argus|ARGUS|Minimal Messenger OS|V2/i);
    await expectNoHorizontalOverflow(page);
  });
}

test('v2 sketchbook cards and command palette navigate between sketches', async ({ page }) => {
  await page.goto('/v2');

  await page.locator('main a[href="/v2/security"]').first().click();
  await expect(page).toHaveURL('/v2/security');
  await expect(page.getByRole('heading', { name: 'Security', exact: true })).toBeVisible();

  await page.goto('/v2/chat');
  await page.getByRole('button', { name: 'Open v2 command palette' }).click();
  await page.getByPlaceholder('Search pages, conversations, and actions').fill('storage');
  await page.getByRole('button', { name: 'Open Storage /storage' }).click();

  await expect(page).toHaveURL('/v2/storage');
  await expect(page.getByRole('heading', { name: 'Storage', exact: true })).toBeVisible();
});

test('v2 chat keeps messages and verification state scoped to the selected conversation', async ({
  page,
}) => {
  await page.goto('/v2/chat');

  await expect(page.getByText('The new onboarding copy is ready.')).toBeVisible();

  await page.getByRole('button', { name: /Legal review/i }).click();
  await expect(page.getByText('I opened the invite from a new browser.')).toBeVisible();
  await expect(page.getByText('Pending verification')).toBeVisible();

  await page.getByRole('button', { name: 'Verify now' }).click();
  await expect(page.getByText('Safety number accepted on this browser.')).toBeVisible();
  await expect(page.getByText('Pending verification')).toHaveCount(0);

  await page.getByLabel('Message Legal review').fill('Local legal-only message');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByText('Local legal-only message')).toBeVisible();

  await page.getByRole('button', { name: /Sarah Chen/i }).click();
  await expect(page.getByText('The new onboarding copy is ready.')).toBeVisible();
  await expect(page.getByText('Local legal-only message')).toHaveCount(0);
});

test('v2 chat remains usable on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/v2/chat');

  await expectNoHorizontalOverflow(page);
  await page.getByRole('button', { name: /Legal review/i }).click();
  await expect(page.getByText('Pending verification')).toBeVisible();
  await expect(page.getByLabel('Message Legal review')).toBeVisible();
});
