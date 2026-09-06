import type { APIRequestContext } from '@playwright/test';

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3000';

// Created once by apps/api's prisma/seed.ts (Phase 14) — reused here rather
// than promoting a fresh user, since there is no HTTP route to grant ADMIN
// (role assignment is deliberately DB-only, see docs/DECISIONS.md).
export const SEED_ADMIN_EMAIL = 'admin@estateai.local';
export const SEED_ADMIN_PASSWORD = 'ChangeMe123!';

export interface AuthedUser {
  id: string;
  email: string;
  accessToken: string;
  refreshToken: string;
}

export async function registerAndLogin(
  request: APIRequestContext,
  emailPrefix: string,
  password = 'CorrectHorseBatteryStaple1!',
): Promise<AuthedUser> {
  const email = `${emailPrefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const registerRes = await request.post(`${API_URL}/auth/register`, {
    data: { email, password, firstName: 'E2E', lastName: 'User' },
  });
  if (!registerRes.ok()) {
    throw new Error(`register failed: ${registerRes.status()} ${await registerRes.text()}`);
  }
  const registerBody = (await registerRes.json()) as { id: string };

  const loginRes = await request.post(`${API_URL}/auth/login`, { data: { email, password } });
  if (!loginRes.ok()) {
    throw new Error(`login failed: ${loginRes.status()} ${await loginRes.text()}`);
  }
  const loginBody = (await loginRes.json()) as { accessToken: string; refreshToken: string };

  return { id: registerBody.id, email, accessToken: loginBody.accessToken, refreshToken: loginBody.refreshToken };
}

export async function loginSeedAdmin(request: APIRequestContext): Promise<AuthedUser> {
  const loginRes = await request.post(`${API_URL}/auth/login`, {
    data: { email: SEED_ADMIN_EMAIL, password: SEED_ADMIN_PASSWORD },
  });
  if (!loginRes.ok()) {
    throw new Error(
      `seed admin login failed (${loginRes.status()}) — did apps/api's prisma:seed run against the DB this suite targets?`,
    );
  }
  const body = (await loginRes.json()) as { user: { id: string }; accessToken: string; refreshToken: string };
  return { id: body.user.id, email: SEED_ADMIN_EMAIL, accessToken: body.accessToken, refreshToken: body.refreshToken };
}

export async function createCategory(
  request: APIRequestContext,
  adminToken: string,
  name: string,
): Promise<string> {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const res = await request.post(`${API_URL}/categories`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { name, slug, description: 'E2E category' },
  });
  if (!res.ok()) throw new Error(`createCategory failed: ${res.status()} ${await res.text()}`);
  const body = (await res.json()) as { id: string };
  return body.id;
}

export async function createAsset(
  request: APIRequestContext,
  token: string,
  categoryId: string,
  namePrefix = 'e2e-asset',
): Promise<{ id: string; name: string }> {
  const name = `${namePrefix}-${Date.now()}`;
  const res = await request.post(`${API_URL}/assets`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { categoryId, name },
  });
  if (!res.ok()) throw new Error(`createAsset failed: ${res.status()} ${await res.text()}`);
  const body = (await res.json()) as { id: string; name: string };
  return body;
}
