// Performance test — Asset CRUD (create, read, update, delete/archive per iteration).
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, adminLoginRaw, authHeaders, authHeadersNoBody } from './helpers.js';

export const options = {
  vus: 20,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  const admin = adminLoginRaw('admin@estateai.local', 'ChangeMe123!');
  const slug = `k6-asset-crud-${Date.now()}`;
  const catRes = http.post(
    `${BASE_URL}/categories`,
    JSON.stringify({ name: slug, slug }),
    authHeaders(admin.accessToken),
  );
  return { categoryId: catRes.json('id') };
}

export default function (data) {
  const email = `k6-crud-${__VU}-${__ITER}-${Date.now()}@example.test`;
  const password = 'CorrectHorseBatteryStaple1!';
  http.post(
    `${BASE_URL}/auth/register`,
    JSON.stringify({ email, password, firstName: 'K6', lastName: 'Crud' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  const login = http
    .post(`${BASE_URL}/auth/login`, JSON.stringify({ email, password }), {
      headers: { 'Content-Type': 'application/json' },
    })
    .json();
  const headers = authHeaders(login.accessToken);

  const createRes = http.post(
    `${BASE_URL}/assets`,
    JSON.stringify({ categoryId: data.categoryId, name: `k6-asset-${__VU}-${__ITER}-${Date.now()}` }),
    headers,
  );
  check(createRes, { 'create: 201': (r) => r.status === 201 });
  const assetId = createRes.json('id');
  if (!assetId) return;

  const getRes = http.get(`${BASE_URL}/assets/${assetId}`, headers);
  check(getRes, { 'read: 200': (r) => r.status === 200 });

  const patchRes = http.patch(
    `${BASE_URL}/assets/${assetId}`,
    JSON.stringify({ displayName: 'k6-updated' }),
    headers,
  );
  check(patchRes, { 'update: 200': (r) => r.status === 200 });

  const delRes = http.del(`${BASE_URL}/assets/${assetId}`, null, authHeadersNoBody(login.accessToken));
  check(delRes, { 'delete: 200': (r) => r.status === 200 });
}
