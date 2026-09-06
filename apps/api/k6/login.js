// Performance test — Login. Registers a pool of users once in setup(),
// then every VU/iteration repeatedly logs in as one of them (login is the
// operation being measured, not registration).
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL } from './helpers.js';

export const options = {
  vus: 20,
  duration: '30s',
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};

const PASSWORD = 'CorrectHorseBatteryStaple1!';
const POOL_SIZE = 50;

export function setup() {
  const emails = [];
  for (let i = 0; i < POOL_SIZE; i += 1) {
    const email = `k6-login-pool-${i}-${Date.now()}@example.test`;
    http.post(
      `${BASE_URL}/auth/register`,
      JSON.stringify({ email, password: PASSWORD, firstName: 'K6', lastName: 'Login' }),
      { headers: { 'Content-Type': 'application/json' } },
    );
    emails.push(email);
  }
  return { emails };
}

export default function (data) {
  const email = data.emails[Math.floor(Math.random() * data.emails.length)];
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(res, {
    'status is 200': (r) => r.status === 200,
    'has accessToken': (r) => !!r.json('accessToken'),
  });
}
