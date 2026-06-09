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

test('conversation actions expose expanded state and return focus after panel close', async ({
  page,
}) => {
  await page.goto('/chat');

  const actionsTrigger = page.getByRole('button', { name: 'Open conversation actions' });
  await expect(actionsTrigger).toHaveAttribute('aria-expanded', 'false');

  await actionsTrigger.click();
  await expect(actionsTrigger).toHaveAttribute('aria-expanded', 'true');

  await page.getByRole('menuitem', { name: 'Conversation info' }).click();

  const panel = page.getByRole('dialog', { name: 'Conversation info' });
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();

  await page.getByRole('button', { name: 'Close panel' }).click();
  await expect(panel).toHaveCount(0);
  await expect(actionsTrigger).toBeFocused();
});

test('mobile settings sections expose current state and focus section content', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/chat');

  await page.getByRole('button', { name: 'Open settings' }).click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });
  const securitySection = dialog.getByRole('button', { name: 'Security & Recovery' });

  await securitySection.click();

  const securityContent = dialog.getByRole('region', { name: 'Security & Recovery settings' });
  await expect(securityContent).toBeVisible();
  await expect(securityContent).toBeFocused();

  await dialog.getByRole('button', { name: 'Back to settings menu' }).click();
  await expect(securitySection).toBeVisible();
  await expect(securitySection).toHaveAttribute('aria-current', 'page');
  await expect(securitySection).toBeFocused();
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
