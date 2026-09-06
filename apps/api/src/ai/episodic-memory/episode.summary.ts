import type { ExecutionResult } from '../orchestrator/execution.result.js';
import type { CriticReport } from '../critic/critic.types.js';
import type { ReflectionReport } from '../reflection/reflection.types.js';
import type { DebateRecord } from '../debate/debate.types.js';
import type { ConsensusReport } from '../debate/consensus.types.js';
import type { Episode, EpisodeLessons } from './episode.types.js';

export interface LessonsInput {
  result: ExecutionResult;
  criticReport?: CriticReport;
  reflection?: ReflectionReport;
  debate?: DebateRecord;
  consensus?: ConsensusReport;
}

const LOW_CONFIDENCE_THRESHOLD = 0.6;
const LOW_AGREEMENT_THRESHOLD = 0.7;

// Reflection Integration (spec #6) — deterministic, heuristic derivation
// of "What Worked" / "What Failed" / "Lessons Learned" / "Future
// Suggestions" from data every completed execution already produces
// (ExecutionResult.steps, ReflectionReport, DebateRecord, ConsensusReport).
// Deliberately lives here rather than inside ReflectionEngine itself —
// ReflectionEngine's own output shape (ReflectionReport) is left
// untouched by this phase, keeping "Existing ... must remain" trivially
// true for it, the same way Phase 29 kept ai/langgraph untouched by
// building its own local helpers instead of reaching into it.
export function deriveLessons(input: LessonsInput): EpisodeLessons {
  const whatWorked: string[] = [];
  const whatFailed: string[] = [];
  const lessonsLearned: string[] = [];
  const futureSuggestions: string[] = [];

  for (const step of input.result.steps) {
    if (step.status === 'SUCCESS') {
      whatWorked.push(`${step.agentId} completed successfully in ${step.durationMs}ms`);
    } else if (step.status === 'FAILED') {
      whatFailed.push(`${step.agentId} failed${step.error ? `: ${step.error}` : ''}`);
    }
  }

  if (input.reflection) {
    for (const evidence of input.reflection.missingEvidence) {
      lessonsLearned.push(`Missing evidence: ${evidence}`);
    }
    for (const weak of input.reflection.weakRecommendations) {
      lessonsLearned.push(`Weak recommendation: ${weak}`);
    }
    if (input.reflection.overallConfidence < LOW_CONFIDENCE_THRESHOLD) {
      futureSuggestions.push(
        'Overall confidence was low — gather more evidence before acting on this goal again.',
      );
    }
  }

  if (input.debate?.triggered) {
    lessonsLearned.push(`Debate was triggered (${input.debate.triggerReasons.join(', ')})`);
  }

  if (input.consensus) {
    for (const conflict of input.consensus.conflicts) {
      lessonsLearned.push(`Conflict: ${conflict.description}`);
    }
    if (input.consensus.agreementScore < LOW_AGREEMENT_THRESHOLD) {
      futureSuggestions.push(
        'Agents disagreed significantly — review conflicting findings before trusting this outcome.',
      );
    }
  }

  if (whatFailed.length === 0 && whatWorked.length > 0) {
    lessonsLearned.push('All steps completed without failure.');
  }
  if (futureSuggestions.length === 0) {
    futureSuggestions.push('No specific follow-up flagged; outcome met expectations.');
  }

  return { whatWorked, whatFailed, lessonsLearned, futureSuggestions };
}

// Human-readable text embedded and indexed into the Knowledge Store
// (episode.indexer.ts) — this is what makes an episode findable by
// semantic similarity to a new goal.
export function buildEpisodeSummaryText(episode: Episode): string {
  const lines = [
    `Goal: ${episode.goal}`,
    `Outcome: ${episode.outcome} (confidence ${episode.confidence.toFixed(2)})`,
    `Agents involved: ${episode.agentsInvolved.join(', ') || 'none'}`,
  ];
  if (episode.failedSteps.length > 0) {
    lines.push(`Failed steps: ${episode.failedSteps.join(', ')}`);
  }
  if (episode.disagreements.length > 0) {
    lines.push(`Disagreements: ${episode.disagreements.join('; ')}`);
  }
  if (episode.lessons.whatWorked.length > 0) {
    lines.push(`What worked: ${episode.lessons.whatWorked.join('; ')}`);
  }
  if (episode.lessons.whatFailed.length > 0) {
    lines.push(`What failed: ${episode.lessons.whatFailed.join('; ')}`);
  }
  if (episode.lessons.lessonsLearned.length > 0) {
    lines.push(`Lessons learned: ${episode.lessons.lessonsLearned.join('; ')}`);
  }
  if (episode.lessons.futureSuggestions.length > 0) {
    lines.push(`Future suggestions: ${episode.lessons.futureSuggestions.join('; ')}`);
  }
  return lines.join('\n');
}
