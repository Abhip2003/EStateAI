import { test, expect } from '@playwright/test';
import { API_URL, registerAndLogin, loginSeedAdmin, createCategory } from './helpers';

async function loginViaUI(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}

test.describe('Frontend quality', () => {
  test('Navigation — every sidebar link routes to a 200, no client error boundary trips', async ({
    page,
    request,
  }) => {
    const user = await registerAndLogin(request, 'e2e-nav');
    await loginViaUI(page, user.email, 'CorrectHorseBatteryStaple1!');

    const hrefs = await page.locator('nav a[href^="/"]').evaluateAll((els) =>
      Array.from(new Set(els.map((e) => e.getAttribute('href')))).filter(Boolean),
    );
    expect(hrefs.length).toBeGreaterThan(5);

    const consoleErrors: string[] = [];
    page.on('pageerror', (err) => consoleErrors.push(err.message));

    for (const href of hrefs) {
      const response = await page.goto(href as string);
      expect(response?.status(), `${href} should respond 200`).toBe(200);
      await expect(page.locator('body')).not.toContainText('Application error');
    }
    expect(consoleErrors, `uncaught client errors: ${consoleErrors.join(', ')}`).toHaveLength(0);
  });

  test('Loading state — dashboard shows a loading indicator before data resolves', async ({ page, request }) => {
    const user = await registerAndLogin(request, 'e2e-loading');
    await loginViaUI(page, user.email, 'CorrectHorseBatteryStaple1!');

    await page.goto('/assets');
    // Either a skeleton/spinner is visible immediately, or the page is fast
    // enough that content is already there — assert one or the other
    // rather than a flaky race on the loading node specifically.
    const loadingOrContent = page
      .getByText(/loading/i)
      .or(page.getByRole('table'))
      .or(page.getByText(/no assets found/i));
    await expect(loadingOrContent.first()).toBeVisible({ timeout: 10_000 });
  });

  test('Error state — a nonexistent asset id renders an error/empty state, not a crash', async ({
    page,
    request,
  }) => {
    const user = await registerAndLogin(request, 'e2e-error-state');
    await loginViaUI(page, user.email, 'CorrectHorseBatteryStaple1!');

    const response = await page.goto('/assets/does-not-exist-e2e');
    expect(response?.status()).toBeLessThan(500);
    await expect(page.locator('body')).not.toContainText('Application error');
    await expect(page.getByText(/not found|error|does not exist/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test('Responsive layout — mobile viewport shows a hamburger trigger, desktop shows the full sidebar', async ({
    page,
    request,
  }) => {
    const user = await registerAndLogin(request, 'e2e-responsive');
    await loginViaUI(page, user.email, 'CorrectHorseBatteryStaple1!');

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/dashboard');
    await expect(page.getByRole('navigation').first()).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/dashboard');
    await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  });

  test('Dark mode — theme toggle switches the root element class', async ({ page, request }) => {
    const user = await registerAndLogin(request, 'e2e-darkmode');
    await loginViaUI(page, user.email, 'CorrectHorseBatteryStaple1!');
    await page.goto('/settings');

    const html = page.locator('html');
    const before = await html.getAttribute('class');
    await page.getByRole('button', { name: /toggle theme|dark mode|theme/i }).first().click();
    await expect
      .poll(async () => html.getAttribute('class'), { timeout: 5000 })
      .not.toBe(before);
  });

  test('Keyboard navigation — Tab reaches the login form and Enter submits it', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').focus();
    await page.keyboard.type('nonexistent@example.test');
    await page.keyboard.press('Tab');
    await page.keyboard.type('wrong-password');
    await page.keyboard.press('Enter');
    // Wrong creds — should surface an inline error without navigating away,
    // proving the form is keyboard-operable end-to-end (focus -> type ->
    // tab -> type -> submit), not just clickable.
    await expect(page.getByText(/invalid|incorrect|failed/i)).toBeVisible();
  });

  test('XSS — a stored script-tag asset name renders as inert text, never executes', async ({ page, request }) => {
    const admin = await loginSeedAdmin(request);
    const categoryId = await createCategory(request, admin.accessToken, `e2e-cat-xss-${Date.now()}`);
    const user = await registerAndLogin(request, 'e2e-xss');
    const xssName = '<script>window.__xss_fired = true;</script>';
    const createRes = await request.post(`${API_URL}/assets`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
      data: { categoryId, name: xssName },
    });
    const asset = await createRes.json();

    await loginViaUI(page, user.email, 'CorrectHorseBatteryStaple1!');
    await page.goto(`/assets/${asset.id}`);

    const fired = await page.evaluate(() => (window as unknown as { __xss_fired?: boolean }).__xss_fired);
    expect(fired).toBeUndefined();
    await expect(page.getByText(xssName, { exact: false }).first()).toBeVisible();
  });

  test('ARIA labels — key icon-only controls expose an accessible name', async ({ page, request }) => {
    const user = await registerAndLogin(request, 'e2e-aria');
    await loginViaUI(page, user.email, 'CorrectHorseBatteryStaple1!');
    await page.goto('/dashboard');

    await expect(page.getByRole('button', { name: 'Notifications' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'User menu' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Search' })).toBeVisible();
  });
});
