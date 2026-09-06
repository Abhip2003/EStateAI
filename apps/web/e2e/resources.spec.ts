import { test, expect } from '@playwright/test';
import { API_URL, loginSeedAdmin, registerAndLogin, createCategory, createAsset } from './helpers';

async function pollUntil<T>(fn: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last!: T;
  do {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, 500));
  } while (Date.now() < deadline);
  return last;
}

async function discoveredAsset(request: import('@playwright/test').APIRequestContext, label: string) {
  const admin = await loginSeedAdmin(request);
  const categoryId = await createCategory(request, admin.accessToken, `e2e-cat-${label}-${Date.now()}`);
  const user = await registerAndLogin(request, `e2e-${label}`);
  const asset = await createAsset(request, user.accessToken, categoryId, `e2e-${label}-asset`);
  const connectRes = await request.post(`${API_URL}/accounts/connect`, {
    headers: { Authorization: `Bearer ${user.accessToken}` },
    data: { assetId: asset.id, provider: 'github', credential: 'e2e-good-credential', displayName: 'E2E' },
  });
  const account = await connectRes.json();
  const discoverRes = await request.post(`${API_URL}/accounts/${account.id}/discover`, {
    headers: { Authorization: `Bearer ${user.accessToken}` },
  });
  const job = await discoverRes.json();
  await pollUntil(async () => {
    const r = await request.get(`${API_URL}/jobs/${job.jobId}`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    return r.json();
  }, (j) => j.status === 'COMPLETED' || j.status === 'FAILED' || j.status === 'DEAD');
  return { user, asset };
}

test.describe('Resources', () => {
  test('Search — filter by name', async ({ request }) => {
    const { user, asset } = await discoveredAsset(request, 'resources-search');

    const listRes = await request.get(`${API_URL}/resources?assetId=${asset.id}`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    const list = await listRes.json();
    expect(list.items.length).toBeGreaterThan(0);

    const target = list.items[0];
    const searchRes = await request.get(
      `${API_URL}/resources?assetId=${asset.id}&name=${encodeURIComponent(target.displayName.slice(0, 5))}`,
      { headers: { Authorization: `Bearer ${user.accessToken}` } },
    );
    expect(searchRes.status()).toBe(200);
    const searched = await searchRes.json();
    expect(searched.items.some((r: { id: string }) => r.id === target.id)).toBe(true);
  });

  test('Relationships — neighbors endpoint responds for a discovered resource', async ({ request }) => {
    const { user, asset } = await discoveredAsset(request, 'resources-rel');
    const listRes = await request.get(`${API_URL}/resources?assetId=${asset.id}`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    const list = await listRes.json();
    const target = list.items[0];

    const neighborsRes = await request.get(`${API_URL}/resources/${target.id}/neighbors`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    expect(neighborsRes.status()).toBe(200);
    const neighbors = await neighborsRes.json();
    expect(Array.isArray(neighbors.items)).toBe(true);
  });
});
