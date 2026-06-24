import { expect, test } from '@playwright/test';

test('chat route renders the main messaging surface', async ({ page }) => {
  await page.goto('/chat');

  await expect(page.getByText('ARGUS').first()).toBeVisible();
  await expect(page.getByText('Sarah Chen').first()).toBeVisible();
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open settings' })).toBeVisible();
});

test('friends panel opens and shows empty state in unauthenticated mode', async ({ page }) => {
  await page.goto('/chat');

  await page.getByRole('button', { name: 'Friends' }).click();
  await expect(page.getByRole('heading', { name: 'Friends' })).toBeVisible();
  // In demo/unauthenticated mode the friends list is empty (API calls may fire but fail silently; no manager → no mutations).
  await expect(page.getByText('No accepted friends yet')).toBeVisible();
  await expect(page.getByText('0 accepted')).toBeVisible();
});

test('mobile layout shows chat after selecting a conversation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/chat');

  await page.getByRole('button', { name: 'Open conversation with' }).first().click();

  await expect(page.getByRole('main', { name: 'Chat' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Conversations' })).toHaveCount(0);
});

test('voice and video call buttons show coming soon toast', async ({ page }) => {
  await page.goto('/chat');

  await page.getByRole('button', { name: 'Start voice call' }).click();
  await expect(page.getByText('Voice and video calls are coming soon')).toBeVisible();
});

test('call button toast is debounced — rapid clicks show only one toast', async ({ page }) => {
  await page.goto('/chat');

  const btn = page.getByRole('button', { name: 'Start video call' });
  await btn.click();
  await btn.click();
  await btn.click();

  await expect(page.getByText('Voice and video calls are coming soon')).toHaveCount(1);
});
