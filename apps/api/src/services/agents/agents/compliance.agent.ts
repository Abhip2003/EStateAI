import { complianceService } from '../../policy/compliance.service.js';
import type { Agent, AgentPlanHint } from '../agent.interface.js';
import type { AgentContext } from '../agent-context.js';
import { RequestType } from '../dto/execution-plan.js';

class ComplianceAgent implements Agent {
  id(): string {
    return 'compliance';
  }

  supports(requestType: string): boolean {
    return (
      requestType === RequestType.COMPLIANCE_SUMMARY || requestType === RequestType.SECURITY_REPORT
    );
  }

  plan(): AgentPlanHint {
    return { dependsOn: [] };
  }

  async execute(context: AgentContext): Promise<Record<string, unknown>> {
    const report = await context.getOrLoad('complianceReport', () =>
      complianceService.getForAsset(context.assetId, context.requester),
    );

    return {
      complianceScore: report.complianceScore,
      passCount: report.passCount,
      failCount: report.failCount,
      warningCount: report.warningCount,
      notApplicableCount: report.notApplicableCount,
      policyFailures: report.policyFailures,
      riskDistribution: report.riskDistribution,
    };
  }
}

export const complianceAgent = new ComplianceAgent();
