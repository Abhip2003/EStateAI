// Performance test — Discovery (connect + discover, against the mock
// GitHub server started via apps/web/e2e/mock-providers.mjs — must be
// running on :3999 before this script runs).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, adminLoginRaw, authHeaders, authHeadersNoBody } from './helpers.js';

export const options = {
  vus: 10,
  duration: '30s',
  thresholds: {
    http_req_failed: ['rate<0.05'],
  },
};

export function setup() {
  const admin = adminLoginRaw('admin@estateai.local', 'ChangeMe123!');
  const slug = `k6-discovery-${Date.now()}`;
  const catRes = http.post(
    `${BASE_URL}/categories`,
    JSON.stringify({ name: slug, slug }),
    authHeaders(admin.accessToken),
  );
  return { categoryId: catRes.json('id') };
}

export default function (data) {
  const email = `k6-disc-${__VU}-${__ITER}-${Date.now()}@example.test`;
  const password = 'CorrectHorseBatteryStaple1!';
  http.post(
    `${BASE_URL}/auth/register`,
    JSON.stringify({ email, password, firstName: 'K6', lastName: 'Disc' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  const login = http
    .post(`${BASE_URL}/auth/login`, JSON.stringify({ email, password }), {
      headers: { 'Content-Type': 'application/json' },
    })
    .json();
  const headers = authHeaders(login.accessToken);

  const assetRes = http
    .post(
      `${BASE_URL}/assets`,
      JSON.stringify({ categoryId: data.categoryId, name: `k6-disc-asset-${__VU}-${__ITER}` }),
      headers,
    )
    .json();

  const connectRes = http.post(
    `${BASE_URL}/accounts/connect`,
    JSON.stringify({
      assetId: assetRes.id,
      provider: 'github',
      credential: 'e2e-good-credential',
      displayName: 'K6 perf account',
    }),
    headers,
  );
  check(connectRes, { 'connect: 201': (r) => r.status === 201 });
  const account = connectRes.json();

  const discoverRes = http.post(`${BASE_URL}/accounts/${account.id}/discover`, null, authHeadersNoBody(login.accessToken));
  check(discoverRes, { 'discover enqueue: 202': (r) => r.status === 202 });
  const jobId = discoverRes.json('jobId');

  for (let i = 0; i < 20 && jobId; i += 1) {
    const jobRes = http.get(`${BASE_URL}/jobs/${jobId}`, headers).json();
    if (jobRes.status === 'COMPLETED' || jobRes.status === 'FAILED' || jobRes.status === 'DEAD') {
      check(jobRes, { 'discovery job settled COMPLETED': (r) => r.status === 'COMPLETED' });
      break;
    }
    sleep(0.5);
  }
}
