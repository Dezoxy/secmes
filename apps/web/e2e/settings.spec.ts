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
  const securityRegion = page.getByRole('region', { name: 'Security & Recovery settings' });
  await expect(page.getByRole('heading', { name: 'Security & Recovery' })).toBeVisible();
  await expect(page.getByText('Passkey-only login')).toBeVisible();

  await page.getByRole('button', { name: 'Back to settings menu' }).click();
  await expect(securityRegion).toHaveClass(/argus-pane-back-exit/);
  await expect(page.getByRole('button', { name: 'Appearance' })).toBeVisible();
});

test('profile autosave accepts a generated avatar and user-chosen username', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();

  await page.getByLabel('Username').fill('smoke-user');
  await page.getByRole('button', { name: 'Generate' }).click();
  await page.waitForFunction(() =>
    Object.values(localStorage).some((value) => value.includes('smoke-user')),
  );
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

test('profile autosave resets a blank username to the anonymous default', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();

  const username = page.getByLabel('Username');
  const defaultName = await username.inputValue();

  await username.fill('reset-user');
  await page.waitForFunction(() =>
    Object.values(localStorage).some((value) => value.includes('reset-user')),
  );

  await username.fill('');

  await expect(username).toHaveValue(defaultName);
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByText(defaultName)).toBeVisible();
});

test('profile autosave flushes before closing settings', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();

  await page.getByLabel('Username').fill('quick-close-user');
  await page.getByRole('button', { name: 'Close settings' }).click();

  await expect(page.getByText('quick-close-user')).toBeVisible();

  await page.reload();
  await expect(page.getByText('quick-close-user')).toBeVisible();
});

test('privacy switches persist across section changes', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Privacy' }).click();

  await dialog.getByRole('switch', { name: 'Read receipts' }).click();
  await expect(dialog.getByRole('switch', { name: 'Read receipts' })).not.toBeChecked();

  await dialog.getByRole('button', { name: 'Notifications' }).click();
  await dialog.getByRole('button', { name: 'Privacy' }).click();
  await expect(dialog.getByRole('switch', { name: 'Read receipts' })).not.toBeChecked();

  await dialog.getByRole('button', { name: 'Close settings' }).click();
  await page.getByRole('button', { name: 'Open settings' }).click();

  const reopened = page.getByRole('dialog', { name: 'Settings' });
  await reopened.getByRole('button', { name: 'Privacy' }).click();
  await expect(reopened.getByRole('switch', { name: 'Read receipts' })).not.toBeChecked();
});

test('security recovery keeps the recovery-file import path available', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Security & Recovery' }).click();
  await dialog.getByRole('button', { name: 'Import recovery file' }).click();

  await expect(dialog.getByText('past message history is not recovered')).toBeVisible();
  await expect(dialog.getByText('Choose your recovery file')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Replace this device' })).toBeVisible();
});

test('security recovery reminder is local and dismissible', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Security & Recovery' }).click();

  const reminder = dialog.getByText('Set up recovery before you rely on this device');
  await expect(reminder).toBeVisible();

  await dialog.getByRole('button', { name: 'Dismiss reminder' }).click();
  await expect(reminder).toBeHidden();

  await dialog.getByRole('button', { name: 'Privacy' }).click();
  await dialog.getByRole('button', { name: 'Security & Recovery' }).click();
  await expect(reminder).toBeHidden();
});

test('security recovery shows passphrase strength while creating backup', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Security & Recovery' }).click();

  const strength = dialog.getByRole('meter', { name: 'Recovery passphrase strength' });
  await expect(strength).toHaveAttribute('aria-valuenow', '0');

  const passphrase = dialog.getByLabel('Recovery passphrase', { exact: true });

  await passphrase.fill('short');
  await expect(strength).toHaveAttribute('aria-valuenow', '1');
  await expect(dialog.getByText('Weak', { exact: true })).toBeVisible();

  await passphrase.fill('longer-Passphrase-42!');
  await expect(strength).toHaveAttribute('aria-valuenow', '4');
  await expect(dialog.getByText('Strong', { exact: true })).toBeVisible();
});

test('settings sections preserve defaults after component split', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });

  await dialog.getByRole('button', { name: 'Privacy' }).click();
  await expect(dialog.getByRole('heading', { name: 'Privacy' })).toBeVisible();
  await expect(dialog.getByText('Read receipts')).toBeVisible();
  await expect(dialog.getByRole('switch')).toHaveCount(3);
  for (const name of ['Read receipts', 'Typing indicators', 'Link previews']) {
    await expect(dialog.getByRole('switch', { name })).toBeChecked();
  }

  await dialog.getByRole('button', { name: 'Notifications' }).click();
  await expect(dialog.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(dialog.getByText('Push notifications')).toBeVisible();
  await expect(dialog.getByText('Automatically follows device permission')).toBeVisible();

  await dialog.getByRole('button', { name: 'Appearance' }).click();
  await expect(dialog.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  await expect(dialog.getByRole('slider', { name: 'Font size' })).toBeVisible();
  await expect(dialog.getByText('Accent colour')).toBeVisible();

  await dialog.getByRole('button', { name: 'Data & Storage' }).click();
  await expect(dialog.getByRole('heading', { name: 'Data & Storage' })).toBeVisible();
  await expect(dialog.getByText('Encrypted local message cache')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Reset' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Devices' }).click();
  await expect(dialog.getByRole('heading', { name: 'Devices' })).toBeVisible();
  await expect(dialog.getByText('Current device')).toBeVisible();
});

test('appearance font size preview follows the slider', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Appearance' }).click();

  const slider = dialog.getByRole('slider', { name: 'Font size' });
  const preview = dialog.locator('[aria-label^="Font size preview"]');

  await slider.focus();
  await slider.press('Home');
  await expect(preview).toHaveAttribute('aria-label', 'Font size preview level 1');
  const minimumSize = Number.parseFloat(
    await preview.evaluate((element) => getComputedStyle(element).fontSize),
  );

  await slider.press('End');
  await expect(preview).toHaveAttribute('aria-label', 'Font size preview level 10');
  const maximumSize = Number.parseFloat(
    await preview.evaluate((element) => getComputedStyle(element).fontSize),
  );

  expect(maximumSize).toBeGreaterThan(minimumSize);
});

test('about exposes manual PWA update status and platform install expectations', async ({
  page,
}) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'About' }).click();

  await expect(dialog.getByRole('heading', { name: 'About' })).toBeVisible();
  await expect(dialog.getByText('App update', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Check' })).toBeVisible();
  await expect(
    dialog.getByText('Android, iOS, iPadOS, macOS, and desktop browsers can install Argus'),
  ).toBeVisible();

  const releaseNotes = dialog.getByRole('region', { name: 'Release notes' });
  const releaseNotesScrollbar = dialog.getByTestId('release-notes-scrollbar');
  await expect(releaseNotes.getByText('v0.3.2', { exact: true })).toBeVisible();

  const layout = await releaseNotes.evaluate((node) => {
    const aboutRegion = node.closest('[aria-label="About settings"]');
    const aboutRect = aboutRegion?.getBoundingClientRect();
    const releaseRect = node.getBoundingClientRect();

    return {
      releaseCanScroll: node.scrollHeight > node.clientHeight,
      aboutCanScroll: aboutRegion ? aboutRegion.scrollHeight > aboutRegion.clientHeight : true,
      bottomMargin: aboutRect ? Math.round(aboutRect.bottom - releaseRect.bottom) : null,
      leftMargin: aboutRect ? Math.round(releaseRect.left - aboutRect.left) : null,
      rightMargin: aboutRect ? Math.round(aboutRect.right - releaseRect.right) : null,
    };
  });

  expect(layout.releaseCanScroll).toBe(true);
  expect(layout.aboutCanScroll).toBe(false);
  expect(Math.abs(layout.bottomMargin! - layout.leftMargin!)).toBeLessThanOrEqual(8);
  expect(Math.abs(layout.bottomMargin! - layout.rightMargin!)).toBeLessThanOrEqual(8);
  await expect(releaseNotesScrollbar).toHaveClass(/opacity-0/);

  await releaseNotes.hover();
  await page.mouse.wheel(0, 5_000);
  await expect(releaseNotesScrollbar).toHaveClass(/opacity-100/);
  await expect(releaseNotesScrollbar).toHaveClass(/opacity-0/, { timeout: 2_000 });
  await expect(releaseNotes.getByText('v0.0.1', { exact: true })).toBeVisible();
});
