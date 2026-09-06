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

test.describe('Jobs', () => {
  test('Queue — GET /jobs requires assetId for a non-admin, then lists items', async ({ request }) => {
    const user = await registerAndLogin(request, 'e2e-jobs-list');
    const noAsset = await request.get(`${API_URL}/jobs`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    expect(noAsset.status()).toBe(403);
  });

  test('Cancel — a freshly-queued job can be cancelled before a worker claims it', async ({ request }) => {
    const admin = await loginSeedAdmin(request);
    const categoryId = await createCategory(request, admin.accessToken, `e2e-cat-jobs-${Date.now()}`);
    const user = await registerAndLogin(request, 'e2e-jobs-cancel');
    const asset = await createAsset(request, user.accessToken, categoryId, 'e2e-jobs-cancel-asset');
    const connectRes = await request.post(`${API_URL}/accounts/connect`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
      data: { assetId: asset.id, provider: 'github', credential: 'e2e-good-credential', displayName: 'E2E' },
    });
    const account = await connectRes.json();

    const syncRes = await request.post(`${API_URL}/accounts/${account.id}/sync`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    const syncJob = await syncRes.json();
    expect(syncJob.status).toBe('QUEUED');

    // Racing the worker pool's JOB_POLL_INTERVAL_MS (2s default) — cancel
    // immediately, before a worker has a realistic chance to claim it.
    const cancelRes = await request.post(`${API_URL}/jobs/${syncJob.jobId}/cancel`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    expect(cancelRes.status()).toBe(200);
    const cancelled = await cancelRes.json();
    expect(cancelled.status).toBe('CANCELLED');

    const doubleCancel = await request.post(`${API_URL}/jobs/${syncJob.jobId}/cancel`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    expect(doubleCancel.status()).toBe(409);
  });

  test('Retry — rejects a job that is not FAILED/DEAD', async ({ request }) => {
    const admin = await loginSeedAdmin(request);
    const categoryId = await createCategory(request, admin.accessToken, `e2e-cat-jobs-retry-${Date.now()}`);
    const user = await registerAndLogin(request, 'e2e-jobs-retry');
    const asset = await createAsset(request, user.accessToken, categoryId, 'e2e-jobs-retry-asset');
    const connectRes = await request.post(`${API_URL}/accounts/connect`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
      data: { assetId: asset.id, provider: 'github', credential: 'e2e-good-credential', displayName: 'E2E' },
    });
    const account = await connectRes.json();
    const syncRes = await request.post(`${API_URL}/accounts/${account.id}/sync`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    const syncJob = await syncRes.json();

    const completed = await pollUntil(
      async () => {
        const r = await request.get(`${API_URL}/jobs/${syncJob.jobId}`, {
          headers: { Authorization: `Bearer ${user.accessToken}` },
        });
        return r.json();
      },
      (j) => j.status === 'COMPLETED' || j.status === 'FAILED' || j.status === 'DEAD',
    );
    expect(completed.status).toBe('COMPLETED');

    // POST /jobs/:id/retry only accepts FAILED/DEAD (job.service.ts) — a
    // COMPLETED job must be rejected, not silently re-queued.
    const retryRes = await request.post(`${API_URL}/jobs/${syncJob.jobId}/retry`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    expect(retryRes.status()).toBe(409);
  });
});
