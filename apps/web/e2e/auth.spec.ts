import { expect, test } from '@playwright/test';

test('auth entry stays passkey-first without app-owned password fields', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Welcome to Argus' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with passkey' })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /google|apple|password/i })).toHaveCount(0);
});
