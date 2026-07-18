import { userRepository } from '../src/repositories/user.repository.js';
import { prisma } from '../src/db/prisma.js';

const BASE_URL = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000';

let failed = false;

function check(label: string, condition: boolean, detail: string): void {
  if (condition) {
    console.log(`   ${label}: OK`);
  } else {
    console.log(`   ${label}: FAILED (${detail})`);
    failed = true;
  }
}

async function register(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, firstName: 'Verify', lastName: 'Refresh' }),
  });
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function login(
  email: string,
  password: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return (await res.json()) as { accessToken: string; refreshToken: string };
}

async function refresh(refreshToken: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  return { status: res.status, body: await res.json() };
}

async function main(): Promise<void> {
  const email = `verify-refresh-${Date.now()}@example.test`;
  const password = 'CorrectHorseBatteryStaple';
  let createdUserId: string | undefined;

  try {
    console.log('0. setup — register and log in');
    createdUserId = await register(email, password);
    const firstLogin = await login(email, password);
    check('refreshToken present', typeof firstLogin.refreshToken === 'string', 'missing');

    console.log('1. refresh success — rotate refreshToken1 into refreshToken2');
    const rotate1 = await refresh(firstLogin.refreshToken);
    check('status', rotate1.status === 200, `${rotate1.status}`);
    const rotate1Body = rotate1.body as { accessToken?: string; refreshToken?: string };
    check('new accessToken present', typeof rotate1Body.accessToken === 'string', 'missing');
    check('new refreshToken present', typeof rotate1Body.refreshToken === 'string', 'missing');
    check(
      'new refreshToken differs from old',
      rotate1Body.refreshToken !== firstLogin.refreshToken,
      'unchanged',
    );
    const refreshToken2 = rotate1Body.refreshToken ?? '';

    console.log('2. reuse detection — replay the already-rotated refreshToken1');
    const reuseAttempt = await refresh(firstLogin.refreshToken);
    check('status', reuseAttempt.status === 401, `${reuseAttempt.status}`);

    console.log('3. reuse detection — cascade revocation of refreshToken2');
    const afterReuse = await refresh(refreshToken2);
    check(
      'status (refreshToken2 should now be revoked too)',
      afterReuse.status === 401,
      `${afterReuse.status}`,
    );

    console.log('4. logout — obtain a fresh token pair, then revoke it');
    const secondLogin = await login(email, password);
    const logoutRes = await fetch(`${BASE_URL}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: secondLogin.refreshToken }),
    });
    check('logout status', logoutRes.status === 200, `${logoutRes.status}`);

    console.log('5. revoked token rejection — refresh after logout');
    const afterLogout = await refresh(secondLogin.refreshToken);
    check('status', afterLogout.status === 401, `${afterLogout.status}`);

    if (failed) {
      console.error('\nOne or more refresh token checks FAILED.');
    } else {
      console.log('\nAll refresh token checks passed.');
    }
  } finally {
    console.log('6. cleanup');
    if (createdUserId) {
      const deleted = await userRepository.delete(createdUserId);
      console.log('   deleted:', deleted?.id === createdUserId ? 'OK' : 'FAILED');
    }
    await prisma.$disconnect();
  }

  if (failed) {
    process.exitCode = 1;
  }
}

void main();
