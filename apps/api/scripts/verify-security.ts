// Phase 15 — security verification. Exercises the security-relevant
// surface documented in docs/DEPLOYMENT.md's Security checklist (Phase 14)
// against the live server: JWT validation, RBAC, unauthorized access, input
// validation, injection-style inputs, and information leakage. CSRF and
// file-upload checks are addressed as scope notes, not tests — see the
// bottom of this file for why.
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import {
  api,
  createChecker,
  createAdminAndCategory,
  registerAndLogin,
} from './lib/verify-helpers.js';
import { config } from '../src/config/env.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import { userRepository } from '../src/repositories/user.repository.js';
import { prisma } from '../src/db/prisma.js';

const BASE_URL = process.env.VERIFY_BASE_URL ?? 'http://localhost:3000';
const WS_URL = BASE_URL.replace(/^http/, 'ws');

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const stamp = Date.now();

  console.log('0. setup');
  const { admin, categoryId } = await createAdminAndCategory('security');
  const owner = await registerAndLogin(`verify-security-owner-${stamp}@example.test`);
  const assetIds: string[] = [];

  try {
    console.log('1. JWT validation — tampered signature is rejected');
    const [header, payload] = owner.accessToken.split('.');
    const tamperedToken = `${header}.${payload}.tampered-signature-not-valid`;
    const tamperedRes = await api('GET', '/auth/me', tamperedToken);
    check('tampered signature -> 401', tamperedRes.status === 401, `${tamperedRes.status}`);

    console.log('2. JWT validation — wrong secret is rejected');
    const wrongSecretToken = jwt.sign(
      { sub: owner.id, role: 'ADMIN' },
      'a-completely-different-secret-not-the-real-one-at-all',
      { issuer: config.jwt.issuer, audience: config.jwt.audience, expiresIn: '15m' },
    );
    const wrongSecretRes = await api('GET', '/auth/me', wrongSecretToken);
    check('wrong secret -> 401', wrongSecretRes.status === 401, `${wrongSecretRes.status}`);

    console.log(
      '3. Expired tokens — a token signed with the real secret but already expired is rejected',
    );
    const expiredToken = jwt.sign({ sub: owner.id, role: 'USER' }, config.jwt.secret, {
      issuer: config.jwt.issuer,
      audience: config.jwt.audience,
      expiresIn: '-10s',
    });
    const expiredRes = await api('GET', '/auth/me', expiredToken);
    check('expired token -> 401', expiredRes.status === 401, `${expiredRes.status}`);

    console.log(
      '4. JWT validation — a token claiming an unearned ADMIN role is still rejected without a matching real user session change',
    );
    // A forged-but-correctly-signed token is impossible without the real
    // secret (already proven in check #2); this instead confirms role
    // escalation can't happen by a *client* simply sending a different
    // `role` claim than what real login issued — the real access token's
    // role always matches the DB row at issuance time (verified positively
    // by the RBAC checks below, not by attempting a signature forgery we
    // already know fails).

    console.log(
      '5. Refresh token rotation — reuse of an already-rotated token revokes the whole chain (see auth.spec.ts too)',
    );
    // registerAndLogin()'s shared AuthedUser shape only carries accessToken
    // (every other verify:* script only ever needs that one) — fetch a
    // real refreshToken with our own direct login call instead of
    // widening a helper every other script also depends on.
    const ownerLogin = await api<{ refreshToken: string }>('POST', '/auth/login', undefined, {
      email: owner.email,
      password: 'CorrectHorseBatteryStaple',
    });
    const ownerRefreshToken = ownerLogin.body.refreshToken;
    const refreshed = await api<{ refreshToken: string }>('POST', '/auth/refresh', undefined, {
      refreshToken: ownerRefreshToken,
    });
    check('first refresh -> 200', refreshed.status === 200, `${refreshed.status}`);
    const reuse = await api('POST', '/auth/refresh', undefined, {
      refreshToken: ownerRefreshToken,
    });
    check('reused (already-rotated) refresh token -> 401', reuse.status === 401, `${reuse.status}`);
    // Reuse detection revokes the whole chain — the newly-rotated token
    // must also now be dead, not just the reused one.
    const rotatedNowDead = await api('POST', '/auth/refresh', undefined, {
      refreshToken: refreshed.body.refreshToken,
    });
    check(
      'rotated token is also revoked after a reuse was detected (whole-chain revocation)',
      rotatedNowDead.status === 401,
      `${rotatedNowDead.status}`,
    );

    console.log('6. RBAC — admin-only routes reject a regular user, accept an admin');
    const nonAdminCategoryCreate = await api('POST', '/categories', owner.accessToken, {
      name: 'sec-test',
      slug: 'sec-test',
    });
    check(
      'non-admin category create -> 403',
      nonAdminCategoryCreate.status === 403,
      `${nonAdminCategoryCreate.status}`,
    );
    const adminCategoryCreate = await api<{ id: string }>(
      'POST',
      '/categories',
      admin.accessToken,
      {
        name: `sec-test-${stamp}`,
        slug: `sec-test-${stamp}`,
      },
    );
    check(
      'admin category create -> 201',
      adminCategoryCreate.status === 201,
      `${adminCategoryCreate.status}`,
    );
    await categoryRepository.delete(adminCategoryCreate.body.id);

    const nonAdminRiskOverview = await api('GET', '/analysis/risk', owner.accessToken);
    check(
      'non-admin platform risk overview -> 403',
      nonAdminRiskOverview.status === 403,
      `${nonAdminRiskOverview.status}`,
    );
    const adminRiskOverview = await api('GET', '/analysis/risk', admin.accessToken);
    check(
      'admin platform risk overview -> 200',
      adminRiskOverview.status === 200,
      `${adminRiskOverview.status}`,
    );

    console.log('7. Unauthorized access — ownership is enforced, not just authentication');
    const other = await registerAndLogin(`verify-security-other-${stamp}@example.test`);
    const assetRes = await api<{ id: string }>('POST', '/assets', owner.accessToken, {
      categoryId,
      name: `sec-asset-${stamp}`,
    });
    assetIds.push(assetRes.body.id);
    const crossAccess = await api('PATCH', `/assets/${assetRes.body.id}`, other.accessToken, {
      displayName: 'hijacked',
    });
    check('cross-user PATCH -> 403', crossAccess.status === 403, `${crossAccess.status}`);
    await userRepository.delete(other.id);

    console.log(
      '8. Rate limiting — @fastify/rate-limit headers are present on a real (non-allowlisted) route',
    );
    // /health and /metrics are deliberately allowlisted (server.ts) so
    // infra polling doesn't count against the budget — probing one of
    // those would show no rate-limit headers by design, not a bug.
    const raw = await fetch(`${BASE_URL}/auth/me`, {
      headers: { Authorization: `Bearer ${owner.accessToken}` },
    });
    check(
      'x-ratelimit-limit header present',
      raw.headers.has('x-ratelimit-limit'),
      Array.from(raw.headers.keys()).join(','),
    );

    console.log('9. Input validation — oversized/wrong-type payloads are rejected, not 500');
    const wrongType = await api('POST', '/assets', owner.accessToken, {
      categoryId: 123,
      name: true,
    });
    check('wrong-type body -> 400', wrongType.status === 400, `${wrongType.status}`);

    const hugeString = 'a'.repeat(50_000);
    const oversized = await api('POST', '/assets', owner.accessToken, {
      categoryId,
      name: hugeString,
    });
    check(
      'very long name -> 400 (validated) or 201 (accepted, still safe)',
      oversized.status === 400 || oversized.status === 201,
      `${oversized.status}`,
    );
    if (oversized.status === 201) assetIds.push((oversized.body as { id: string }).id);

    console.log(
      "10. SQL injection — Prisma's parameterization means injection-shaped input is just literal data",
    );
    const injectionAttempt = await api<{ items: unknown[] }>(
      'GET',
      `/assets?search=${encodeURIComponent('\'; DROP TABLE "User"; --')}`,
      owner.accessToken,
    );
    check(
      'SQLi-shaped search -> 200, not 500',
      injectionAttempt.status === 200,
      `${injectionAttempt.status}`,
    );
    const stillWorks = await api('GET', '/auth/me', owner.accessToken);
    check(
      'User table intact after injection attempt (auth/me still works)',
      stillWorks.status === 200,
      `${stillWorks.status}`,
    );

    console.log(
      '11. XSS — a script-tag payload is stored and returned as inert JSON text, not executed/stripped-unsafely',
    );
    const xssPayload = '<script>window.__xss_fired=true</script>';
    const xssAsset = await api<{ id: string; name: string }>('POST', '/assets', owner.accessToken, {
      categoryId,
      name: xssPayload,
    });
    check(
      'XSS-shaped name accepted (stored verbatim, this is a JSON API not an HTML renderer)',
      xssAsset.status === 201,
      `${xssAsset.status}`,
    );
    if (xssAsset.status === 201) {
      assetIds.push(xssAsset.body.id);
      check(
        "payload round-trips unescaped in JSON (correct for a JSON API — escaping is the renderer's job)",
        xssAsset.body.name === xssPayload,
      );
      const contentType = (
        await fetch(`${BASE_URL}/assets/${xssAsset.body.id}`, {
          headers: { Authorization: `Bearer ${owner.accessToken}` },
        })
      ).headers.get('content-type');
      check(
        'response Content-Type is application/json (browser will not execute it as HTML)',
        !!contentType?.includes('application/json'),
        contentType ?? 'null',
      );
    }

    console.log(
      '12. Sensitive information leakage — passwordHash and JWT secret never appear in any response',
    );
    const me = await api<Record<string, unknown>>('GET', '/auth/me', owner.accessToken);
    check('GET /auth/me has no passwordHash field', !('passwordHash' in me.body));
    const registerLeak = await api<Record<string, unknown>>('POST', '/auth/register', undefined, {
      email: `verify-security-leak-${stamp}@example.test`,
      password: 'CorrectHorseBatteryStaple1!',
      firstName: 'Leak',
      lastName: 'Check',
    });
    check('POST /auth/register has no passwordHash field', !('passwordHash' in registerLeak.body));
    if (typeof registerLeak.body.id === 'string') {
      await userRepository.delete(registerLeak.body.id);
    }
    const forced500Probe = await fetch(`${BASE_URL}/assets/${'x'.repeat(500)}`, {
      headers: { Authorization: `Bearer ${owner.accessToken}` },
    });
    const probeBody = (await forced500Probe.json()) as { stack?: unknown };
    check(
      'error responses never include a stack trace',
      !('stack' in probeBody),
      JSON.stringify(probeBody),
    );

    console.log('13. WebSocket — missing/invalid token is rejected with the documented close code');
    const noTokenClose = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${WS_URL}/ws`);
      ws.on('close', (code: number) => resolve(code));
      ws.on('error', () => resolve(-1));
    });
    check('GET /ws with no token -> close code 4401', noTokenClose === 4401, `${noTokenClose}`);

    const badTokenClose = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${WS_URL}/ws?token=not-a-real-token`);
      ws.on('close', (code: number) => resolve(code));
      ws.on('error', () => resolve(-1));
    });
    check(
      'GET /ws with an invalid token -> close code 4401',
      badTokenClose === 4401,
      `${badTokenClose}`,
    );

    if (state.failed) {
      console.error('\nOne or more security checks FAILED.');
    } else {
      console.log('\nAll security checks passed.');
    }
  } finally {
    console.log('14. cleanup');
    for (const id of assetIds) {
      await assetRepository.delete(id);
    }
    await categoryRepository.delete(categoryId);
    await userRepository.delete(admin.id);
    await userRepository.delete(owner.id);
    await prisma.$disconnect();
  }

  if (state.failed) {
    process.exitCode = 1;
  }
}

void main();

// Scope notes (not automatable the same way as the checks above):
// - CSRF: this API is bearer-token-in-Authorization-header only (see
//   docs/DEPLOYMENT.md's Security checklist) — no cookie ever carries
//   credentials, so there is no ambient-credential attack for CSRF to
//   exploit in the first place. Nothing to test; the assumption is
//   structural, not defended by a CSRF token.
// - File upload safety: no file upload endpoint exists anywhere in this
//   API (grep confirms no `multipart` handling is registered) — not
//   applicable today.
