// Load test — mixed realistic workload (login, list assets, search
// resources) at a configurable VU tier. Run three times per Phase 15's
// spec (100/250/500 VUs):
//
//   K6_VUS=100 k6 run k6/load-test.js
//   K6_VUS=250 k6 run k6/load-test.js
//   K6_VUS=500 k6 run k6/load-test.js
//
// setup() pre-registers one user per target VU (register is a one-time,
// bcrypt-cost-12 hash — expensive — cost, deliberately paid once outside
// the measured window, not per-iteration) so the actual measured load is
// realistic "already-logged-in user browsing," not registration throughput.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, adminLoginRaw, authHeaders } from './helpers.js';

const TARGET_VUS = parseInt(__ENV.K6_VUS || '100', 10);
const PASSWORD = 'CorrectHorseBatteryStaple1!';

export const options = {
  setupTimeout: '5m',
  scenarios: {
    mixed_browsing: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '15s', target: TARGET_VUS },
        { duration: '30s', target: TARGET_VUS },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1000', 'p(99)<2000'],
    http_req_failed: ['rate<0.05'],
  },
};

export function setup() {
  const admin = adminLoginRaw('admin@estateai.local', 'ChangeMe123!');
  const slug = `k6-load-${Date.now()}`;
  const catRes = http.post(
    `${BASE_URL}/categories`,
    JSON.stringify({ name: slug, slug }),
    authHeaders(admin.accessToken),
  );
  const categoryId = catRes.json('id');

  const users = [];
  for (let i = 0; i < TARGET_VUS; i += 1) {
    const email = `k6-load-${i}-${Date.now()}@example.test`;
    http.post(
      `${BASE_URL}/auth/register`,
      JSON.stringify({ email, password: PASSWORD, firstName: 'K6', lastName: 'Load' }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    users.push(email);
  }
  return { users, categoryId };
}

export default function (data) {
  const email = data.users[__VU % data.users.length];
  const login = http
    .post(`${BASE_URL}/auth/login`, JSON.stringify({ email, password: PASSWORD }), {
      headers: { 'Content-Type': 'application/json' },
    })
    .json();
  if (!login.accessToken) return;
  const headers = authHeaders(login.accessToken);

  const listRes = http.get(`${BASE_URL}/assets?limit=20`, headers);
  check(listRes, { 'list assets: 200': (r) => r.status === 200 });

  const createRes = http.post(
    `${BASE_URL}/assets`,
    JSON.stringify({ categoryId: data.categoryId, name: `k6-load-asset-${__VU}-${__ITER}-${Date.now()}` }),
    headers,
  );
  check(createRes, { 'create asset: 201': (r) => r.status === 201 });

  sleep(0.2);
}
