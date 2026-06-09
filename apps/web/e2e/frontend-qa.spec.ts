import { expect, test, type Page } from '@playwright/test';

const routeShells = [
  { path: '/settings', heading: 'Account settings', marker: 'Settings sections' },
  { path: '/security', heading: 'Security & recovery', marker: 'Recovery remains embedded' },
  { path: '/devices', heading: 'Trusted devices', marker: 'Device management shell' },
  { path: '/storage', heading: 'Data & storage', marker: 'Encrypted local state only' },
];

function collectPageIssues(page: Page): Array<string> {
  const issues: Array<string> = [];

  page.on('console', (message) => {
    if (message.type() === 'error') issues.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    issues.push(`pageerror: ${error.message}`);
  });

  return issues;
}

async function expectComposerAligned(page: Page): Promise<void> {
  const actionsBox = await page.getByRole('button', { name: 'Open message actions' }).boundingBox();
  const messageBox = await page.getByRole('textbox', { name: 'Message' }).boundingBox();
  const sendBox = await page.getByRole('button', { name: 'Send message' }).boundingBox();

  expect(actionsBox).not.toBeNull();
  expect(messageBox).not.toBeNull();
  expect(sendBox).not.toBeNull();

  const centers = [actionsBox!, messageBox!, sendBox!].map((box) => box.y + box.height / 2);
  expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(4);
}

test('F1C desktop chat and composer QA flow stays usable', async ({ page }) => {
  const issues = collectPageIssues(page);

  await page.goto('/chat');

  await expect(page.getByRole('main', { name: 'Chat' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Conversations' })).toBeVisible();
  await expect(page.getByText('Sarah Chen').first()).toBeVisible();
  await expectComposerAligned(page);

  const message = `F1C composer smoke ${Date.now()}`;
  await page.getByRole('textbox', { name: 'Message' }).fill(message);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  await page.getByRole('button', { name: 'Send message' }).click();

  await expect(
    page.getByRole('region', { name: 'Message thread' }).getByText(message),
  ).toBeVisible();
  expect(issues).toEqual([]);
});

test('F1C mobile settings and profile QA flow stays navigable', async ({ page }) => {
  const issues = collectPageIssues(page);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('/chat');
  await page.getByRole('button', { name: 'Open settings' }).click();

  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog.getByRole('heading', { name: 'Settings' })).toBeVisible();

  const profileSection = dialog.getByRole('button', { name: 'Profile' });
  await expect(profileSection).toHaveAttribute('aria-current', 'page');

  await profileSection.click();
  await expect(dialog.getByRole('region', { name: 'Profile settings' })).toBeFocused();
  await expect(dialog.getByLabel('Username')).toBeVisible();
  await expect(dialog.getByText('Upload avatar')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Generate' })).toBeVisible();

  await dialog.getByRole('button', { name: 'Back to settings menu' }).click();
  await expect(profileSection).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Appearance' })).toBeVisible();
  expect(issues).toEqual([]);
});

test('F1C route shells render on desktop and mobile widths', async ({ page }) => {
  const issues = collectPageIssues(page);

  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);

    for (const route of routeShells) {
      await page.goto(route.path);

      await expect(page.getByLabel('Open chat')).toBeVisible();
      await expect(page.getByRole('heading', { name: route.heading })).toBeVisible();
      await expect(page.getByText(route.marker)).toBeVisible();
      await expect(page.getByRole('link', { name: 'Chat', exact: true })).toBeVisible();
    }
  }

  expect(issues).toEqual([]);
});
