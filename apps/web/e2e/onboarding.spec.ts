import { expect, test } from '@playwright/test';

/**
 * Onboarding and invite route smoke tests.
 *
 * E2E runs in demo mode (VITE_OIDC_* unset): OnboardingGate always passes through
 * (configured=false), so these tests cover the route rendering and redirect behaviour
 * rather than the gate UI itself. Gate UI is tested manually against a real OIDC stack.
 */

test('invite route in demo mode redirects to chat', async ({ page }) => {
  // In demo mode (configured=false), InviteRoute immediately navigates to /chat.
  await page.goto('/invite#sometoken123');
  await expect(page).toHaveURL(/\/chat/);
});

test('invite route without a token still redirects to chat in demo mode', async ({ page }) => {
  await page.goto('/invite');
  await expect(page).toHaveURL(/\/chat/);
});

test('invite route does not crash on navigation', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('/invite#abc123def456');
  expect(errors).toHaveLength(0);
});
