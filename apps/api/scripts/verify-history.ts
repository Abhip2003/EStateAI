// Phase 30 — live-server HTTP surface (routes/episodes.ts) + backward
// compatibility. Episode capture is fire-and-forget (captureEpisodeSafely
// is never awaited by its callers, mirroring knowledge.indexing.ts's
// indexAgentOutput — capture must never delay the execution it's
// observing), so every check that depends on a just-triggered capture
// having landed polls briefly instead of asserting immediately.
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';
import { categoryRepository } from '../src/repositories/category.repository.js';

interface EpisodeDto {
  episodeId: string;
  executionId: string;
  assetId?: string;
  goal: string;
  outcome: string;
}

async function waitFor<T>(
  fn: () => Promise<T>,
  isReady: (value: T) => boolean,
  attempts = 10,
): Promise<T> {
  let last: T;
  for (let i = 0; i < attempts; i += 1) {
    last = await fn();
    if (isReady(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return last!;
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  let categoryId: string | undefined;

  try {
    console.log('0. setup — admin+category, owner, asset');
    const { categoryId: newCategoryId } = await createAdminAndCategory('episode-history');
    categoryId = newCategoryId;
    const owner = await registerAndLogin(`verify-episode-history-owner-${Date.now()}@example.test`);
    const assetRes = await api<{ id: string }>('POST', '/assets', owner.accessToken, {
      categoryId,
      name: `verify-episode-history-asset-${Date.now()}`,
    });
    const assetId = assetRes.body.id;

    console.log('1. unauthenticated — POST /ai/episodes/search rejects without a token');
    const noAuth = await api('POST', '/ai/episodes/search', undefined, { goal: 'x' });
    check('status 401', noAuth.status === 401, `${noAuth.status}`);

    console.log('2. run a real execution against the asset (triggers automatic episode capture)');
    const orchestratorRes = await api('POST', '/ai/orchestrator/execute', owner.accessToken, {
      intent: 'risk-only',
      assets: [{ id: assetId }],
    });
    check(
      'POST /ai/orchestrator/execute 200',
      orchestratorRes.status === 200,
      `${orchestratorRes.status}`,
    );

    console.log('3. GET /ai/episodes/history — the captured episode eventually appears');
    const history = await waitFor(
      () =>
        api<{ episodes: EpisodeDto[] }>(
          'GET',
          `/ai/episodes/history?assetId=${assetId}`,
          owner.accessToken,
        ),
      (res) => res.status === 200 && res.body.episodes.length > 0,
    );
    check('status 200', history.status === 200, `${history.status}`);
    check('at least one episode captured for this asset', history.body.episodes.length > 0);
    const captured = history.body.episodes[0];
    check('captured episode is scoped to this asset', captured?.assetId === assetId);

    console.log('4. GET /ai/episodes/:id — reads the same episode back');
    const getRes = await api<EpisodeDto>(
      'GET',
      `/ai/episodes/${captured.episodeId}`,
      owner.accessToken,
    );
    check('status 200', getRes.status === 200, `${getRes.status}`);
    check('same episodeId', getRes.body.episodeId === captured.episodeId);

    console.log('5. GET /ai/episodes/:id — unknown id is 404');
    const notFound = await api('GET', '/ai/episodes/no-such-episode', owner.accessToken);
    check('status 404', notFound.status === 404, `${notFound.status}`);

    console.log('6. POST /ai/episodes/search — semantic search finds the captured episode');
    const searchRes = await api<{ matches: { episode: EpisodeDto; score: number }[] }>(
      'POST',
      '/ai/episodes/search',
      owner.accessToken,
      { goal: captured.goal, assetId, topK: 5 },
    );
    check('status 200', searchRes.status === 200, `${searchRes.status}`);
    check(
      'search returns the captured episode',
      searchRes.body.matches.some((m) => m.episode.episodeId === captured.episodeId),
    );

    console.log('7. GET /ai/episodes/statistics — reliability aggregates for this asset');
    const statsRes = await api<{
      episodeCount: number;
      agentReliability: unknown[];
      toolReliability: unknown[];
    }>('GET', `/ai/episodes/statistics?assetId=${assetId}`, owner.accessToken);
    check('status 200', statsRes.status === 200, `${statsRes.status}`);
    check(
      'episodeCount matches history size',
      statsRes.body.episodeCount === history.body.episodes.length,
    );
    check('agentReliability is an array', Array.isArray(statsRes.body.agentReliability));

    console.log('8. validation — missing goal on search is 400');
    const badSearch = await api('POST', '/ai/episodes/search', owner.accessToken, {});
    check('status 400', badSearch.status === 400, `${badSearch.status}`);

    console.log('9. validation — missing assetId on history is 400');
    const badHistory = await api('GET', '/ai/episodes/history', owner.accessToken);
    check('status 400', badHistory.status === 400, `${badHistory.status}`);

    console.log('10. backward compatibility — every pre-existing AI entry point still responds');
    const plannerRes = await api('POST', '/ai/planner/plan', owner.accessToken, {
      goal: 'risk analysis',
    });
    check('POST /ai/planner/plan still 200', plannerRes.status === 200, `${plannerRes.status}`);
    const langgraphRes = await api('POST', '/ai/langgraph/execute', owner.accessToken, {
      goal: 'risk analysis',
    });
    check(
      'POST /ai/langgraph/execute still 200',
      langgraphRes.status === 200,
      `${langgraphRes.status}`,
    );
    const debateRes = await api('POST', '/ai/debate/start', owner.accessToken, { assetId });
    check('POST /ai/debate/start still 200', debateRes.status === 200, `${debateRes.status}`);
  } finally {
    if (categoryId) await categoryRepository.delete(categoryId).catch(() => undefined);
  }

  console.log(state.failed ? '\nSome checks FAILED.' : '\nAll checks passed.');
  process.exitCode = state.failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
