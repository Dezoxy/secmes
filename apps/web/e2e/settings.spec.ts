import { expect, test } from '@playwright/test';

test('settings can be opened from chat', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();

  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
  await expect(page.getByLabel('Username')).toBeVisible();
});

test('mobile settings opens sections from the menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();

  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeHidden();

  await page.getByRole('button', { name: 'Security & Recovery' }).click();
  await expect(page.getByRole('heading', { name: 'Security & Recovery' })).toBeVisible();
  await expect(page.getByText('Passkey-only login')).toBeVisible();

  await page.getByRole('button', { name: 'Back to settings menu' }).click();
  await expect(page.getByRole('button', { name: 'Appearance' })).toBeVisible();
});

test('profile save accepts a generated avatar and user-chosen username', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();

  await page.getByLabel('Username').fill('smoke-user');
  await page.getByRole('button', { name: 'Generate' }).click();
  await page.getByRole('button', { name: 'Save profile' }).click();
  await page.getByRole('button', { name: 'Close settings' }).click();

  await expect(page.getByText('smoke-user')).toBeVisible();
});

test('profile draft survives settings section changes', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });

  await dialog.getByLabel('Username').fill('draft-user');
  await dialog.getByRole('button', { name: 'Appearance' }).click();
  await expect(dialog.getByRole('heading', { name: 'Appearance' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Profile' }).click();
  await expect(dialog.getByLabel('Username')).toHaveValue('draft-user');
});

test('settings sections preserve defaults after component split', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });

  await dialog.getByRole('button', { name: 'Privacy' }).click();
  await expect(dialog.getByRole('heading', { name: 'Privacy' })).toBeVisible();
  await expect(dialog.getByText('Read receipts')).toBeVisible();
  await expect(dialog.getByText('Uses the product default')).toHaveCount(3);

  await dialog.getByRole('button', { name: 'Notifications' }).click();
  await expect(dialog.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(dialog.getByText('Push notifications')).toBeVisible();
  await expect(dialog.getByText('Automatically follows device permission')).toBeVisible();

  await dialog.getByRole('button', { name: 'Appearance' }).click();
  await expect(dialog.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Font size 1', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Font size 10', exact: true })).toBeVisible();
  await expect(dialog.getByText('Accent colour')).toBeVisible();

  await dialog.getByRole('button', { name: 'Data & Storage' }).click();
  await expect(dialog.getByRole('heading', { name: 'Data & Storage' })).toBeVisible();
  await expect(dialog.getByText('Encrypted local message cache')).toBeVisible();

  await dialog.getByRole('button', { name: 'Devices' }).click();
  await expect(dialog.getByRole('heading', { name: 'Devices' })).toBeVisible();
  await expect(dialog.getByText('Current device')).toBeVisible();
});
