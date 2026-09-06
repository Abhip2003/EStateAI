import { test, expect } from '@playwright/test';
import { API_URL, loginSeedAdmin, registerAndLogin } from './helpers';

// Categories/Tags have no dedicated management UI in apps/web (no
// PATCH/DELETE routes exist server-side either — GET+POST only, see
// TODO.md), so "CRUD" here covers exactly what the API actually exposes.
test.describe('Categories', () => {
  test('Create (admin-gated) + List', async ({ request }) => {
    const admin = await loginSeedAdmin(request);
    const user = await registerAndLogin(request, 'e2e-cat-nonadmin');

    const forbiddenName = `e2e-forbidden-${Date.now()}`;
    const forbidden = await request.post(`${API_URL}/categories`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
      data: { name: forbiddenName, slug: forbiddenName },
    });
    expect(forbidden.status()).toBe(403);

    const name = `e2e-category-${Date.now()}`;
    const created = await request.post(`${API_URL}/categories`, {
      headers: { Authorization: `Bearer ${admin.accessToken}` },
      data: { name, slug: name },
    });
    expect(created.status()).toBe(201);
    const body = await created.json();
    expect(body.name).toBe(name);

    const listed = await request.get(`${API_URL}/categories?limit=100`, {
      headers: { Authorization: `Bearer ${admin.accessToken}` },
    });
    expect(listed.status()).toBe(200);
    const listBody = await listed.json();
    expect(listBody.items.some((c: { id: string }) => c.id === body.id)).toBe(true);
  });
});

test.describe('Tags', () => {
  test('Create + List', async ({ request }) => {
    const user = await registerAndLogin(request, 'e2e-tags');
    const name = `e2e-tag-${Date.now()}`;
    const created = await request.post(`${API_URL}/tags`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
      data: { name },
    });
    expect(created.status()).toBe(201);
    const body = await created.json();
    expect(body.name).toBe(name);

    const listed = await request.get(`${API_URL}/tags?limit=100`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    expect(listed.status()).toBe(200);
    const listBody = await listed.json();
    expect(listBody.items.some((t: { id: string }) => t.id === body.id)).toBe(true);
  });
});
