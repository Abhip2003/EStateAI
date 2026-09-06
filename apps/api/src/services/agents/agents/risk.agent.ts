import { findingService } from '../../analysis/finding.service.js';
import { riskService } from '../../analysis/risk.service.js';
import type { Agent, AgentPlanHint } from '../agent.interface.js';
import type { AgentContext } from '../agent-context.js';
import { RequestType } from '../dto/execution-plan.js';

class RiskAgent implements Agent {
  id(): string {
    return 'risk';
  }

  supports(requestType: string): boolean {
    return requestType === RequestType.RISK_SUMMARY || requestType === RequestType.SECURITY_REPORT;
  }

  plan(): AgentPlanHint {
    return { dependsOn: [] };
  }

  async execute(context: AgentContext): Promise<Record<string, unknown>> {
    const riskScore = await context.getOrLoad('riskScore', () =>
      riskService.getForAsset(context.assetId, context.requester),
    );
    const openFindings = await context.getOrLoad('openFindings', () =>
      findingService.list(context.requester, {
        assetId: context.assetId,
        status: 'OPEN',
        sort: 'severity',
        order: 'desc',
        page: 1,
        limit: 100,
      }),
    );

    return {
      overallScore: riskScore?.overallScore ?? 0,
      severityCounts: riskScore
        ? {
            critical: riskScore.criticalCount,
            high: riskScore.highCount,
            medium: riskScore.mediumCount,
            low: riskScore.lowCount,
            informational: riskScore.informationalCount,
          }
        : null,
      openFindingsCount: openFindings.total,
      topFindings: openFindings.items.slice(0, 5).map((finding) => ({
        id: finding.id,
        ruleCode: finding.ruleCode,
        severity: finding.severity,
        title: finding.title,
      })),
    };
  }
}

export const riskAgent = new RiskAgent();
