import { test, expect } from '@playwright/test';
import { API_URL, registerAndLogin } from './helpers';

test.describe('Authentication', () => {
  // No register UI exists in apps/web (API-only feature, see DECISIONS.md /
  // TODO.md) — exercised via the API directly, same as every apps/api
  // verify:* script.
  test('Register — API', async ({ request }) => {
    const email = `e2e-register-${Date.now()}@example.test`;
    const res = await request.post(`${API_URL}/auth/register`, {
      data: { email, password: 'CorrectHorseBatteryStaple1!', firstName: 'E2E', lastName: 'Register' },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body.email).toBe(email);
    expect(body).not.toHaveProperty('passwordHash');
  });

  test('Login — UI', async ({ page, request }) => {
    const user = await registerAndLogin(request, 'e2e-login-ui');
    await page.goto('/login');
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill('CorrectHorseBatteryStaple1!');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/dashboard/);
    const accessToken = await page.evaluate(() => window.localStorage.getItem('estateai.accessToken'));
    expect(accessToken).toBeTruthy();
  });

  test('Login — wrong password shows an error, does not navigate', async ({ page, request }) => {
    const user = await registerAndLogin(request, 'e2e-login-bad');
    await page.goto('/login');
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill('wrong-password');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page.getByText(/invalid|incorrect|failed/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test('Refresh token — API rotates the token and the old one is rejected on reuse', async ({ request }) => {
    const user = await registerAndLogin(request, 'e2e-refresh');
    const refreshRes = await request.post(`${API_URL}/auth/refresh`, {
      data: { refreshToken: user.refreshToken },
    });
    expect(refreshRes.status()).toBe(200);
    const rotated = await refreshRes.json();
    expect(rotated.refreshToken).not.toBe(user.refreshToken);

    // Reuse detection (Phase 3): presenting an already-rotated-away token
    // again must be rejected, not silently accepted.
    const reuseRes = await request.post(`${API_URL}/auth/refresh`, {
      data: { refreshToken: user.refreshToken },
    });
    expect(reuseRes.status()).toBe(401);
  });

  test('Logout — UI clears the session and redirects to login', async ({ page, request }) => {
    const user = await registerAndLogin(request, 'e2e-logout');
    await page.goto('/login');
    await page.getByLabel('Email').fill(user.email);
    await page.getByLabel('Password').fill('CorrectHorseBatteryStaple1!');
    await page.getByRole('button', { name: /sign in/i }).click();
    await expect(page).toHaveURL(/\/dashboard/);

    await page.getByRole('button', { name: 'User menu' }).click();
    await page.getByRole('menuitem', { name: /log ?out/i }).click();

    await expect(page).toHaveURL(/\/login/);
    const accessToken = await page.evaluate(() => window.localStorage.getItem('estateai.accessToken'));
    expect(accessToken).toBeNull();
  });
});
