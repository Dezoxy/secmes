import { expect, test } from '@playwright/test';

const routeShells = [
  { path: '/settings', heading: 'Account settings', marker: 'Manage your profile' },
  { path: '/security', heading: 'Security', marker: 'Unlocked by your passkey' },
  { path: '/devices', heading: 'Trusted devices', marker: 'Device management shell' },
  { path: '/storage', heading: 'Data & storage', marker: 'Encrypted local state only' },
];

for (const route of routeShells) {
  test(`${route.path} renders a guarded product route shell`, async ({ page }) => {
    await page.goto(route.path);

    await expect(page.getByLabel('Open chat')).toBeVisible();
    await expect(page.getByRole('heading', { name: route.heading })).toBeVisible();
    await expect(page.getByText(route.marker)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Chat', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Go back' })).toBeVisible();
  });
}

test('the product route shell back button returns to the previous screen', async ({ page }) => {
  await page.goto('/chat');
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Account settings' })).toBeVisible();

  // Smart back: with in-app history it steps back to where we came from (chat).
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(page).toHaveURL(/\/chat$/);
});

test('/transparency renders the public security page without auth', async ({ page }) => {
  await page.goto('/transparency');

  await expect(page.getByRole('main', { name: 'Security and transparency' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Security & Transparency' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'End-to-end encryption' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bundle integrity' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /sub-processors/i })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Microsoft Azure' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Backblaze B2' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Argus', exact: true })).toBeVisible();
});
