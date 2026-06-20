import { expect, test } from '@playwright/test';
// Release notes are GENERATED from git tags + commits (see scripts/gen-release-notes.mjs) and re-exported from
// src/lib/release-notes. Assert against the committed data so this test tracks whatever the build baked in,
// rather than a hand-curated version string. Aliased to avoid clashing with the region Locator below.
import { releaseNotes as releaseNotesData } from '../src/lib/release-notes';

test('settings can be opened from chat', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();

  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
  await expect(page.getByText('Display name')).toBeVisible();
  await expect(page.getByText('Upload photo')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Profile' })).toHaveCount(0);
  await expect(page.getByText('Anonymous account settings')).toHaveCount(0);
  await expect(page.getByText('Auto-assigned. Unique within your organization.')).toHaveCount(0);

  // Custom photo upload is deferred: the button shows a "coming soon" notice instead of a file picker,
  // so the profile always uses the generated avatar (no user-supplied image enters the app).
  await page.getByRole('button', { name: 'Upload photo' }).click();
  await expect(page.getByText('Coming soon')).toBeVisible();
  await expect(page.getByText(/Photo upload isn.t available yet/)).toBeVisible();
});

test('mobile settings opens sections from the menu', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();

  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
  await expect(page.getByText('Display name')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Profile' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Security', exact: true }).click();
  const securityRegion = page.getByRole('region', { name: 'Security settings' });
  await expect(page.getByRole('heading', { name: 'Security', exact: true })).toBeVisible();
  await expect(page.getByText('Passkey only')).toBeVisible();

  await page.getByRole('button', { name: 'Back to settings menu' }).click();
  await expect(securityRegion).toHaveClass(/argus-pane-back-exit/);
  await expect(page.getByRole('button', { name: 'Appearance' })).toBeVisible();
});

test('profile display name is read-only and survives section navigation', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });

  await expect(dialog.getByText('Display name')).toBeVisible();
  // No editable username input or Generate button — display name is server-assigned
  await expect(dialog.getByLabel('Username')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Generate' })).toHaveCount(0);

  await dialog.getByRole('button', { name: 'Appearance' }).click();
  await expect(dialog.getByRole('heading', { name: 'Appearance' })).toBeVisible();

  await expect(dialog.getByRole('button', { name: 'Profile' })).toHaveCount(0);
  await expect(dialog.getByText('Display name')).toBeVisible();
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

test('security section shows passkey-only login (no recovery surface)', async ({ page }) => {
  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByRole('button', { name: 'Security', exact: true }).click();

  await expect(dialog.getByText('Passkey only')).toBeVisible();
  await expect(dialog.getByText('Device unlock')).toHaveCount(0);
  await expect(dialog.getByText('Your passkey (no password)')).toHaveCount(0);
  // The recovery-file / passphrase surface is gone — no restore controls.
  await expect(dialog.getByRole('button', { name: 'Restore on this device' })).toHaveCount(0);
  await expect(dialog.getByText('Recovery passphrase')).toHaveCount(0);
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
  await expect(
    dialog.getByText('Content-free pings only — zero message text reaches the server'),
  ).toBeVisible();

  await dialog.getByRole('button', { name: 'Appearance' }).click();
  await expect(dialog.getByRole('heading', { name: 'Appearance' })).toBeVisible();
  await expect(dialog.getByRole('slider', { name: 'Font size' })).toBeVisible();
  await expect(dialog.getByText('Accent colour')).toBeVisible();

  await dialog.getByRole('button', { name: 'Data & Storage' }).click();
  await expect(dialog.getByRole('heading', { name: 'Data & Storage' })).toBeVisible();
  await expect(dialog.getByText('Encrypted local message cache')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Reset' })).toBeVisible();

  await expect(dialog.getByRole('button', { name: 'Devices' })).toHaveCount(0);
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
  const firstRelease = releaseNotesData[0]!;
  await expect(releaseNotes.getByText(firstRelease.version, { exact: true })).toBeVisible();

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
  // Left/right gutters are exactly symmetric; the bottom gap is within a flex sub-pixel-rounding margin of the
  // sides (the fixed rows above the flex-1 region accumulate fractional heights, so allow ~12px of drift).
  expect(layout.leftMargin).toBe(layout.rightMargin);
  expect(Math.abs(layout.bottomMargin! - layout.leftMargin!)).toBeLessThanOrEqual(12);
  expect(Math.abs(layout.bottomMargin! - layout.rightMargin!)).toBeLessThanOrEqual(12);
  await expect(releaseNotesScrollbar).toHaveClass(/opacity-0/);

  await releaseNotes.hover();
  await page.mouse.wheel(0, 5_000);
  await expect(releaseNotesScrollbar).toHaveClass(/opacity-100/);
  await expect(releaseNotesScrollbar).toHaveClass(/opacity-0/, { timeout: 2_000 });
  // Scrolling reveals the bottom of the list — assert the last line of the last release entry is now visible.
  // A truncated entry renders the neutral overflow note below its groups, so that's the true last line.
  const lastRelease = releaseNotesData[releaseNotesData.length - 1]!;
  const lastGroup = lastRelease.groups[lastRelease.groups.length - 1]!;
  const lastLine = lastRelease.overflowNote ?? lastGroup.items[lastGroup.items.length - 1]!;
  await expect(releaseNotes.getByText(lastLine, { exact: true })).toBeVisible();
});
