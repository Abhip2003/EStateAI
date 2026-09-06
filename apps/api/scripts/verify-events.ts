import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import { eventRepository } from '../src/repositories/event.repository.js';
import { prisma } from '../src/db/prisma.js';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';

interface EventDto {
  id: string;
  type: string;
  severity: string;
  title: string;
}

interface EventListDto {
  items: EventDto[];
  total: number;
  totalPages: number;
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const stamp = Date.now();
  const createdEventIds: string[] = [];
  let categoryId: string | undefined;
  let assetId: string | undefined;
  let adminId: string | undefined;
  let ownerId: string | undefined;
  let otherId: string | undefined;

  try {
    console.log('0. setup — admin+category, asset, owner + another user');
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('event');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-event-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const other = await registerAndLogin(`verify-event-other-${stamp}@example.test`);
    otherId = other.id;

    const assetRes = await api<{ id: string }>('POST', '/assets', owner.accessToken, {
      categoryId,
      name: `verify-event-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    console.log('1. create — owner logs several events with varied severity/type');
    const seed = [
      { type: 'connected', severity: 'INFO', title: 'Account connected' },
      { type: 'sync_completed', severity: 'INFO', title: 'Sync finished' },
      { type: 'billing_changed', severity: 'WARNING', title: 'Plan changed' },
      { type: 'security_alert', severity: 'CRITICAL', title: 'Suspicious login' },
    ];
    for (const s of seed) {
      const res = await api<EventDto>('POST', `/assets/${assetId}/events`, owner.accessToken, s);
      check(`create "${s.type}" status`, res.status === 201, `${res.status}`);
      createdEventIds.push(res.body.id);
    }

    console.log("2. authorization — another user cannot log an event on owner's asset");
    const crossCreate = await api('POST', `/assets/${assetId}/events`, other.accessToken, {
      type: 'malicious',
      title: 'should not be allowed',
    });
    check('status', crossCreate.status === 403, `${crossCreate.status}`);

    console.log("3. ownership — another user cannot list events on owner's asset either");
    const crossList = await api('GET', `/assets/${assetId}/events`, other.accessToken);
    check('status', crossList.status === 403, `${crossList.status}`);

    console.log('4. list — owner sees the full timeline, newest first');
    const listRes = await api<EventListDto>(
      'GET',
      `/assets/${assetId}/events?limit=50`,
      owner.accessToken,
    );
    check('status', listRes.status === 200, `${listRes.status}`);
    check('total is 4', listRes.body.total === 4, `${listRes.body.total}`);
    check(
      'newest event first',
      listRes.body.items[0]?.type === 'security_alert',
      listRes.body.items[0]?.type,
    );

    console.log('5. filtering — severity=CRITICAL');
    const severityFiltered = await api<EventListDto>(
      'GET',
      `/assets/${assetId}/events?severity=CRITICAL`,
      owner.accessToken,
    );
    check(
      'only CRITICAL events returned',
      severityFiltered.body.items.every((e) => e.severity === 'CRITICAL'),
      'a non-CRITICAL event leaked through',
    );
    check(
      'exactly 1 CRITICAL event',
      severityFiltered.body.items.length === 1,
      `${severityFiltered.body.items.length}`,
    );

    console.log('6. filtering — type=billing_changed');
    const typeFiltered = await api<EventListDto>(
      'GET',
      `/assets/${assetId}/events?type=billing_changed`,
      owner.accessToken,
    );
    check(
      'only billing_changed events returned',
      typeFiltered.body.items.every((e) => e.type === 'billing_changed'),
      'a different type leaked through',
    );

    console.log('7. pagination — limit=2 across two pages');
    const page1 = await api<EventListDto>(
      'GET',
      `/assets/${assetId}/events?limit=2&page=1`,
      owner.accessToken,
    );
    const page2 = await api<EventListDto>(
      'GET',
      `/assets/${assetId}/events?limit=2&page=2`,
      owner.accessToken,
    );
    check('page1 has 2 items', page1.body.items.length === 2, `${page1.body.items.length}`);
    check(
      'page1 and page2 do not overlap',
      !page1.body.items.some((e) => page2.body.items.some((f) => f.id === e.id)),
      'overlapping items across pages',
    );

    console.log('8. validation — creating an event on a non-existent asset is rejected');
    const badAsset = await api('POST', '/assets/not-a-real-asset-id/events', owner.accessToken, {
      type: 'x',
      title: 'y',
    });
    check('status', badAsset.status === 404, `${badAsset.status}`);

    if (state.failed) {
      console.error('\nOne or more event checks FAILED.');
    } else {
      console.log('\nAll event checks passed.');
    }
  } finally {
    console.log('9. cleanup');
    for (const id of createdEventIds) {
      await eventRepository.delete(id);
    }
    console.log('   events deleted:', createdEventIds.length);
    if (assetId) await assetRepository.delete(assetId);
    console.log('   asset deleted');
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
