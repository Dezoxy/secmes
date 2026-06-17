import { expect, test } from '@playwright/test';

test('auth entry stays passkey-first without app-owned password fields', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Welcome to Argus' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with passkey' })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /google|apple|password/i })).toHaveCount(0);
});

test('invite code entry point is visible on the landing page', async ({ page }) => {
  await page.goto('/');

  // Invite-code panel is toggled inline. Admin access is NOT on the landing page anymore — it lives on a
  // separate /admin route gated by Cloudflare Access in production.
  await expect(page.getByRole('button', { name: /invite code/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /admin access/i })).toHaveCount(0);

  // Clicking "invite code" reveals the invite-code panel and hides the passkey button.
  await page.getByRole('button', { name: /invite code/i }).click();
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue with passkey' })).not.toBeVisible();

  // Back button restores the main landing.
  await page.getByRole('button', { name: /back to sign in/i }).click();
  await expect(page.getByRole('button', { name: 'Continue with passkey' })).toBeVisible();
});

test('admin login lives on its own /admin route, not the public landing', async ({ page }) => {
  // In dev/CI there is no Cloudflare Access in front, so the route renders directly. In production Caddy
  // returns 404 for /admin unless the Access header is present.
  await page.goto('/admin');

  await expect(page.getByRole('heading', { name: 'Admin access' })).toBeVisible();
  await expect(page.getByLabel('Username')).toBeVisible();
  await expect(page.getByLabel('Password')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();

  // Back returns to the public landing.
  await page.getByRole('button', { name: /back to sign in/i }).click();
  await expect(page.getByRole('button', { name: 'Continue with passkey' })).toBeVisible();
});

test('auth entry stays portrait and centered on wide screens', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');

  const main = page.getByRole('main', { name: 'Argus sign-in' });
  const card = page.getByRole('region', { name: 'Passkey sign-in' });
  const brand = main.getByRole('group', { name: 'Argus brand' });
  const heading = page.getByRole('heading', { name: 'Welcome to Argus' });

  await expect(card).toBeVisible();
  await expect(brand).toBeVisible();
  await expect(heading).toBeVisible();

  const cardBox = await card.boundingBox();
  const brandBox = await brand.boundingBox();
  const headingBox = await heading.boundingBox();

  expect(cardBox).not.toBeNull();
  expect(brandBox).not.toBeNull();
  expect(headingBox).not.toBeNull();
  if (!cardBox || !brandBox || !headingBox) return;

  expect(cardBox.width).toBeLessThanOrEqual(462);
  expect(cardBox.height).toBeGreaterThan(cardBox.width);

  const cardCenter = cardBox.x + cardBox.width / 2;
  const brandCenter = brandBox.x + brandBox.width / 2;
  const headingCenter = headingBox.x + headingBox.width / 2;

  expect(Math.abs(cardCenter - brandCenter)).toBeLessThanOrEqual(24);
  expect(Math.abs(cardCenter - headingCenter)).toBeLessThanOrEqual(8);
});
