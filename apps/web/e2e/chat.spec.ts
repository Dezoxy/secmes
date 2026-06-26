import { expect, test } from '@playwright/test';

test('chat route renders the main messaging surface', async ({ page }) => {
  await page.goto('/chat');

  await expect(page.getByText('CHAT', { exact: true })).toBeVisible();
  await expect(page.getByText('Sarah Chen').first()).toBeVisible();
  await expect(page.getByPlaceholder('Type a message...')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
});

test('friends panel opens and shows empty state in unauthenticated mode', async ({ page }) => {
  await page.goto('/chat');

  await page.getByRole('link', { name: 'Friends' }).click();
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
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Back to conversations' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
});

test('mobile layout hides nav when entering a group conversation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/groups');

  await page.getByRole('button', { name: 'Open conversation with' }).first().click();

  await expect(page.getByRole('main', { name: 'Group chat' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Back to conversations' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
});

test('voice and video call buttons show coming soon toast', async ({ page }) => {
  await page.goto('/chat');

  await page.getByRole('button', { name: 'Start voice call' }).click();
  await expect(page.getByText('Voice and video calls are coming soon')).toBeVisible();
});

test('group member picker shows suggested friends and supports cancel then confirm', async ({
  page,
}) => {
  await page.goto('/__e2e/group-create');

  await expect(page.getByText('Your friends')).toBeVisible();
  await expect(page.getByText('Eve')).toBeVisible();

  await page.getByRole('button', { name: 'Add Eve' }).click();
  await expect(page.getByRole('button', { name: 'Confirm add Eve' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('button', { name: 'Add Eve' })).toBeVisible();

  await page.getByRole('button', { name: 'Add Eve' }).click();
  await page.getByRole('button', { name: 'Confirm add Eve' }).click();
  await expect(page.getByRole('button', { name: 'Add Eve' })).toHaveCount(0);
  await expect(page.getByText('Eve', { exact: true })).toBeVisible();
});

test('call button toast is debounced — rapid clicks show only one toast', async ({ page }) => {
  await page.goto('/chat');

  const btn = page.getByRole('button', { name: 'Start video call' });
  await btn.click();
  await btn.click();
  await btn.click();

  await expect(page.getByText('Voice and video calls are coming soon')).toHaveCount(1);
});
