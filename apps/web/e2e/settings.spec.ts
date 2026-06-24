import { expect, test } from '@playwright/test';
// Release notes are GENERATED from git tags + commits (see scripts/gen-release-notes.mjs) and re-exported from
// src/lib/release-notes. Assert against the committed data so this test tracks whatever the build baked in,
// rather than a hand-curated version string. Aliased to avoid clashing with the region Locator below.
import { releaseNotes as releaseNotesData } from '../src/lib/release-notes';

test('settings can be opened from chat', async ({ page }) => {
  await page.goto('/settings');

  // Settings is now a plain page, not a dialog
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  // Profile section has moved to /profile — assert it is absent here
  await expect(page.getByRole('heading', { name: 'Profile' })).toHaveCount(0);
  await expect(page.getByText('Display name')).toHaveCount(0);
  await expect(page.getByText('Upload photo')).toHaveCount(0);
  // Settings nav sections are present
  await expect(page.getByRole('button', { name: 'Security', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Privacy' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Appearance' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Data & Storage' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'About' })).toBeVisible();
  await expect(page.getByText('Anonymous account settings')).toHaveCount(0);
  await expect(page.getByText('Auto-assigned. Unique within your organization.')).toHaveCount(0);
});

test('mobile settings opens sections from the menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings');

  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  // Profile section has moved to /profile
  await expect(page.getByRole('heading', { name: 'Profile' })).toHaveCount(0);
  await expect(page.getByText('Display name')).toHaveCount(0);

  await page.getByRole('button', { name: 'Security', exact: true }).click();
  const securityRegion = page.getByRole('region', { name: 'Security settings' });
  await expect(page.getByRole('heading', { name: 'Security', exact: true })).toBeVisible();
  await expect(page.getByText('Passkey only')).toBeVisible();

  await page.getByRole('button', { name: 'Back to settings menu' }).click();
  await expect(securityRegion).toHaveClass(/argus-pane-back-exit/);
  await expect(page.getByRole('button', { name: 'Appearance' })).toBeVisible();
});

test('profile display name is read-only and survives section navigation', async ({ page }) => {
  await page.goto('/settings');

  // Display name lives at /profile — not present here
  await expect(page.getByText('Display name')).toHaveCount(0);
  // No editable username input or Generate button — display name is server-assigned
  await expect(page.getByLabel('Username')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Generate' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Appearance' }).click();
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();

  await expect(page.getByRole('button', { name: 'Profile' })).toHaveCount(0);
  // Display name is still absent (it belongs to /profile)
  await expect(page.getByText('Display name')).toHaveCount(0);
});

test('privacy switches persist across section changes', async ({ page }) => {
  await page.goto('/settings');

  await page.getByRole('button', { name: 'Privacy' }).click();

  await page.getByRole('switch', { name: 'Read receipts' }).click();
  await expect(page.getByRole('switch', { name: 'Read receipts' })).not.toBeChecked();

  await page.getByRole('button', { name: 'Notifications' }).click();
  await page.getByRole('button', { name: 'Privacy' }).click();
  await expect(page.getByRole('switch', { name: 'Read receipts' })).not.toBeChecked();

  // Navigate away then back to verify persistence across route changes
  await page.goto('/chat');
  await page.goto('/settings');

  await page.getByRole('button', { name: 'Privacy' }).click();
  await expect(page.getByRole('switch', { name: 'Read receipts' })).not.toBeChecked();
});

test('security section shows passkey-only login (no recovery surface)', async ({ page }) => {
  await page.goto('/settings');

  await page.getByRole('button', { name: 'Security', exact: true }).click();

  await expect(page.getByText('Passkey only')).toBeVisible();
  await expect(page.getByText('Device unlock')).toHaveCount(0);
  await expect(page.getByText('Your passkey (no password)')).toHaveCount(0);
  // The recovery-file / passphrase surface is gone — no restore controls.
  await expect(page.getByRole('button', { name: 'Restore on this device' })).toHaveCount(0);
  await expect(page.getByText('Recovery passphrase')).toHaveCount(0);
});

test('settings sections preserve defaults after component split', async ({ page }) => {
  await page.goto('/settings');

  await page.getByRole('button', { name: 'Privacy' }).click();
  await expect(page.getByRole('heading', { name: 'Privacy' })).toBeVisible();
  await expect(page.getByText('Read receipts')).toBeVisible();
  await expect(page.getByRole('switch')).toHaveCount(3);
  for (const name of ['Read receipts', 'Typing indicators', 'Link previews']) {
    await expect(page.getByRole('switch', { name })).toBeChecked();
  }

  await page.getByRole('button', { name: 'Notifications' }).click();
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByText('Push notifications')).toBeVisible();
  await expect(
    page.getByText('Content-free pings only — zero message text reaches the server'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Appearance' }).click();
  await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  await expect(page.getByRole('slider', { name: 'Font size' })).toBeVisible();
  await expect(page.getByText('Accent colour')).toBeVisible();

  await page.getByRole('button', { name: 'Data & Storage' }).click();
  await expect(page.getByRole('heading', { name: 'Data & Storage' })).toBeVisible();
  await expect(page.getByText('Encrypted local message cache')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reset' })).toBeVisible();

  await expect(page.getByRole('button', { name: 'Devices' })).toHaveCount(0);
});

test('appearance font size preview follows the slider', async ({ page }) => {
  await page.goto('/settings');

  await page.getByRole('button', { name: 'Appearance' }).click();

  const slider = page.getByRole('slider', { name: 'Font size' });
  const preview = page.locator('[aria-label^="Font size preview"]');

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
  await page.goto('/settings');

  await page.getByRole('button', { name: 'About' }).click();

  await expect(page.getByRole('heading', { name: 'About' })).toBeVisible();
  await expect(page.getByText('App update', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check' })).toBeVisible();
  await expect(
    page.getByText('Android, iOS, iPadOS, macOS, and desktop browsers can install Argus'),
  ).toBeVisible();

  const releaseNotes = page.getByRole('region', { name: 'Release notes' });
  const firstRelease = releaseNotesData[0]!;
  await expect(releaseNotes.getByText(firstRelease.version, { exact: true })).toBeVisible();

  const layout = await releaseNotes.evaluate((node) => {
    const aboutRegion = node.closest('[aria-label="About settings"]');
    const aboutRect = aboutRegion?.getBoundingClientRect();
    const releaseRect = node.getBoundingClientRect();

    return {
      releaseCanScroll: node.scrollHeight > node.clientHeight,
      aboutCanScroll: aboutRegion ? aboutRegion.scrollHeight > aboutRegion.clientHeight : true,
      leftMargin: aboutRect ? Math.round(releaseRect.left - aboutRect.left) : null,
      rightMargin: aboutRect ? Math.round(aboutRect.right - releaseRect.right) : null,
    };
  });

  // Release notes render at natural height — no inner scroll box.
  expect(layout.releaseCanScroll).toBe(false);
  // Outer section clips overflow; the inner div scrolls. Section itself does not overflow.
  expect(layout.aboutCanScroll).toBe(false);
  // Left/right gutters are exactly symmetric.
  expect(layout.leftMargin).toBe(layout.rightMargin);

  // Scrolling (wheel propagates to the parent overflow-y-auto div) reveals the bottom of the list.
  // A truncated entry renders the neutral overflow note below its groups, so that's the true last line.
  await releaseNotes.hover();
  await page.mouse.wheel(0, 5_000);
  const lastRelease = releaseNotesData[releaseNotesData.length - 1]!;
  const lastGroup = lastRelease.groups[lastRelease.groups.length - 1]!;
  const lastLine = lastRelease.overflowNote ?? lastGroup.items[lastGroup.items.length - 1]!;
  await expect(releaseNotes.getByText(lastLine, { exact: true })).toBeVisible();
});

test('notification settings: mentions-only toggle persists across route changes', async ({
  page,
}) => {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Notifications' }).click();

  const mentionsSwitch = page.getByRole('switch', { name: /Mentions only/ });
  await expect(mentionsSwitch).not.toBeChecked();

  await mentionsSwitch.click();
  await expect(mentionsSwitch).toBeChecked();
  await expect(page.getByText(/preference saved/)).toBeVisible();

  // Persist across route changes.
  await page.goto('/chat');
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Notifications' }).click();
  await expect(page.getByRole('switch', { name: /Mentions only/ })).toBeChecked();
});

test('notification settings: quiet hours toggle shows time pickers', async ({ page }) => {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Notifications' }).click();

  const quietSwitch = page.getByRole('switch', { name: /Quiet hours/ });
  await expect(quietSwitch).not.toBeChecked();
  await expect(page.getByLabel('From', { exact: true })).toHaveCount(0);

  await quietSwitch.click();
  await expect(quietSwitch).toBeChecked();
  await expect(page.getByLabel('From', { exact: true })).toBeVisible();
  await expect(page.getByLabel('To', { exact: true })).toBeVisible();

  // Toggle off removes the pickers
  await quietSwitch.click();
  await expect(quietSwitch).not.toBeChecked();
  await expect(page.getByLabel('From', { exact: true })).toHaveCount(0);
});

test('notification settings: conversation mute controls show 0 muted by default', async ({
  page,
}) => {
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Notifications' }).click();

  await expect(page.getByText('Conversation mute controls')).toBeVisible();
  await expect(page.getByText('0 muted')).toBeVisible();
});

test('conversation mute: kebab menu mutes and unmutes a conversation', async ({ page }) => {
  await page.goto('/chat');
  await expect(page.getByLabel('2 unread')).toBeVisible();

  // Open the first conversation's action menu
  await page.getByRole('button', { name: 'Open conversation actions' }).click();
  await expect(page.getByRole('menu', { name: 'Conversation actions' })).toBeVisible();

  // Mute the conversation
  await page.getByRole('menuitem', { name: /Mute conversation/ }).click();
  await expect(page.getByLabel('2 unread')).toHaveCount(0);

  // Re-open the menu — the item should now say "Unmute conversation"
  await page.getByRole('button', { name: 'Open conversation actions' }).click();
  await expect(page.getByRole('menuitem', { name: /Unmute conversation/ })).toBeVisible();

  // Settings should reflect 1 muted
  await page.keyboard.press('Escape');
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Notifications' }).click();
  await expect(page.getByText(/1 conversation muted/)).toBeVisible();

  // Unmute all from settings
  await page.getByRole('button', { name: /Conversation mute controls/ }).click();
  await expect(page.getByText('0 muted')).toBeVisible();
  await page.getByRole('link', { name: 'Chat' }).click();
  await expect(page.getByLabel('2 unread')).toBeVisible();
});
