import { expect, test } from '@playwright/test';

test('chat route renders the main messaging surface', async ({ page }) => {
  await page.goto('/chat');

  await expect(page.getByText('ARGUS').first()).toBeVisible();
  await expect(page.getByText('Sarah Chen').first()).toBeVisible();
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible();
});

test('friends panel lists accepted friends and mocks outgoing requests', async ({ page }) => {
  await page.goto('/chat');

  await page.getByRole('button', { name: 'Friends' }).click();
  await expect(page.getByRole('heading', { name: 'Friends' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open friend Sarah Chen' })).toBeVisible();
  await expect(page.getByText('Marcus Johnson')).toHaveCount(0);

  const friendSearch = page.getByRole('textbox', { name: 'Search friends or enter Argus ID' });
  await friendSearch.fill('argus-hhhhhhhhhhhhhhhh-new');
  await page.getByRole('button', { name: 'Send friend request' }).click();

  await expect(page.getByText('Request sent').first()).toBeVisible();
});

test('mobile friends panel opens the selected accepted friend chat', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/chat');

  await page.getByRole('button', { name: 'Friends' }).click();
  const friendSearch = page.getByRole('textbox', { name: 'Search friends or enter Argus ID' });
  await friendSearch.fill('Sarah');
  await page.getByRole('button', { name: 'Open friend Sarah Chen' }).click();

  await expect(page.getByRole('main', { name: 'Chat' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Conversations' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Sarah Chen' })).toBeVisible();
});
