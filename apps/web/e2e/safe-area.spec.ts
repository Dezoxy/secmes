import { expect, test } from '@playwright/test';

test('installed PWA status bar uses opaque mode', async ({ page }) => {
  await page.goto('/chat');

  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute(
    'content',
    'black',
  );
});

test('viewport lets iOS own the safe-area strips', async ({ page }) => {
  await page.goto('/chat');

  await expect(page.locator('meta[name="viewport"]')).not.toHaveAttribute(
    'content',
    /viewport-fit=cover/,
  );
});

test('mobile root uses Radarr-style natural document scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/chat');

  const shell = page.getByTestId('app-shell');
  await expect(shell).toBeVisible();

  const metrics = await page.evaluate(() => {
    const root = document.getElementById('root');
    const shell = document.querySelector('[data-testid="app-shell"]');

    return {
      bodyOverflowY: getComputedStyle(document.body).overflowY,
      rootOverflow: root ? getComputedStyle(root).overflow : null,
      shellHeight: shell ? getComputedStyle(shell).height : null,
    };
  });

  expect(metrics.bodyOverflowY).toBe('auto');
  expect(metrics.rootOverflow).toBe('visible');
  expect(metrics.shellHeight).toBe('844px');
});

test('mobile tab header remains in the controlled app pane', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/chat');

  const header = page.locator('.argus-mobile-tab-header');
  await expect(header).toBeVisible();

  const before = await header.boundingBox();
  expect(before).not.toBeNull();

  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(100);

  const after = await header.boundingBox();
  expect(after).not.toBeNull();

  expect(Math.round(after!.top)).toBe(Math.round(before!.top));
  expect(Math.round(after!.height)).toBe(Math.round(before!.height));
});

// Guards the iOS PWA safe-area fixes: the bottom floating nav must reserve only its *measured*
// height as scroll clearance (so the bottom safe-zone is reclaimed as edge-to-edge content rather
// than a fixed dead band), and real content must scroll clear of the floating pills.
test('bottom nav clearance is measured and content clears the floating pills', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings');

  // Open About — its release notes are long enough to scroll past the floating nav.
  await page.getByRole('button', { name: 'About' }).click();
  await expect(page.getByText('Release notes')).toBeVisible();

  // The clearance var is driven by a live measurement (carries a px literal), not the static
  // rem-only fallback declared in :root. If the ResizeObserver hook didn't run, this would read
  // `calc(var(--argus-floating-mobile-bottom) + 5.5rem)` with no px.
  const clearance = await page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue('--argus-floating-mobile-nav-clearance')
      .trim(),
  );
  expect(clearance).toContain('px');

  // Scroll the About section to the very bottom; the last release-note item must sit above the
  // floating pills (cleared), not hidden behind them.
  const scroller = page.locator('[data-settings-section-scroller="true"]');
  await scroller.evaluate((el) => el.scrollTo(0, el.scrollHeight));

  const navTop = await page
    .getByRole('navigation', { name: 'Main navigation' })
    .evaluate((el) => el.getBoundingClientRect().top);
  const lastItemBottom = await scroller
    .locator('article')
    .last()
    .evaluate((el) => el.getBoundingClientRect().bottom);

  expect(lastItemBottom).toBeLessThanOrEqual(navTop);
});

// The resume-repaint workaround must never leave the app dimmed: after a background→resume cycle
// (visibilitychange) the transient #root opacity nudge has to settle back to fully opaque.
test('foreground repaint leaves #root fully opaque', async ({ page }) => {
  await page.goto('/chat');

  const pageshowOpacity = await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pageshow'));
    return document.getElementById('root')?.style.opacity ?? '';
  });
  expect(pageshowOpacity).toBe('0.9999');
  // Allow the two requestAnimationFrame ticks that restore opacity to run.
  await page.waitForTimeout(100);

  const opacity = await page.evaluate(() => document.getElementById('root')?.style.opacity ?? '');
  expect(opacity).toBe('');
});
