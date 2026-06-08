import { expect, test } from '@playwright/test';

test('chat route renders the main messaging surface', async ({ page }) => {
  await page.goto('/chat');

  await expect(page.getByText('ARGUS').first()).toBeVisible();
  await expect(page.getByText('Sarah Chen').first()).toBeVisible();
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible();
});
