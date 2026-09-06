// Performance test — Copilot (POST /copilot/chat, against the mock Claude
// server, mirroring /ai/generate's chokepoint per API_REFERENCE.md).
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, adminLoginRaw, authHeaders } from './helpers.js';

export const options = {
  vus: 5,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<3000'],
    http_req_failed: ['rate<0.05'],
  },
};

export function setup() {
  const admin = adminLoginRaw('admin@estateai.local', 'ChangeMe123!');
  const slug = `k6-copilot-${Date.now()}`;
  const catRes = http.post(
    `${BASE_URL}/categories`,
    JSON.stringify({ name: slug, slug }),
    authHeaders(admin.accessToken),
  );
  return { categoryId: catRes.json('id') };
}

export default function (data) {
  const email = `k6-copilot-${__VU}-${__ITER}-${Date.now()}@example.test`;
  const password = 'CorrectHorseBatteryStaple1!';
  http.post(
    `${BASE_URL}/auth/register`,
    JSON.stringify({ email, password, firstName: 'K6', lastName: 'Copilot' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  const login = http
    .post(`${BASE_URL}/auth/login`, JSON.stringify({ email, password }), {
      headers: { 'Content-Type': 'application/json' },
    })
    .json();
  const headers = authHeaders(login.accessToken);
  const asset = http
    .post(
      `${BASE_URL}/assets`,
      JSON.stringify({ categoryId: data.categoryId, name: `k6-copilot-asset-${__VU}-${__ITER}` }),
      headers,
    )
    .json();

  const res = http.post(
    `${BASE_URL}/copilot/chat`,
    JSON.stringify({ assetId: asset.id, message: 'What is the current risk level of this asset?' }),
    headers,
  );
  check(res, {
    'status is 200': (r) => r.status === 200,
    'status is SUCCESS': (r) => r.json('status') === 'SUCCESS',
  });
}
