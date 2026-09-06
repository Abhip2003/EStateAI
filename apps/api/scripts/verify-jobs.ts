import http from 'node:http';
import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import { accountRepository } from '../src/repositories/account.repository.js';
import { jobRepository } from '../src/repositories/job.repository.js';
import { jobService } from '../src/services/jobs/job.service.js';
import { jobExecutor } from '../src/services/jobs/job-executor.js';
import { JobType } from '../src/types/job.js';
import { prisma } from '../src/db/prisma.js';
import type { Requester } from '../src/services/assets/ownership.js';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';

const MOCK_PORT = 3999;
// Deliberately no substring overlap between these two (unlike naively
// naming them "valid-x"/"invalid-x", where "invalid-x".includes("valid-x")
// is true) — the mock's auth check below relies on that.
const VALID_CREDENTIAL = 'jobs-credential-good';
const INVALID_CREDENTIAL = 'jobs-credential-bad';

interface JobDto {
  id: string;
  status: string;
  priority: string;
  attempts: number;
  result: unknown;
  error: string | null;
}

interface EnqueueResponseDto {
  jobId: string;
  status: string;
  priority: string;
  queueDepth: number;
}

interface JobListDto {
  items: JobDto[];
}

interface EventDto {
  type: string;
  metadata: { jobId?: string } | null;
}

interface EventListDto {
  items: EventDto[];
}

function startMockGitHubServer(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization ?? '';
    const authorized = auth.includes(VALID_CREDENTIAL);

    if (req.method === 'GET' && req.url === '/user') {
      if (!authorized) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Bad credentials' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ login: 'verify-jobs-user', public_repos: 3, followers: 1 }));
      return;
    }

    if (req.method === 'GET' && req.url === '/user/repos') {
      if (!authorized) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }

    if (req.method === 'GET' && req.url === '/user/orgs') {
      if (!authorized) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }

    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, () => resolve(server)));
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs: number,
  intervalMs = 300,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  do {
    last = await fn();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  } while (Date.now() < deadline);
  return last;
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const stamp = Date.now();
  let categoryId: string | undefined;
  let assetId: string | undefined;
  const accountIds: string[] = [];
  const jobIds: string[] = [];
  let adminId: string | undefined;
  let ownerId: string | undefined;
  let otherId: string | undefined;
  const mockServer = await startMockGitHubServer();

  try {
    console.log('0. setup — admin+category, asset, owner + another user');
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('jobs');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-jobs-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const other = await registerAndLogin(`verify-jobs-other-${stamp}@example.test`);
    otherId = other.id;
    const ownerToken = owner.accessToken;
    const ownerUser = await userRepository.findById(owner.id);
    const ownerRequester: Requester = { id: owner.id, role: ownerUser?.role ?? 'USER' };

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-jobs-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const validAccountRes = await api<{ id: string }>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: VALID_CREDENTIAL,
      displayName: 'Jobs sync target',
    });
    const validAccountId = validAccountRes.body.id;
    accountIds.push(validAccountId);

    const invalidAccountRes = await api<{ id: string }>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: INVALID_CREDENTIAL,
      displayName: 'Jobs retry target',
    });
    const invalidAccountId = invalidAccountRes.body.id;
    accountIds.push(invalidAccountId);

    console.log('1. enqueue — POST /accounts/:id/sync returns a job envelope, not a result');
    const enqueueRes = await api<EnqueueResponseDto>(
      'POST',
      `/accounts/${validAccountId}/sync`,
      ownerToken,
    );
    check('status is 202', enqueueRes.status === 202, `${enqueueRes.status}`);
    check('jobId present', typeof enqueueRes.body.jobId === 'string');
    check('status is QUEUED', enqueueRes.body.status === 'QUEUED', enqueueRes.body.status);
    check('queueDepth is a number', typeof enqueueRes.body.queueDepth === 'number');
    const syncJobId = enqueueRes.body.jobId;
    jobIds.push(syncJobId);

    console.log('2. unauthorized — GET /jobs/:id without a token is rejected');
    const noAuth = await api('GET', `/jobs/${syncJobId}`, undefined);
    check('status', noAuth.status === 401, `${noAuth.status}`);

    console.log("3. cross-user isolation — another user cannot read owner's job");
    const crossGet = await api('GET', `/jobs/${syncJobId}`, other.accessToken);
    check('status', crossGet.status === 403, `${crossGet.status}`);

    console.log('4. worker execution — the live worker pool claims and completes the SYNC job');
    const completedSync = await pollUntil(
      () => api<JobDto>('GET', `/jobs/${syncJobId}`, ownerToken).then((r) => r.body),
      (job) => job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'DEAD',
      15_000,
    );
    check('status is COMPLETED', completedSync.status === 'COMPLETED', completedSync.status);
    check('result is present', completedSync.result !== null);

    console.log('5. discover job — POST /accounts/:id/discover also runs through the worker pool');
    const discoverEnqueueRes = await api<EnqueueResponseDto>(
      'POST',
      `/accounts/${validAccountId}/discover`,
      ownerToken,
    );
    check('status is 202', discoverEnqueueRes.status === 202, `${discoverEnqueueRes.status}`);
    const discoverJobId = discoverEnqueueRes.body.jobId;
    jobIds.push(discoverJobId);
    const completedDiscover = await pollUntil(
      () => api<JobDto>('GET', `/jobs/${discoverJobId}`, ownerToken).then((r) => r.body),
      (job) => job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'DEAD',
      15_000,
    );
    check(
      'discover job status is COMPLETED',
      completedDiscover.status === 'COMPLETED',
      completedDiscover.status,
    );

    console.log('6. event generation — JOB_CREATED/STARTED/COMPLETED emitted for the sync job');
    const eventsRes = await api<EventListDto>('GET', `/assets/${assetId}/events`, ownerToken);
    for (const type of ['JOB_CREATED', 'JOB_STARTED', 'JOB_COMPLETED']) {
      check(
        `${type} event exists`,
        eventsRes.body.items.some((e) => e.type === type && e.metadata?.jobId === syncJobId),
      );
    }

    console.log('7. priority ordering — CRITICAL claimed before NORMAL before LOW');
    const low = await jobRepository.create({ type: JobType.AI_ANALYSIS, priority: 'LOW' });
    const normal = await jobRepository.create({ type: JobType.AI_ANALYSIS, priority: 'NORMAL' });
    const critical = await jobRepository.create({
      type: JobType.AI_ANALYSIS,
      priority: 'CRITICAL',
    });
    jobIds.push(low.id, normal.id, critical.id);

    const claim1 = await jobRepository.claimNextJob('verify-priority-worker-1');
    const claim2 = await jobRepository.claimNextJob('verify-priority-worker-2');
    const claim3 = await jobRepository.claimNextJob('verify-priority-worker-3');
    check('1st claim is CRITICAL', claim1?.id === critical.id, claim1?.id);
    check('2nd claim is NORMAL', claim2?.id === normal.id, claim2?.id);
    check('3rd claim is LOW', claim3?.id === low.id, claim3?.id);

    console.log('8. duplicate prevention — an already-RUNNING job cannot be claimed again');
    const redundantClaim = await jobRepository.claimJobById(
      critical.id,
      'verify-priority-worker-4',
    );
    check('redundant claim returns null', redundantClaim === null);

    console.log(
      '9. heartbeat + worker restart — a stale RUNNING job is reclaimed and re-claimable',
    );
    await jobRepository.update(critical.id, {
      heartbeatAt: new Date(Date.now() - 10_000),
    });
    const reclaimedCount = await jobRepository.reclaimStaleJobs(1_000);
    check('at least one job reclaimed', reclaimedCount >= 1, `${reclaimedCount}`);
    const reclaimed = await jobRepository.findById(critical.id);
    check('reclaimed job is RETRYING', reclaimed?.status === 'RETRYING', reclaimed?.status);
    check('reclaimed job has no workerId', reclaimed?.workerId === null);

    const restartedClaim = await jobRepository.claimJobById(critical.id, 'verify-restarted-worker');
    check('restarted worker claims it', restartedClaim !== null);
    check(
      'new workerId differs from the dead one',
      restartedClaim?.workerId === 'verify-restarted-worker',
      restartedClaim?.workerId ?? 'null',
    );

    console.log('10. temporary failure → retry → dead-letter (real SYNC dispatch, bad credential)');
    const retryEnqueue = await jobService.enqueue({
      type: JobType.SYNC,
      requester: ownerRequester,
      accountId: invalidAccountId,
      assetId,
      maxAttempts: 2,
    });
    jobIds.push(retryEnqueue.job.id);

    const firstAttempt = await jobRepository.claimJobById(
      retryEnqueue.job.id,
      'verify-retry-worker',
    );
    check('first attempt claimed', firstAttempt !== null);
    if (firstAttempt) await jobExecutor.execute(firstAttempt, 'verify-retry-worker');
    const afterFirst = await jobRepository.findById(retryEnqueue.job.id);
    check(
      'status is RETRYING after 1st failure',
      afterFirst?.status === 'RETRYING',
      afterFirst?.status,
    );
    check('attempts is 1', afterFirst?.attempts === 1, `${afterFirst?.attempts}`);
    check('nextRetryAt is in the future', (afterFirst?.nextRetryAt?.getTime() ?? 0) > Date.now());

    // Simulate the backoff window elapsing, rather than waiting the real
    // ~60s — the retry mechanism itself (nextRetryAt gating claimJobById)
    // is already covered by check above; this step exercises exhaustion.
    await jobRepository.update(retryEnqueue.job.id, { nextRetryAt: new Date() });
    const secondAttempt = await jobRepository.claimJobById(
      retryEnqueue.job.id,
      'verify-retry-worker-2',
    );
    check('second attempt claimed', secondAttempt !== null);
    if (secondAttempt) await jobExecutor.execute(secondAttempt, 'verify-retry-worker-2');
    const afterSecond = await jobRepository.findById(retryEnqueue.job.id);
    check(
      'status is DEAD after exhausting maxAttempts',
      afterSecond?.status === 'DEAD',
      afterSecond?.status,
    );
    check('attempts is 2', afterSecond?.attempts === 2, `${afterSecond?.attempts}`);

    const retryEventsRes = await api<EventListDto>('GET', `/assets/${assetId}/events`, ownerToken);
    check(
      'JOB_RETRY event exists',
      retryEventsRes.body.items.some(
        (e) => e.type === 'JOB_RETRY' && e.metadata?.jobId === retryEnqueue.job.id,
      ),
    );
    check(
      'JOB_DEAD event exists',
      retryEventsRes.body.items.some(
        (e) => e.type === 'JOB_DEAD' && e.metadata?.jobId === retryEnqueue.job.id,
      ),
    );

    console.log('11. permanent failure — unsupported job type fails immediately, no retry');
    const permanentEnqueue = await jobService.enqueue({
      type: 'totally-unsupported-job-type',
      requester: ownerRequester,
      assetId,
    });
    jobIds.push(permanentEnqueue.job.id);
    const permanentClaim = await jobRepository.claimJobById(
      permanentEnqueue.job.id,
      'verify-permanent-worker',
    );
    if (permanentClaim) await jobExecutor.execute(permanentClaim, 'verify-permanent-worker');
    const afterPermanent = await jobRepository.findById(permanentEnqueue.job.id);
    check(
      'status is FAILED (not RETRYING/DEAD)',
      afterPermanent?.status === 'FAILED',
      afterPermanent?.status,
    );
    check('attempts is 1', afterPermanent?.attempts === 1);

    console.log('12. job cancellation — a QUEUED job can be cancelled, a terminal one cannot');
    const cancelEnqueue = await jobService.enqueue({
      type: JobType.AI_ANALYSIS,
      requester: ownerRequester,
      assetId,
    });
    jobIds.push(cancelEnqueue.job.id);
    const cancelRes = await api<JobDto>('POST', `/jobs/${cancelEnqueue.job.id}/cancel`, ownerToken);
    check('status', cancelRes.status === 200, `${cancelRes.status}`);
    check('job status is CANCELLED', cancelRes.body.status === 'CANCELLED', cancelRes.body.status);

    const doubleCancel = await api('POST', `/jobs/${cancelEnqueue.job.id}/cancel`, ownerToken);
    check(
      'cancelling a terminal job is rejected',
      doubleCancel.status === 409,
      `${doubleCancel.status}`,
    );

    console.log('13. manual retry endpoint — re-queues a DEAD job');
    const manualRetryRes = await api<JobDto>('POST', `/jobs/${afterSecond?.id}/retry`, ownerToken);
    check('status', manualRetryRes.status === 200, `${manualRetryRes.status}`);
    check(
      'job status is QUEUED',
      manualRetryRes.body.status === 'QUEUED',
      manualRetryRes.body.status,
    );
    check(
      'attempts reset to 0',
      manualRetryRes.body.attempts === 0,
      `${manualRetryRes.body.attempts}`,
    );

    console.log('14. listing — GET /jobs requires assetId for non-admins, then returns items');
    const listNoAsset = await api('GET', '/jobs', ownerToken);
    check('status without assetId is 403', listNoAsset.status === 403, `${listNoAsset.status}`);

    const listWithAsset = await api<JobListDto>('GET', `/jobs?assetId=${assetId}`, ownerToken);
    check('status with assetId is 200', listWithAsset.status === 200, `${listWithAsset.status}`);
    check(
      'listed jobs include the sync job',
      listWithAsset.body.items.some((j) => j.id === syncJobId),
    );

    if (state.failed) {
      console.error('\nOne or more job checks FAILED.');
    } else {
      console.log('\nAll job checks passed.');
    }
  } finally {
    console.log('15. cleanup');
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
    if (otherId) await userRepository.delete(otherId);
    console.log('   users deleted');
    await prisma.$disconnect();
  }

  if (state.failed) {
    process.exitCode = 1;
  }
}

void main();
