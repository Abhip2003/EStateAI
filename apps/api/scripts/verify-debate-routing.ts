// Phase 29 — live-server HTTP surface (routes/debate.ts) + backward
// compatibility. POST /ai/debate/start, GET /ai/debate/:id, GET
// /ai/consensus/:id against a real running server and a real (empty,
// undiscovered) asset — Risk/Compliance/Recommendation Agents all
// gracefully handle an asset with no resources (zero findings, zero
// failures), so this exercises the real HTTP/auth/route wiring without
// needing a full discovery pipeline. Also confirms every pre-existing AI
// entry point (orchestrator/planner/langgraph/llm-planner) still
// responds unchanged.
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';
import { categoryRepository } from '../src/repositories/category.repository.js';

interface DebateRecordDto {
  debateId: string;
  assetId: string;
  triggered: boolean;
  triggerReasons: string[];
  turns: { agentId: string }[];
  consensus?: { consensusId: string; debateId: string };
}

interface ConsensusReportDto {
  consensusId: string;
  debateId: string;
  agreementScore: number;
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  let categoryId: string | undefined;

  try {
    console.log('0. setup — admin+category, owner, asset');
    const { categoryId: newCategoryId } = await createAdminAndCategory('debate-routing');
    categoryId = newCategoryId;
    const owner = await registerAndLogin(`verify-debate-routing-owner-${Date.now()}@example.test`);
    const assetRes = await api<{ id: string }>('POST', '/assets', owner.accessToken, {
      categoryId,
      name: `verify-debate-routing-asset-${Date.now()}`,
    });
    const assetId = assetRes.body.id;

    console.log('1. unauthenticated — POST /ai/debate/start rejects without a token');
    const noAuth = await api('POST', '/ai/debate/start', undefined, { assetId });
    check('status 401', noAuth.status === 401, `${noAuth.status}`);

    console.log('2. POST /ai/debate/start — runs a real debate against an empty asset');
    const startRes = await api<DebateRecordDto>('POST', '/ai/debate/start', owner.accessToken, {
      assetId,
    });
    check('status 200', startRes.status === 200, `${startRes.status}`);
    check('debateId present', typeof startRes.body.debateId === 'string');
    check('assetId echoed back', startRes.body.assetId === assetId);
    check(
      'the three analytical agents all took a turn',
      ['risk-agent', 'recommendation-agent', 'compliance-agent'].every((id) =>
        startRes.body.turns.some((turn) => turn.agentId === id),
      ),
    );
    check(
      'consensus is present iff the debate triggered',
      (startRes.body.triggered && startRes.body.consensus !== undefined) ||
        (!startRes.body.triggered && startRes.body.consensus === undefined),
    );

    console.log('3. GET /ai/debate/:id — reads the same record back');
    const getRes = await api<DebateRecordDto>(
      'GET',
      `/ai/debate/${startRes.body.debateId}`,
      owner.accessToken,
    );
    check('status 200', getRes.status === 200, `${getRes.status}`);
    check('same debateId', getRes.body.debateId === startRes.body.debateId);

    console.log('4. GET /ai/debate/:id — unknown id is 404');
    const notFound = await api('GET', '/ai/debate/no-such-debate', owner.accessToken);
    check('status 404', notFound.status === 404, `${notFound.status}`);

    if (startRes.body.consensus) {
      console.log('5. GET /ai/consensus/:id — reads the persisted ConsensusReport back');
      const consensusRes = await api<ConsensusReportDto>(
        'GET',
        `/ai/consensus/${startRes.body.consensus.consensusId}`,
        owner.accessToken,
      );
      check('status 200', consensusRes.status === 200, `${consensusRes.status}`);
      check(
        'same consensusId',
        consensusRes.body.consensusId === startRes.body.consensus.consensusId,
      );
      check('same debateId link', consensusRes.body.debateId === startRes.body.debateId);
    } else {
      console.log(
        '5. debate did not trigger for this run — skipping GET /ai/consensus/:id positive check',
      );
    }

    console.log('6. GET /ai/consensus/:id — unknown id is 404');
    const consensusNotFound = await api(
      'GET',
      '/ai/consensus/no-such-consensus',
      owner.accessToken,
    );
    check('status 404', consensusNotFound.status === 404, `${consensusNotFound.status}`);

    console.log('7. validation — missing assetId is 400');
    const badBody = await api('POST', '/ai/debate/start', owner.accessToken, {});
    check('status 400', badBody.status === 400, `${badBody.status}`);

    console.log('8. backward compatibility — every pre-existing AI entry point still responds');
    const orchestratorRes = await api('POST', '/ai/orchestrator/execute', owner.accessToken, {
      intent: 'risk-only',
    });
    check(
      'POST /ai/orchestrator/execute still 200',
      orchestratorRes.status === 200,
      `${orchestratorRes.status}`,
    );
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
    const dynamicPlannerRes = await api('POST', '/ai/planner/explain', owner.accessToken, {
      goal: 'risk analysis',
    });
    check(
      'POST /ai/planner/explain still 200',
      dynamicPlannerRes.status === 200,
      `${dynamicPlannerRes.status}`,
    );
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
