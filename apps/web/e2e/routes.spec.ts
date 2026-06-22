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

test('the route shell back button steps back through in-app history', async ({ page }) => {
  await page.goto('/settings');
  // In-app navigation (PUSH) to another shell so there is genuine Argus history to return to.
  await page.getByRole('link', { name: 'Security', exact: true }).click();
  await expect(page).toHaveURL(/\/security$/);

  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(page).toHaveURL(/\/settings$/);
});

test('the route shell back button falls back to chat on a deep link with no in-app history', async ({
  page,
}) => {
  // Direct load → React Router's first location has key "default", so there is nowhere in-app to go
  // back to. Smart back must land on /chat rather than navigating off-site.
  await page.goto('/settings');
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
