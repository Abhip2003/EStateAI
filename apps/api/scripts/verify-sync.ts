import http from 'node:http';
import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import { accountRepository } from '../src/repositories/account.repository.js';
import { jobRepository } from '../src/repositories/job.repository.js';
import { prisma } from '../src/db/prisma.js';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';

const MOCK_PORT = 3999;
const MOCK_GITHUB_USER_ID = 990011;

interface AccountDto {
  id: string;
}

interface EnqueueResponseDto {
  jobId: string;
  status: string;
}

interface JobDto {
  status: string;
  error: string | null;
  result: { success?: boolean; resourcesDiscovered?: number } | null;
}

// Phase 4 turned /accounts/:id/sync into an async enqueue — this polls
// GET /jobs/:id the way a real client would, instead of expecting a
// synchronous result body.
async function pollJobSettled(jobId: string, token: string, timeoutMs = 15_000): Promise<JobDto> {
  const deadline = Date.now() + timeoutMs;
  let last: JobDto;
  do {
    const res = await api<JobDto>('GET', `/jobs/${jobId}`, token);
    last = res.body;
    if (last.status !== 'QUEUED' && last.status !== 'RUNNING') {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  } while (Date.now() < deadline);
  return last!;
}

function startMockGitHubServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/user') {
      const auth = req.headers.authorization ?? '';
      if (auth.includes('invalid-sync-credential')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Bad credentials' }));
        return;
      }
      if (auth.includes('unavailable-sync-credential')) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: MOCK_GITHUB_USER_ID,
          login: 'verify-sync-user',
          name: 'Verify Sync User',
          public_repos: 7,
          followers: 3,
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(MOCK_PORT, () => resolve(server));
  });
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const stamp = Date.now();
  const VALID_CREDENTIAL = 'valid-sync-credential';
  const INVALID_CREDENTIAL = 'invalid-sync-credential';
  const UNAVAILABLE_CREDENTIAL = 'unavailable-sync-credential';
  let categoryId: string | undefined;
  let assetId: string | undefined;
  const accountIds: string[] = [];
  const jobIds: string[] = [];
  let adminId: string | undefined;
  let ownerId: string | undefined;
  const mockServer = await startMockGitHubServer();

  try {
    console.log('0. setup — admin+category, asset, owner');
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('sync');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-sync-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-sync-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    console.log('1. unauthorized — sync without a token is rejected');
    const connectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'Sync target',
    });
    const validAccountId = connectRes.body.id;
    accountIds.push(validAccountId);
    const noAuth = await api('POST', `/accounts/${validAccountId}/sync`, undefined);
    check('status', noAuth.status === 401, `${noAuth.status}`);

    console.log('2. enqueue — POST /accounts/:id/sync returns a job envelope (202)');
    const enqueueRes = await api<EnqueueResponseDto>(
      'POST',
      `/accounts/${validAccountId}/sync`,
      ownerToken,
    );
    check('status', enqueueRes.status === 202, `${enqueueRes.status}`);
    check('jobId present', typeof enqueueRes.body.jobId === 'string');
    jobIds.push(enqueueRes.body.jobId);

    console.log('3. successful sync — job completes and carries a SyncResult-shaped result');
    const settled = await pollJobSettled(enqueueRes.body.jobId, ownerToken);
    check('job status is COMPLETED', settled.status === 'COMPLETED', settled.status);
    check('result.success is true', settled.result?.success === true);
    check('resourcesDiscovered matches mock (7)', settled.result?.resourcesDiscovered === 7);

    console.log('4. account status updates — connectionStatus is "synced", lastSyncedAt is set');
    const rawValid = await accountRepository.findById(validAccountId);
    check(
      'connectionStatus is synced',
      rawValid?.connectionStatus === 'synced',
      rawValid?.connectionStatus,
    );
    check('lastSyncedAt is set', rawValid?.lastSyncedAt !== null);

    console.log('5. AssetEvents created — SyncService still emits its own ACCOUNT_SYNC_* events');
    const eventsRes = await api<{
      items: { type: string; metadata: { accountId?: string } | null }[];
    }>('GET', `/assets/${assetId}/events`, ownerToken);
    const startedEvent = eventsRes.body.items.find(
      (e) => e.type === 'ACCOUNT_SYNC_STARTED' && e.metadata?.accountId === validAccountId,
    );
    const completedEvent = eventsRes.body.items.find(
      (e) => e.type === 'ACCOUNT_SYNC_COMPLETED' && e.metadata?.accountId === validAccountId,
    );
    check('ACCOUNT_SYNC_STARTED event exists', startedEvent !== undefined);
    check('ACCOUNT_SYNC_COMPLETED event exists', completedEvent !== undefined);

    console.log('6. invalid credential — job attempted, account marked error, job goes RETRYING');
    const invalidConnectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: INVALID_CREDENTIAL,
      displayName: 'Invalid credential target',
    });
    const invalidAccountId = invalidConnectRes.body.id;
    accountIds.push(invalidAccountId);
    const invalidEnqueue = await api<EnqueueResponseDto>(
      'POST',
      `/accounts/${invalidAccountId}/sync`,
      ownerToken,
    );
    jobIds.push(invalidEnqueue.body.jobId);
    const invalidSettled = await pollJobSettled(invalidEnqueue.body.jobId, ownerToken);
    check(
      'job status is RETRYING (temporary failure, default maxAttempts)',
      invalidSettled.status === 'RETRYING',
      invalidSettled.status,
    );
    const rawInvalid = await accountRepository.findById(invalidAccountId);
    check(
      'connectionStatus is error',
      rawInvalid?.connectionStatus === 'error',
      rawInvalid?.connectionStatus,
    );
    check('lastSyncedAt was not set', rawInvalid?.lastSyncedAt === null);

    console.log('7. provider unavailable — same temporary-failure path');
    const unavailableConnectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: UNAVAILABLE_CREDENTIAL,
      displayName: 'Unavailable target',
    });
    const unavailableAccountId = unavailableConnectRes.body.id;
    accountIds.push(unavailableAccountId);
    const unavailableEnqueue = await api<EnqueueResponseDto>(
      'POST',
      `/accounts/${unavailableAccountId}/sync`,
      ownerToken,
    );
    jobIds.push(unavailableEnqueue.body.jobId);
    const unavailableSettled = await pollJobSettled(unavailableEnqueue.body.jobId, ownerToken);
    check(
      'job status is RETRYING',
      unavailableSettled.status === 'RETRYING',
      unavailableSettled.status,
    );
    const rawUnavailable = await accountRepository.findById(unavailableAccountId);
    check('connectionStatus is error', rawUnavailable?.connectionStatus === 'error');

    console.log('8. unsupported provider — permanent failure, job goes straight to FAILED');
    const unknownConnectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'totally-unsupported-provider',
      credential: 'irrelevant',
      displayName: 'Unsupported provider target',
    });
    accountIds.push(unknownConnectRes.body.id);
    const unknownEnqueue = await api<EnqueueResponseDto>(
      'POST',
      `/accounts/${unknownConnectRes.body.id}/sync`,
      ownerToken,
    );
    jobIds.push(unknownEnqueue.body.jobId);
    const unknownSettled = await pollJobSettled(unknownEnqueue.body.jobId, ownerToken);
    check(
      'job status is FAILED (permanent, not retried)',
      unknownSettled.status === 'FAILED',
      unknownSettled.status,
    );

    if (state.failed) {
      console.error('\nOne or more sync checks FAILED.');
    } else {
      console.log('\nAll sync checks passed.');
    }
  } finally {
    console.log('9. cleanup');
    mockServer.close();
    for (const id of jobIds) {
      await jobRepository.delete(id);
    }
    console.log('   jobs deleted:', jobIds.length);
    for (const id of accountIds) {
      await accountRepository.delete(id);
    }
    console.log('   accounts deleted:', accountIds.length);
    if (assetId) await assetRepository.delete(assetId);
    console.log('   asset deleted');
    if (categoryId) await categoryRepository.delete(categoryId);
    console.log('   category deleted');
    if (adminId) await userRepository.delete(adminId);
    if (ownerId) await userRepository.delete(ownerId);
    console.log('   users deleted');
    await prisma.$disconnect();
  }

  if (state.failed) {
    process.exitCode = 1;
  }
}

void main();
