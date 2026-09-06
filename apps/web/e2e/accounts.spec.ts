import { test, expect } from '@playwright/test';
import { API_URL, loginSeedAdmin, registerAndLogin, createCategory, createAsset } from './helpers';

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  timeoutMs = 15_000,
  intervalMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last!: T;
  do {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  } while (Date.now() < deadline);
  return last;
}

test.describe('Connected Accounts', () => {
  test('Connect → Sync → Discover, against the mock GitHub server', async ({ request }) => {
    const admin = await loginSeedAdmin(request);
    const categoryId = await createCategory(request, admin.accessToken, `e2e-cat-acct-${Date.now()}`);
    const user = await registerAndLogin(request, 'e2e-accounts');
    const asset = await createAsset(request, user.accessToken, categoryId, 'e2e-accounts-asset');

    const connectRes = await request.post(`${API_URL}/accounts/connect`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
      data: {
        assetId: asset.id,
        provider: 'github',
        credential: 'e2e-good-credential',
        displayName: 'E2E GitHub Account',
      },
    });
    expect(connectRes.status()).toBe(201);
    const account = await connectRes.json();
    expect(account.provider).toBe('github');

    const syncRes = await request.post(`${API_URL}/accounts/${account.id}/sync`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    expect(syncRes.status()).toBe(202);
    const syncJob = await syncRes.json();
    expect(syncJob.status).toBe('QUEUED');

    const completedSync = await pollUntil(
      async () => {
        const r = await request.get(`${API_URL}/jobs/${syncJob.jobId}`, {
          headers: { Authorization: `Bearer ${user.accessToken}` },
        });
        return r.json();
      },
      (j) => j.status === 'COMPLETED' || j.status === 'FAILED' || j.status === 'DEAD',
    );
    expect(completedSync.status).toBe('COMPLETED');

    const discoverRes = await request.post(`${API_URL}/accounts/${account.id}/discover`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    expect(discoverRes.status()).toBe(202);
    const discoverJob = await discoverRes.json();

    const completedDiscover = await pollUntil(
      async () => {
        const r = await request.get(`${API_URL}/jobs/${discoverJob.jobId}`, {
          headers: { Authorization: `Bearer ${user.accessToken}` },
        });
        return r.json();
      },
      (j) => j.status === 'COMPLETED' || j.status === 'FAILED' || j.status === 'DEAD',
    );
    expect(completedDiscover.status).toBe('COMPLETED');

    // Discovery should have persisted at least the mock's one repo as a Resource.
    const resourcesRes = await request.get(`${API_URL}/resources?assetId=${asset.id}`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    const resources = await resourcesRes.json();
    expect(resources.items.length).toBeGreaterThan(0);
  });

  test('Sync with a bad credential fails against the mock provider, not silently COMPLETED', async ({ request }) => {
    // POST /accounts/connect stores whatever credential it's given without
    // validating it against the provider (that only happens once a sync/
    // discover job actually runs) — see account.service.ts's `connect()`.
    const admin = await loginSeedAdmin(request);
    const categoryId = await createCategory(request, admin.accessToken, `e2e-cat-acct-bad-${Date.now()}`);
    const user = await registerAndLogin(request, 'e2e-accounts-bad');
    const asset = await createAsset(request, user.accessToken, categoryId, 'e2e-accounts-bad-asset');

    const connectRes = await request.post(`${API_URL}/accounts/connect`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
      data: { assetId: asset.id, provider: 'github', credential: 'totally-wrong', displayName: 'Bad' },
    });
    expect(connectRes.status()).toBe(201);
    const account = await connectRes.json();

    const syncRes = await request.post(`${API_URL}/accounts/${account.id}/sync`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    const syncJob = await syncRes.json();

    const settled = await pollUntil(
      async () => {
        const r = await request.get(`${API_URL}/jobs/${syncJob.jobId}`, {
          headers: { Authorization: `Bearer ${user.accessToken}` },
        });
        return r.json();
      },
      (j) => j.status !== 'QUEUED' && j.status !== 'RUNNING',
    );
    expect(['RETRYING', 'FAILED', 'DEAD']).toContain(settled.status);
  });
});
