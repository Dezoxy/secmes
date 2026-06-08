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
