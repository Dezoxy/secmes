import { expect, test } from '@playwright/test';

const routeShells = [
  { path: '/security', heading: 'Security', marker: 'Unlocked by your passkey' },
  { path: '/devices', heading: 'Trusted devices', marker: 'Current device' },
  { path: '/storage', heading: 'Data & storage', marker: 'Encrypted local state only' },
];

for (const route of routeShells) {
  test(`${route.path} renders a guarded product route shell`, async ({ page }) => {
    await page.goto(route.path);

    await expect(page.getByLabel('Open chat')).toBeVisible();
    await expect(page.getByRole('heading', { name: route.heading })).toBeVisible();
    await expect(page.getByText(route.marker)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Chat', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Go back' })).toBeVisible();
  });
}

test('/devices does not leave the page on mobile tab-swipe gestures', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/devices');
  await expect(page.getByRole('heading', { name: 'Trusted devices' })).toBeVisible();

  await page.evaluate(() => {
    const target = document.querySelector('[data-testid="app-shell"] > div');
    if (!target) throw new Error('missing app shell content');

    const touch = (x: number, y: number) =>
      new Touch({
        identifier: 1,
        target,
        clientX: x,
        clientY: y,
        pageX: x,
        pageY: y,
        screenX: x,
        screenY: y,
      });

    const start = touch(260, 360);
    target.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        cancelable: true,
        touches: [start],
        targetTouches: [start],
        changedTouches: [start],
      }),
    );

    const end = touch(120, 360);
    target.dispatchEvent(
      new TouchEvent('touchend', {
        bubbles: true,
        cancelable: true,
        touches: [],
        targetTouches: [],
        changedTouches: [end],
      }),
    );
  });

  await expect(page).toHaveURL(/\/devices$/);
});

test('the route shell back button steps back through in-app history', async ({ page }) => {
  await page.goto('/security');
  // In-app navigation (PUSH) to another shell so there is genuine Argus history to return to.
  await page.getByRole('link', { name: 'Devices', exact: true }).click();
  await expect(page).toHaveURL(/\/devices$/);
  await expect(page.getByRole('heading', { name: 'Trusted devices' })).toBeVisible();

  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(page).toHaveURL(/\/security$/);

  // The shell link state must not leak into a later direct route load; otherwise the next "deep link"
  // back action would incorrectly step through old browser history instead of returning to Chat.
  await page.goto('/storage');
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(page).toHaveURL(/\/chat$/);
});

test('the route shell link state is cleared after browser back between shell routes', async ({
  page,
}) => {
  await page.goto('/security');
  await page.getByRole('link', { name: 'Devices', exact: true }).click();
  await expect(page).toHaveURL(/\/devices$/);

  await page.goBack();
  await expect(page).toHaveURL(/\/security$/);

  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(page).toHaveURL(/\/chat$/);
});

test('the route shell back button falls back to chat on a deep link with no in-app history', async ({
  page,
}) => {
  // Direct load → React Router's first location has key "default", so there is nowhere in-app to go
  // back to. Smart back must land on /chat rather than navigating off-site.
  await page.goto('/security');
  await page.getByRole('button', { name: 'Go back' }).click();
  await expect(page).toHaveURL(/\/chat$/);

  // The fallback replaces the deep-link entry, so browser Back must not bounce back into /security.
  await page.goBack();
  await expect(page).not.toHaveURL(/\/security/);
});

test('/transparency renders the public security page without auth', async ({ page }) => {
  await page.goto('/transparency');

  await expect(page.getByRole('main', { name: 'Security and transparency' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Security & Transparency' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'End-to-end encryption' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bundle integrity' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /sub-processors/i })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Microsoft Azure' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Backblaze B2' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Argus', exact: true })).toBeVisible();
});
