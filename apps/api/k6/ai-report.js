// Performance test — AI Report (POST /ai/generate against the mock Claude
// server — apps/web/e2e/mock-providers.mjs must be running on :3998).
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL, registerAndLogin, authHeaders } from './helpers.js';

export const options = {
  vus: 5,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<3000'],
    http_req_failed: ['rate<0.05'],
  },
};

export default function () {
  const user = registerAndLogin('ai');
  const res = http.post(
    `${BASE_URL}/ai/generate`,
    JSON.stringify({ prompt: 'Summarize the security posture of this asset in one paragraph.' }),
    authHeaders(user.accessToken),
  );
  check(res, {
    'status is 200': (r) => r.status === 200,
    'has text': (r) => !!r.json('text'),
  });
}
