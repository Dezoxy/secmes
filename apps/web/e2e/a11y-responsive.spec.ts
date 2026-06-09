import { expect, test } from '@playwright/test';

test('chat exposes landmarks and named composer controls', async ({ page }) => {
  await page.goto('/chat');

  await expect(page.getByRole('complementary', { name: 'Conversations' })).toBeVisible();
  await expect(page.getByRole('main', { name: 'Chat' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Message thread' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeVisible();
  await expect(page.getByRole('menu', { name: 'Message actions' })).toHaveCount(0);
  await expect(page.getByRole('menu', { name: 'Conversation actions' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Open message actions' }).click();
  await expect(page.getByRole('menu', { name: 'Message actions' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Attach file' })).toBeVisible();

  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Open conversation actions' }).click();
  await expect(page.getByRole('menu', { name: 'Conversation actions' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Conversation info' })).toBeVisible();
});

test('settings closes back to the trigger and exposes section navigation', async ({ page }) => {
  await page.goto('/chat');

  const settingsTrigger = page.getByRole('button', { name: 'Open settings' });
  await settingsTrigger.click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(settingsTrigger).toBeFocused();
});

test('mobile chat switches between conversation list and active thread landmarks', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/chat');

  await expect(page.getByRole('complementary', { name: 'Conversations' })).toBeVisible();
  await expect(page.getByRole('main', { name: 'Chat' })).toHaveCount(0);

  await page.getByRole('button', { name: /Open conversation with Sarah Chen/i }).click();
  await expect(page.getByRole('main', { name: 'Chat' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Conversations' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Back to conversations' }).click();
  await expect(page.getByRole('complementary', { name: 'Conversations' })).toBeVisible();
});
