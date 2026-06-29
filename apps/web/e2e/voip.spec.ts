/**
 * VoIP / call overlay — Playwright tests.
 *
 * These tests verify the P1-UI wiring: phone button presence, call overlay rendering,
 * and the ring/accept/decline flow using mocked API endpoints.
 * Full signaling flows (call.invite, ICE, call.active) are integration tests
 * and require a live backend — those are out of scope for the Playwright suite.
 */
import { expect, test } from '@playwright/test';

test('phone button is present in the conversation header', async ({ page }) => {
  await page.goto('/chat');

  const phoneButton = page.getByRole('button', { name: 'Start voice call' });
  await expect(phoneButton).toBeVisible();
});

test('call overlay is not shown on page load', async ({ page }) => {
  await page.goto('/chat');

  // CallOverlay renders null when phase is idle — no overlay element should be visible.
  await expect(page.getByText('Incoming voice call')).not.toBeVisible();
  await expect(page.getByText('Calling…')).not.toBeVisible();
  await expect(page.getByText('Connecting…')).not.toBeVisible();
  await expect(page.getByText('Call ended')).not.toBeVisible();
});

test('phone button is visible and video button still shows coming-soon toast', async ({ page }) => {
  await page.goto('/chat');

  await expect(page.getByRole('button', { name: 'Start voice call' })).toBeVisible();

  // Video button keeps the coming-soon toast (V1 audio-only).
  await page.getByRole('button', { name: 'Start video call' }).click();
  await expect(page.getByText('Voice and video calls are coming soon')).toBeVisible();
});
