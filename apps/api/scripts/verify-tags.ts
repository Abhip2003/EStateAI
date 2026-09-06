import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import { tagRepository } from '../src/repositories/tag.repository.js';
import { prisma } from '../src/db/prisma.js';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';

interface TagDto {
  id: string;
  name: string;
}

interface TagListDto {
  items: TagDto[];
  total: number;
  totalPages: number;
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const stamp = Date.now();
  const createdTagIds: string[] = [];
  let categoryId: string | undefined;
  let assetId: string | undefined;
  let adminId: string | undefined;
  let ownerId: string | undefined;
  let otherId: string | undefined;

  try {
    console.log('0. setup — admin+category, asset, owner + another user');
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('tag');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-tag-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const other = await registerAndLogin(`verify-tag-other-${stamp}@example.test`);
    otherId = other.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-tag-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    console.log('1. create — a tag');
    const tagRes = await api<TagDto>('POST', '/tags', ownerToken, {
      name: `verify-tag-${stamp}`,
      color: '#ff0000',
    });
    check('status', tagRes.status === 201, `${tagRes.status}`);
    const tagId = tagRes.body.id;
    createdTagIds.push(tagId);

    console.log('2. create — duplicate tag name rejected');
    const dup = await api('POST', '/tags', ownerToken, { name: tagRes.body.name });
    check('status', dup.status === 409, `${dup.status}`);

    console.log('3. search — find the tag by name fragment');
    const search = await api<TagListDto>(
      'GET',
      `/tags?search=${encodeURIComponent(`verify-tag-${stamp}`)}`,
      ownerToken,
    );
    check(
      'search finds the tag',
      search.body.items.some((t) => t.id === tagId),
      'tag not found by search',
    );

    console.log('4. pagination — create 2 more tags, paginate with limit=1');
    for (let i = 0; i < 2; i++) {
      const res = await api<TagDto>('POST', '/tags', ownerToken, {
        name: `verify-tag-${stamp}-extra-${i}`,
      });
      createdTagIds.push(res.body.id);
    }
    const page1 = await api<TagListDto>(
      'GET',
      `/tags?search=${encodeURIComponent(`verify-tag-${stamp}`)}&limit=1&page=1`,
      ownerToken,
    );
    check('page1 total is 3', page1.body.total === 3, `${page1.body.total}`);
    check('page1 totalPages is 3', page1.body.totalPages === 3, `${page1.body.totalPages}`);

    console.log('5. attach — owner attaches the tag to their own asset');
    const attach = await api<TagDto[]>('POST', `/assets/${assetId}/tags`, ownerToken, { tagId });
    check('status', attach.status === 201, `${attach.status}`);
    check(
      'asset tag list contains the attached tag',
      attach.body.some((t) => t.id === tagId),
      'tag missing after attach',
    );

    console.log("6. authorization — another user cannot attach a tag to owner's asset");
    const crossAttach = await api('POST', `/assets/${assetId}/tags`, other.accessToken, { tagId });
    check('status', crossAttach.status === 403, `${crossAttach.status}`);

    console.log('7. attach — unknown tagId is rejected');
    const badTag = await api('POST', `/assets/${assetId}/tags`, ownerToken, {
      tagId: 'not-a-real-tag-id',
    });
    check('status', badTag.status === 404, `${badTag.status}`);

    console.log('8. detach — owner detaches the tag');
    const detach = await api<TagDto[]>('DELETE', `/assets/${assetId}/tags/${tagId}`, ownerToken);
    check('status', detach.status === 200, `${detach.status}`);
    check(
      'asset tag list no longer contains the tag',
      !detach.body.some((t) => t.id === tagId),
      'tag still present after detach',
    );

    if (state.failed) {
      console.error('\nOne or more tag checks FAILED.');
    } else {
      console.log('\nAll tag checks passed.');
    }
  } finally {
    console.log('9. cleanup');
    if (assetId) await assetRepository.delete(assetId);
    console.log('   asset deleted');
    for (const id of createdTagIds) {
      await tagRepository.delete(id);
    }
    console.log('   tags deleted:', createdTagIds.length);
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
