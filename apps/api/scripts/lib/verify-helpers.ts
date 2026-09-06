export const BASE_URL = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000';

export interface CheckState {
  failed: boolean;
}

export function createChecker(): {
  state: CheckState;
  check: (label: string, condition: boolean, detail?: string) => void;
} {
  const state: CheckState = { failed: false };

  function check(label: string, condition: boolean, detail = ''): void {
    if (condition) {
      console.log(`   ${label}: OK`);
    } else {
      console.log(`   ${label}: FAILED${detail ? ` (${detail})` : ''}`);
      state.failed = true;
    }
  }

  return { state, check };
}

export interface AuthedUser {
  id: string;
  email: string;
  accessToken: string;
}

export async function registerAndLogin(
  email: string,
  password = 'CorrectHorseBatteryStaple',
): Promise<AuthedUser> {
  const registerRes = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, firstName: 'Verify', lastName: 'User' }),
  });
  const registerBody = (await registerRes.json()) as { id: string };

  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const loginBody = (await loginRes.json()) as { accessToken: string };

  return { id: registerBody.id, email, accessToken: loginBody.accessToken };
}

export async function loginAgain(
  email: string,
  password = 'CorrectHorseBatteryStaple',
): Promise<string> {
  const loginRes = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const loginBody = (await loginRes.json()) as { accessToken: string };
  return loginBody.accessToken;
}

// Category creation is admin-gated (Phase 2.0 decision). Several
// verification scripts just need *some* category to hang assets off of, so
// this registers a throwaway admin, promotes them directly via the
// repository (role is baked into the JWT at sign time, hence the re-login),
// and creates one category. Callers are responsible for cleaning up both
// the admin user and the category.
export async function createAdminAndCategory(
  label: string,
): Promise<{ admin: AuthedUser; categoryId: string }> {
  // Imported lazily to avoid a hard dependency on Prisma/repositories for
  // scripts that only need the plain HTTP helpers above.
  const { userRepository } = await import('../../src/repositories/user.repository.js');

  const admin = await registerAndLogin(`verify-${label}-admin-${Date.now()}@example.test`);
  await userRepository.update(admin.id, { role: 'ADMIN' });
  const adminToken = await loginAgain(admin.email);

  const categoryRes = await api<{ id: string }>('POST', '/categories', adminToken, {
    name: `Verify ${label} Category ${Date.now()}`,
    slug: `verify-${label}-category-${Date.now()}`,
  });

  return { admin: { ...admin, accessToken: adminToken }, categoryId: categoryRes.body.id };
}

export interface ApiResult<T = unknown> {
  status: number;
  body: T;
}

export async function api<T = unknown>(
  method: string,
  path: string,
  accessToken?: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json()) as T };
}
