import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import { prisma } from '../src/db/prisma.js';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';

interface AssetDto {
  id: string;
  name: string;
  status: string;
  riskScore: number;
  userId: string;
}

interface AssetListDto {
  items: AssetDto[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const stamp = Date.now();
  const createdAssetIds: string[] = [];
  let categoryId: string | undefined;
  let adminId: string | undefined;
  let ownerId: string | undefined;
  let otherId: string | undefined;

  try {
    console.log('0. setup — admin+category, owner, and another user');
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('asset');
    adminId = admin.id;
    categoryId = newCategoryId;
    const adminToken = admin.accessToken;

    const owner = await registerAndLogin(`verify-asset-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const other = await registerAndLogin(`verify-asset-other-${stamp}@example.test`);
    otherId = other.id;

    console.log('1. create — owner creates several assets with varied attributes');
    const seed = [
      { name: `alpha-website-${stamp}`, status: 'ACTIVE', riskScore: 10 },
      { name: `bravo-github-${stamp}`, status: 'ACTIVE', riskScore: 80 },
      { name: `charlie-aws-${stamp}`, status: 'WARNING', riskScore: 50 },
      { name: `delta-domain-${stamp}`, status: 'INACTIVE', riskScore: 30 },
    ];
    for (const s of seed) {
      const res = await api<AssetDto>('POST', '/assets', owner.accessToken, {
        categoryId,
        name: s.name,
        status: s.status,
        riskScore: s.riskScore,
      });
      check(`create "${s.name}" status`, res.status === 201, `${res.status}`);
      createdAssetIds.push(res.body.id);
    }
    const [assetAlpha, assetBravo, assetCharlie] = createdAssetIds;

    console.log('2. validation — invalid category is rejected');
    const badCategory = await api('POST', '/assets', owner.accessToken, {
      categoryId: 'not-a-real-category-id',
      name: 'should not be created',
    });
    check('status', badCategory.status === 404, `${badCategory.status}`);

    console.log('3. validation — out-of-range riskScore is rejected');
    const badRisk = await api('POST', '/assets', owner.accessToken, {
      categoryId,
      name: 'should not be created either',
      riskScore: 150,
    });
    check('status', badRisk.status === 400, `${badRisk.status}`);

    console.log('4. ownership — another user creates an asset of their own');
    const otherAssetRes = await api<AssetDto>('POST', '/assets', other.accessToken, {
      categoryId,
      name: `other-user-asset-${stamp}`,
    });
    createdAssetIds.push(otherAssetRes.body.id);

    console.log("5. ownership — owner cannot see the other user's asset via GET :id");
    const crossGet = await api('GET', `/assets/${otherAssetRes.body.id}`, owner.accessToken);
    check('status', crossGet.status === 403, `${crossGet.status}`);

    console.log("6. ownership — owner cannot patch the other user's asset");
    const crossPatch = await api('PATCH', `/assets/${otherAssetRes.body.id}`, owner.accessToken, {
      name: 'hijacked',
    });
    check('status', crossPatch.status === 403, `${crossPatch.status}`);

    console.log("7. ownership — list only returns the caller's own assets");
    const ownerList = await api<AssetListDto>('GET', '/assets?limit=50', owner.accessToken);
    check(
      "owner list excludes other user's asset",
      !ownerList.body.items.some((a) => a.id === otherAssetRes.body.id),
      "leaked another user's asset",
    );
    check(
      "owner list contains all 4 of owner's assets",
      seed.every((s) => ownerList.body.items.some((a) => a.name === s.name)),
      'missing an expected asset',
    );

    console.log("8. authorization — admin CAN view the other user's asset");
    const adminGet = await api('GET', `/assets/${otherAssetRes.body.id}`, adminToken);
    check('status', adminGet.status === 200, `${adminGet.status}`);

    console.log('9. update — owner updates their own asset');
    const patchRes = await api<AssetDto>('PATCH', `/assets/${assetAlpha}`, owner.accessToken, {
      riskScore: 99,
    });
    check('status', patchRes.status === 200, `${patchRes.status}`);
    check('riskScore updated', patchRes.body.riskScore === 99, `${patchRes.body.riskScore}`);

    console.log('10. soft delete — DELETE archives instead of removing the row');
    const deleteRes = await api<AssetDto>('DELETE', `/assets/${assetAlpha}`, owner.accessToken);
    check('status', deleteRes.status === 200, `${deleteRes.status}`);
    check('status becomes ARCHIVED', deleteRes.body.status === 'ARCHIVED', deleteRes.body.status);
    const stillExists = await api<AssetDto>('GET', `/assets/${assetAlpha}`, owner.accessToken);
    check(
      'asset is still fetchable after "delete" (soft archive, not gone)',
      stillExists.status === 200,
      `${stillExists.status}`,
    );

    console.log('11. filtering — status=ACTIVE');
    const activeFiltered = await api<AssetListDto>(
      'GET',
      '/assets?status=ACTIVE&limit=50',
      owner.accessToken,
    );
    check(
      'only ACTIVE assets returned',
      activeFiltered.body.items.every((a) => a.status === 'ACTIVE'),
      'a non-ACTIVE asset leaked through',
    );
    check(
      'archived asset excluded from ACTIVE filter',
      !activeFiltered.body.items.some((a) => a.id === assetAlpha),
      'archived asset still showed up',
    );

    console.log('12. filtering — riskScore range');
    const riskFiltered = await api<AssetListDto>(
      'GET',
      '/assets?minRiskScore=40&maxRiskScore=60&limit=50',
      owner.accessToken,
    );
    check(
      'charlie (riskScore 50) present',
      riskFiltered.body.items.some((a) => a.id === assetCharlie),
      'missing expected asset',
    );
    check(
      'bravo (riskScore 80) excluded',
      !riskFiltered.body.items.some((a) => a.id === assetBravo),
      'out-of-range asset leaked through',
    );

    console.log('13. search — GET /assets/search by name fragment');
    const searchRes = await api<AssetListDto>(
      'GET',
      `/assets/search?search=${encodeURIComponent(`github-${stamp}`)}`,
      owner.accessToken,
    );
    check('status', searchRes.status === 200, `${searchRes.status}`);
    check(
      'search finds bravo',
      searchRes.body.items.some((a) => a.id === assetBravo),
      'search did not find the expected asset',
    );

    console.log('14. search — /assets/search requires a non-empty search term');
    const emptySearch = await api('GET', '/assets/search', owner.accessToken);
    check('status', emptySearch.status === 400, `${emptySearch.status}`);

    console.log('15. pagination — limit=2 across pages, ordered by name asc');
    const page1 = await api<AssetListDto>(
      'GET',
      '/assets?limit=2&page=1&sort=name&order=asc',
      owner.accessToken,
    );
    const page2 = await api<AssetListDto>(
      'GET',
      '/assets?limit=2&page=2&sort=name&order=asc',
      owner.accessToken,
    );
    check('page1 has 2 items', page1.body.items.length === 2, `${page1.body.items.length}`);
    check('page1 total is 4', page1.body.total === 4, `${page1.body.total}`);
    check(
      'page1 and page2 do not overlap',
      !page1.body.items.some((a) => page2.body.items.some((b) => b.id === a.id)),
      'overlapping items across pages',
    );

    if (state.failed) {
      console.error('\nOne or more asset checks FAILED.');
    } else {
      console.log('\nAll asset checks passed.');
    }
  } finally {
    console.log('16. cleanup');
    for (const id of createdAssetIds) {
      await assetRepository.delete(id);
    }
    console.log('   assets deleted:', createdAssetIds.length);
    if (categoryId) await categoryRepository.delete(categoryId);
    console.log('   category deleted');
    if (adminId) await userRepository.delete(adminId);
    if (ownerId) await userRepository.delete(ownerId);
    if (otherId) await userRepository.delete(otherId);
    console.log('   users deleted');
    await prisma.$disconnect();
  }

  if (state.failed) {
    process.exitCode = 1;
  }
}

void main();
