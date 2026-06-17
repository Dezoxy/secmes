import { expect, test } from '@playwright/test';

const routeShells = [
  { path: '/settings', heading: 'Account settings', marker: 'Manage your profile' },
  { path: '/security', heading: 'Security & recovery', marker: 'Recovery remains embedded' },
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
  });
}

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
