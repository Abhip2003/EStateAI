import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { prisma } from '../src/db/prisma.js';
import { api, createChecker, loginAgain, registerAndLogin } from './lib/verify-helpers.js';

interface CategoryDto {
  id: string;
  name: string;
  slug: string;
}

interface CategoryListDto {
  items: CategoryDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const stamp = Date.now();
  const createdCategoryIds: string[] = [];
  let adminId: string | undefined;
  let userId: string | undefined;

  try {
    console.log('0. setup — one admin, one regular user');
    const admin = await registerAndLogin(`verify-cat-admin-${stamp}@example.test`);
    adminId = admin.id;
    // Role is baked into the JWT at sign time, so promote in the DB then
    // re-login to get a token that actually carries the ADMIN role.
    await userRepository.update(admin.id, { role: 'ADMIN' });
    const adminToken = await loginAgain(admin.email);

    const user = await registerAndLogin(`verify-cat-user-${stamp}@example.test`);
    userId = user.id;

    console.log('1. authorization — non-admin cannot create a category');
    const forbidden = await api('POST', '/categories', user.accessToken, {
      name: `Should Fail ${stamp}`,
      slug: `should-fail-${stamp}`,
    });
    check('status', forbidden.status === 403, `${forbidden.status}`);

    console.log('2. create — admin creates categories');
    const created: CategoryDto[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await api<CategoryDto>('POST', '/categories', adminToken, {
        name: `Verify Category ${stamp}-${i}`,
        slug: `verify-category-${stamp}-${i}`,
        description: 'created by verify-categories.ts',
      });
      check(`create #${i} status`, res.status === 201, `${res.status}`);
      created.push(res.body);
      createdCategoryIds.push(res.body.id);
    }

    console.log('3. duplicate slug rejection');
    const duplicate = await api('POST', '/categories', adminToken, {
      name: 'Duplicate Attempt',
      slug: created[0]?.slug,
    });
    check('status', duplicate.status === 409, `${duplicate.status}`);

    console.log('4. search — find a category by name fragment');
    const searchRes = await api<CategoryListDto>(
      'GET',
      `/categories?search=${encodeURIComponent(`Verify Category ${stamp}`)}&limit=50`,
      user.accessToken,
    );
    check('status', searchRes.status === 200, `${searchRes.status}`);
    check(
      'search finds all 3 created categories',
      searchRes.body.items.filter((c) => createdCategoryIds.includes(c.id)).length === 3,
      `found ${searchRes.body.items.length}`,
    );

    console.log('5. pagination — list with limit=1 across two pages');
    const page1 = await api<CategoryListDto>(
      'GET',
      `/categories?search=${encodeURIComponent(`Verify Category ${stamp}`)}&limit=1&page=1`,
      user.accessToken,
    );
    const page2 = await api<CategoryListDto>(
      'GET',
      `/categories?search=${encodeURIComponent(`Verify Category ${stamp}`)}&limit=1&page=2`,
      user.accessToken,
    );
    check('page1 has 1 item', page1.body.items.length === 1, `${page1.body.items.length}`);
    check('page1 total is 3', page1.body.total === 3, `${page1.body.total}`);
    check('page1 totalPages is 3', page1.body.totalPages === 3, `${page1.body.totalPages}`);
    check(
      'page1 and page2 return different items',
      page1.body.items[0]?.id !== page2.body.items[0]?.id,
      'same item returned on both pages',
    );

    if (state.failed) {
      console.error('\nOne or more category checks FAILED.');
    } else {
      console.log('\nAll category checks passed.');
    }
  } finally {
    console.log('6. cleanup');
    for (const id of createdCategoryIds) {
      await categoryRepository.delete(id);
    }
    console.log('   categories deleted:', createdCategoryIds.length);
    if (adminId) await userRepository.delete(adminId);
    if (userId) await userRepository.delete(userId);
    console.log('   users deleted');
    await prisma.$disconnect();
  }

  if (state.failed) {
    process.exitCode = 1;
  }
}

void main();
