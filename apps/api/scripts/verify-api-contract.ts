// Phase 15 — API contract verification. Not a new domain like every other
// verify:* script (auth, assets, jobs, ...) — this one instead sweeps
// cross-cutting HTTP contract behavior (status codes, validation error
// shape, auth/authz, pagination/sorting/filtering, error response shape)
// across a representative sample of already-existing routes. It does not
// re-test business logic those other scripts already cover in depth.
import {
  api,
  createChecker,
  createAdminAndCategory,
  registerAndLogin,
} from './lib/verify-helpers.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import { userRepository } from '../src/repositories/user.repository.js';
import { prisma } from '../src/db/prisma.js';

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const stamp = Date.now();

  console.log('0. setup');
  const { admin, categoryId } = await createAdminAndCategory('contract');
  const owner = await registerAndLogin(`verify-contract-owner-${stamp}@example.test`);
  const other = await registerAndLogin(`verify-contract-other-${stamp}@example.test`);

  const assetIds: string[] = [];

  try {
    console.log('1. Authentication — no token / malformed token / expired-shape token');
    const noToken = await api('GET', '/assets', undefined);
    check('no token -> 401', noToken.status === 401, `${noToken.status}`);

    const malformed = await api('GET', '/assets', 'this-is-not-a-jwt');
    check('malformed token -> 401', malformed.status === 401, `${malformed.status}`);

    console.log('2. Authorization — cross-user resource access is 403/404, not leaked');
    const assetRes = await api<{ id: string }>('POST', '/assets', owner.accessToken, {
      categoryId,
      name: `contract-asset-${stamp}`,
    });
    check('create asset -> 201', assetRes.status === 201, `${assetRes.status}`);
    const assetId = assetRes.body.id;
    assetIds.push(assetId);

    const crossGet = await api('GET', `/assets/${assetId}`, other.accessToken);
    check(
      'cross-user GET -> 403 (not 404, ownership is checked not existence-hidden)',
      crossGet.status === 403,
      `${crossGet.status}`,
    );

    console.log('3. Validation errors — 400 with a structured, field-attributed body');
    const badCreate = await api<{ errors?: unknown[] }>('POST', '/assets', owner.accessToken, {
      categoryId: '',
      name: '',
    });
    check('invalid create -> 400', badCreate.status === 400, `${badCreate.status}`);
    check(
      'validation body has errors[]',
      Array.isArray(badCreate.body.errors),
      JSON.stringify(badCreate.body),
    );

    const malformedJson = await fetch(
      `${process.env.VERIFY_BASE_URL ?? 'http://localhost:3000'}/assets`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${owner.accessToken}`,
        },
        body: '{not-valid-json',
      },
    );
    check(
      'malformed JSON body -> 4xx, not 500',
      malformedJson.status >= 400 && malformedJson.status < 500,
      `${malformedJson.status}`,
    );

    console.log('4. Not found — a well-formed but nonexistent id is 404');
    const notFound = await api('GET', '/assets/cknonexistent00000000000000', owner.accessToken);
    check('nonexistent id -> 404', notFound.status === 404, `${notFound.status}`);

    console.log('5. Pagination — page/limit are respected and bounded');
    for (let i = 0; i < 3; i += 1) {
      const r = await api<{ id: string }>('POST', '/assets', owner.accessToken, {
        categoryId,
        name: `contract-page-asset-${stamp}-${i}`,
      });
      assetIds.push(r.body.id);
    }
    const page1 = await api<{ items: unknown[]; page: number; limit: number; total: number }>(
      'GET',
      '/assets?page=1&limit=2',
      owner.accessToken,
    );
    check('page=1&limit=2 -> 2 items', page1.body.items.length === 2, `${page1.body.items.length}`);
    check('limit echoed', page1.body.limit === 2, `${page1.body.limit}`);
    check('total is a number >= 4', typeof page1.body.total === 'number' && page1.body.total >= 4);

    const overLimit = await api('GET', '/assets?limit=99999', owner.accessToken);
    check(
      'limit over max -> 400 (bounded, not silently clamped or 500)',
      overLimit.status === 400,
      `${overLimit.status}`,
    );

    console.log('6. Sorting — sort/order change result ordering');
    const ascRes = await api<{ items: { name: string }[] }>(
      'GET',
      '/assets?sort=name&order=asc&limit=100',
      owner.accessToken,
    );
    const descRes = await api<{ items: { name: string }[] }>(
      'GET',
      '/assets?sort=name&order=desc&limit=100',
      owner.accessToken,
    );
    const ascNames = ascRes.body.items.map((a) => a.name);
    const descNames = descRes.body.items.map((a) => a.name);
    check(
      'asc/desc produce reversed orderings',
      JSON.stringify(ascNames) === JSON.stringify([...descNames].reverse()),
    );

    console.log('7. Filtering — status/category/search narrow results');
    const filtered = await api<{ items: { categoryId: string }[] }>(
      'GET',
      `/assets?categoryId=${categoryId}&limit=100`,
      owner.accessToken,
    );
    check(
      'categoryId filter -> every item matches',
      filtered.body.items.every((a) => a.categoryId === categoryId),
    );
    const searched = await api<{ items: unknown[] }>(
      'GET',
      `/assets?search=contract-page-asset-${stamp}&limit=100`,
      owner.accessToken,
    );
    check(
      'search filter -> at least the 3 seeded matches',
      searched.body.items.length >= 3,
      `${searched.body.items.length}`,
    );

    console.log('8. Error response shape — consistent {status, message} or {errors} envelope');
    const forbiddenCategoryCreate = await api('POST', '/categories', owner.accessToken, {
      name: 'x',
      slug: 'x',
    });
    check(
      'non-admin category create -> 403',
      forbiddenCategoryCreate.status === 403,
      `${forbiddenCategoryCreate.status}`,
    );
    check(
      '403 body has a message field',
      typeof (forbiddenCategoryCreate.body as { message?: string }).message === 'string',
    );

    console.log('9. Method/route shape — unknown route is a plain 404, not a 500');
    const unknownRoute = await fetch(
      `${process.env.VERIFY_BASE_URL ?? 'http://localhost:3000'}/totally/not/a/route`,
    );
    check('unknown route -> 404', unknownRoute.status === 404, `${unknownRoute.status}`);

    if (state.failed) {
      console.error('\nOne or more contract checks FAILED.');
    } else {
      console.log('\nAll API contract checks passed.');
    }
  } finally {
    console.log('10. cleanup');
    for (const id of assetIds) {
      await assetRepository.delete(id);
    }
    await categoryRepository.delete(categoryId);
    await userRepository.delete(admin.id);
    await userRepository.delete(owner.id);
    await userRepository.delete(other.id);
    await prisma.$disconnect();
  }

  if (state.failed) {
    process.exitCode = 1;
  }
}

void main();
