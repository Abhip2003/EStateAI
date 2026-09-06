// Performance test — Resources (search, against pre-discovered data seeded in setup()).
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, adminLoginRaw, authHeaders, authHeadersNoBody } from './helpers.js';

export const options = {
  vus: 30,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  const admin = adminLoginRaw('admin@estateai.local', 'ChangeMe123!');
  const slug = `k6-resources-${Date.now()}`;
  const catRes = http.post(
    `${BASE_URL}/categories`,
    JSON.stringify({ name: slug, slug }),
    authHeaders(admin.accessToken),
  );
  const categoryId = catRes.json('id');

  const email = `k6-resources-setup-${Date.now()}@example.test`;
  const password = 'CorrectHorseBatteryStaple1!';
  http.post(
    `${BASE_URL}/auth/register`,
    JSON.stringify({ email, password, firstName: 'K6', lastName: 'ResSetup' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  const login = http
    .post(`${BASE_URL}/auth/login`, JSON.stringify({ email, password }), {
      headers: { 'Content-Type': 'application/json' },
    })
    .json();
  const headers = authHeaders(login.accessToken);
  const asset = http
    .post(`${BASE_URL}/assets`, JSON.stringify({ categoryId, name: 'k6-resources-asset' }), headers)
    .json();
  const account = http
    .post(
      `${BASE_URL}/accounts/connect`,
      JSON.stringify({
        assetId: asset.id,
        provider: 'github',
        credential: 'e2e-good-credential',
        displayName: 'K6 resources account',
      }),
      headers,
    )
    .json();
  const discover = http.post(`${BASE_URL}/accounts/${account.id}/discover`, null, authHeadersNoBody(login.accessToken)).json();
  for (let i = 0; i < 20; i += 1) {
    const jobRes = http.get(`${BASE_URL}/jobs/${discover.jobId}`, headers).json();
    if (jobRes.status === 'COMPLETED' || jobRes.status === 'FAILED') break;
  }

  return { token: login.accessToken, assetId: asset.id };
}

export default function (data) {
  const headers = authHeaders(data.token);
  const res = http.get(`${BASE_URL}/resources?assetId=${data.assetId}&limit=50`, headers);
  check(res, { 'status is 200': (r) => r.status === 200 });
}
