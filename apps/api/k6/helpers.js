// Shared setup for every Phase 15 k6 script. Each VU registers its own
// throwaway user (unique per VU+iteration) rather than sharing one login
// across VUs, so login/asset-crud/etc runs don't serialize on the same DB
// row or trip refresh-token-reuse detection between VUs.
import http from 'k6/http';
import { check } from 'k6';

export const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:3000';

export function registerAndLogin(prefix) {
  const email = `k6-${prefix}-${__VU}-${__ITER}-${Date.now()}@example.test`;
  const password = 'CorrectHorseBatteryStaple1!';
  http.post(
    `${BASE_URL}/auth/register`,
    JSON.stringify({ email, password, firstName: 'K6', lastName: 'User' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  const loginRes = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email, password }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  check(loginRes, { 'login: 200': (r) => r.status === 200 });
  const body = loginRes.json();
  return { email, accessToken: body.accessToken, refreshToken: body.refreshToken };
}

// One admin + one category, created once in a setup() function and reused
// read-only by every VU — avoids every VU racing to create its own
// category (categories are admin-gated, see DECISIONS.md) under load.
export function adminLoginRaw(email, password) {
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email, password }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return res.json();
}

export function authHeaders(token) {
  return { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
}

// For DELETE/POST calls with no JSON body — Fastify's default JSON body
// parser rejects an empty body when Content-Type: application/json is
// still present (see DECISIONS.md), so bodyless calls must omit it.
export function authHeadersNoBody(token) {
  return { headers: { Authorization: `Bearer ${token}` } };
}
