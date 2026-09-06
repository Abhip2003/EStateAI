import { recommendationService } from '../../analysis/recommendation.service.js';
import type { Agent, AgentPlanHint } from '../agent.interface.js';
import type { AgentContext } from '../agent-context.js';
import { RequestType } from '../dto/execution-plan.js';

class RecommendationAgent implements Agent {
  id(): string {
    return 'recommendation';
  }

  supports(requestType: string): boolean {
    return (
      requestType === RequestType.RECOMMENDATIONS || requestType === RequestType.SECURITY_REPORT
    );
  }

  // Depends on 'risk' — recommendations are risk-informed in the report
  // narrative (highest-priority recommendations should reflect the same
  // findings RiskAgent already summarized), even though
  // RecommendationService itself queries independently of RiskService.
  // This also gives the task graph a genuine sequential edge to exercise,
  // alongside discovery/risk/compliance's parallel wave.
  plan(): AgentPlanHint {
    return { dependsOn: ['risk'] };
  }

  async execute(context: AgentContext): Promise<Record<string, unknown>> {
    const recommendations = await context.getOrLoad('recommendations', () =>
      recommendationService.list(context.requester, {
        assetId: context.assetId,
        status: 'OPEN',
        sort: 'priority',
        order: 'desc',
        page: 1,
        limit: 20,
      }),
    );

    return {
      totalOpen: recommendations.total,
      prioritized: recommendations.items.map((rec) => ({
        id: rec.id,
        findingId: rec.findingId,
        priority: rec.priority,
        title: rec.title,
      })),
    };
  }
}

export const recommendationAgent = new RecommendationAgent();
