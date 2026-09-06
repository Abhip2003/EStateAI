// Phase 28 (LLM Planner) — planner.validator.ts's exact spec #5 rejection
// list: unknown agents, unknown tools, cycles, duplicate ids, missing
// dependencies, empty plans, invalid confidence — plus a control case
// confirming a well-formed plan passes and step ids/agent aliases are
// normalized correctly.
import { createChecker } from './lib/verify-helpers.js';
import { validatePlan, PlanValidationError } from '../src/ai/llm-planner/planner.validator.js';
import type { LLMPlanDraft } from '../src/ai/llm-planner/planner.parser.js';

function draft(overrides: Partial<LLMPlanDraft> = {}): LLMPlanDraft {
  return {
    reasoning: 'because',
    steps: [{ id: 's1', agent: 'discovery-agent', goal: 'discover', confidence: 0.8 }],
    overallConfidence: 0.8,
    ...overrides,
  };
}

function expectRejection(
  label: string,
  input: LLMPlanDraft,
  check: ReturnType<typeof createChecker>['check'],
): void {
  try {
    validatePlan(input);
    check(label, false, 'expected PlanValidationError, none thrown');
  } catch (err) {
    check(
      label,
      err instanceof PlanValidationError,
      err instanceof Error ? err.message : String(err),
    );
  }
}

function main(): void {
  const { check, state } = createChecker();

  console.log('1. valid plan is accepted');
  const valid = validatePlan(
    draft({
      steps: [
        {
          id: 's1',
          agent: 'discovery-agent',
          goal: 'discover',
          dependsOn: [],
          tools: ['github'],
          confidence: 0.9,
        },
        {
          id: 's2',
          agent: 'risk-agent',
          goal: 'score risk',
          dependsOn: ['s1'],
          tools: [],
          confidence: 0.8,
        },
      ],
    }),
  );
  check('accepted plan has 2 steps', valid.steps.length === 2);
  check('accepted step "s2" depends on "s1"', valid.steps[1].dependsOn.includes('s1'));
  check('accepted step tool "github" normalized', valid.steps[0].tools.includes('github'));

  console.log('2. agent alias normalization ("discovery" -> "discovery-agent")');
  const aliased = validatePlan(
    draft({ steps: [{ id: 's1', agent: 'Discovery', goal: 'x', confidence: 0.5 }] }),
  );
  check(
    'alias "Discovery" normalizes to "discovery-agent"',
    aliased.steps[0].agent === 'discovery-agent',
  );

  console.log('3. missing step id is auto-assigned');
  const autoId = validatePlan(
    draft({ steps: [{ agent: 'discovery-agent', goal: 'x', confidence: 0.5 }] }),
  );
  check('missing id auto-assigned as "step-1"', autoId.steps[0].id === 'step-1');

  console.log('4. rejections');
  expectRejection('empty plan rejected', draft({ steps: [] }), check);
  expectRejection(
    'unknown agent rejected',
    draft({ steps: [{ id: 's1', agent: 'time-travel-agent', goal: 'x', confidence: 0.5 }] }),
    check,
  );
  expectRejection(
    'unknown tool rejected',
    draft({
      steps: [
        { id: 's1', agent: 'discovery-agent', goal: 'x', tools: ['telepathy'], confidence: 0.5 },
      ],
    }),
    check,
  );
  expectRejection(
    'duplicate step id rejected',
    draft({
      steps: [
        { id: 's1', agent: 'discovery-agent', goal: 'x', confidence: 0.5 },
        { id: 's1', agent: 'risk-agent', goal: 'y', confidence: 0.5 },
      ],
    }),
    check,
  );
  expectRejection(
    'missing dependency rejected',
    draft({
      steps: [
        { id: 's1', agent: 'discovery-agent', goal: 'x', dependsOn: ['ghost'], confidence: 0.5 },
      ],
    }),
    check,
  );
  expectRejection(
    'invalid step confidence rejected',
    draft({ steps: [{ id: 's1', agent: 'discovery-agent', goal: 'x', confidence: 1.5 }] }),
    check,
  );
  expectRejection('invalid overallConfidence rejected', draft({ overallConfidence: -0.1 }), check);
  expectRejection(
    'dependency cycle rejected',
    draft({
      steps: [
        { id: 's1', agent: 'discovery-agent', goal: 'x', dependsOn: ['s2'], confidence: 0.5 },
        { id: 's2', agent: 'risk-agent', goal: 'y', dependsOn: ['s1'], confidence: 0.5 },
      ],
    }),
    check,
  );
  expectRejection(
    'self-referencing cycle rejected',
    draft({
      steps: [
        { id: 's1', agent: 'discovery-agent', goal: 'x', dependsOn: ['s1'], confidence: 0.5 },
      ],
    }),
    check,
  );

  console.log(state.failed ? '\nSome checks FAILED.' : '\nAll checks passed.');
  process.exitCode = state.failed ? 1 : 0;
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}
