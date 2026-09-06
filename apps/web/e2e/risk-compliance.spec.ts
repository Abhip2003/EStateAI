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

test.describe('Risk Analysis', () => {
  test('Generate Risk — score for an asset', async ({ request }) => {
    const { user, asset } = await discoveredAsset(request, 'risk');
    const res = await request.get(`${API_URL}/analysis/risk/assets/${asset.id}`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    // {risk: RiskScore | null} — null only if no discovery has run yet for
    // this scope, which shouldn't be the case here since discoveredAsset()
    // always runs one first.
    expect(body.risk).not.toBeNull();
    expect(typeof body.risk.overallScore).toBe('number');
    expect(body.risk.overallScore).toBeGreaterThanOrEqual(0);
    expect(body.risk.overallScore).toBeLessThanOrEqual(100);
  });

  test('Dashboard — admin-only platform-wide overview requires ADMIN role', async ({ request }) => {
    const admin = await loginSeedAdmin(request);
    const user = await registerAndLogin(request, 'e2e-risk-dash-nonadmin');

    const forbidden = await request.get(`${API_URL}/analysis/risk`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    expect(forbidden.status()).toBe(403);

    const allowed = await request.get(`${API_URL}/analysis/risk`, {
      headers: { Authorization: `Bearer ${admin.accessToken}` },
    });
    expect(allowed.status()).toBe(200);
  });
});

test.describe('Compliance', () => {
  test('Compliance report for an asset', async ({ request }) => {
    const { user, asset } = await discoveredAsset(request, 'compliance');
    const res = await request.get(`${API_URL}/compliance/assets/${asset.id}`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(typeof body.complianceScore).toBe('number');
    expect(Array.isArray(body.policyFailures)).toBe(true);
    expect(Array.isArray(body.policyPasses)).toBe(true);
  });
});
