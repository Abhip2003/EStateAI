import { test, expect } from '@playwright/test';
import { API_URL, registerAndLogin, loginSeedAdmin, createCategory } from './helpers';

test.describe('Assets', () => {
  test('Create — UI', async ({ page, request }) => {
    const admin = await loginSeedAdmin(request);
    const categoryId = await createCategory(request, admin.accessToken, `e2e-cat-${Date.now()}`);
    const user = await registerAndLogin(request, 'e2e-asset-create');

    await page.addInitScript(
      ([accessToken, refreshToken]) => {
        window.localStorage.setItem('estateai.accessToken', accessToken);
        window.localStorage.setItem('estateai.refreshToken', refreshToken);
      },
      [user.accessToken, user.refreshToken],
    );

    await page.goto('/assets');
    await page.getByRole('button', { name: /new asset/i }).click();

    const assetName = `e2e-ui-asset-${Date.now()}`;
    await page.getByLabel('Name').fill(assetName);
    await page.getByLabel('Category').selectOption(categoryId);
    await page.getByRole('button', { name: /^create asset$/i }).click();

    await expect(page.getByRole('link', { name: assetName })).toBeVisible({ timeout: 10_000 });
  });

  // No PATCH/DELETE affordance exists in apps/web's UI for assets (see
  // TODO.md) — both routes are exercised directly against the API, same as
  // Update/Delete for every other domain this suite covers that also lacks
  // dedicated UI.
  test('Update — API', async ({ request }) => {
    const admin = await loginSeedAdmin(request);
    const categoryId = await createCategory(request, admin.accessToken, `e2e-cat-upd-${Date.now()}`);
    const user = await registerAndLogin(request, 'e2e-asset-update');
    const createRes = await request.post(`${API_URL}/assets`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
      data: { categoryId, name: `e2e-asset-${Date.now()}` },
    });
    const asset = await createRes.json();

    const updateRes = await request.patch(`${API_URL}/assets/${asset.id}`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
      data: { displayName: 'Updated Display Name' },
    });
    expect(updateRes.status()).toBe(200);
    const updated = await updateRes.json();
    expect(updated.displayName).toBe('Updated Display Name');
  });

  test('Delete (archive) — API', async ({ request }) => {
    const admin = await loginSeedAdmin(request);
    const categoryId = await createCategory(request, admin.accessToken, `e2e-cat-del-${Date.now()}`);
    const user = await registerAndLogin(request, 'e2e-asset-delete');
    const createRes = await request.post(`${API_URL}/assets`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
      data: { categoryId, name: `e2e-asset-${Date.now()}` },
    });
    const asset = await createRes.json();

    const deleteRes = await request.delete(`${API_URL}/assets/${asset.id}`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    expect(deleteRes.status()).toBe(200);

    const getRes = await request.get(`${API_URL}/assets/${asset.id}`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    const got = await getRes.json();
    expect(got.status).toBe('ARCHIVED');
  });
});
