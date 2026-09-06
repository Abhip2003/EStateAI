import type { ToolDefinition } from '../../types/tool.types.js';
import type { AIContext } from '../../types/context.types.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import { riskService } from '../../../services/analysis/risk.service.js';
import { findingService } from '../../../services/analysis/finding.service.js';
import { complianceService } from '../../../services/policy/compliance.service.js';
import { recommendationService } from '../../../services/analysis/recommendation.service.js';
import { getOwnedAsset } from '../../../services/assets/ownership.js';
import { resourceRepository } from '../../../repositories/resource.repository.js';
import type { Requester } from '../../../services/assets/ownership.js';
import {
  assetIdInputSchema,
  riskLookupToolOutputSchema,
  complianceLookupToolOutputSchema,
  recommendationLookupToolOutputSchema,
  assetLookupToolOutputSchema,
} from './copilot.schemas.js';
import type { z } from 'zod';

type AssetIdInput = z.infer<typeof assetIdInputSchema>;

const TOP_FINDINGS_LIMIT = 5;
const RECOMMENDATIONS_LIMIT = 20;

function toRequester(context: AIContext): Requester {
  return { id: context.user.id, role: context.user.role as Requester['role'] };
}

// Every tool here wraps an EXISTING backend service — the same "grounded
// answers over live data, never invented" principle Risk/Compliance/
// Recommendation Agents' own tools follow. Unlike those agents, Copilot
// has no "score" of its own to protect from LLM tampering — its whole
// job is explaining scores/findings/failures/recommendations that
// already exist, in prose, so these tools return slightly richer,
// answer-shaped data (top findings, not just counts) than the
// equivalent Risk/Compliance tools do.

export const riskLookupTool: ToolDefinition = {
  name: 'copilot_risk_lookup',
  description:
    'Reads the existing RiskScore and top OPEN findings for an asset via the existing RiskService/FindingService — grounds an "explain the risk" answer without recalculating anything.',
  inputSchema: assetIdInputSchema,
  outputSchema: riskLookupToolOutputSchema,
  async execute(input: AssetIdInput, context: AIContext) {
    const requester = toRequester(context);
    const riskScore = await riskService.getForAsset(input.assetId, requester);
    const findings = await findingService.list(requester, {
      assetId: input.assetId,
      status: 'OPEN',
      page: 1,
      limit: TOP_FINDINGS_LIMIT,
      sort: 'severity',
      order: 'desc',
    });
    return {
      overallScore: riskScore?.overallScore ?? 0,
      counts: {
        critical: riskScore?.criticalCount ?? 0,
        high: riskScore?.highCount ?? 0,
        medium: riskScore?.mediumCount ?? 0,
        low: riskScore?.lowCount ?? 0,
        informational: riskScore?.informationalCount ?? 0,
      },
      topFindings: findings.items.map((f) => ({
        id: f.id,
        title: f.title,
        severity: f.severity,
        resourceId: f.resourceId,
      })),
    };
  },
};

export const complianceLookupTool: ToolDefinition = {
  name: 'copilot_compliance_lookup',
  description:
    'Reads the existing ComplianceReport for an asset via the existing ComplianceService — grounds an "explain what failed compliance" answer without recalculating a score.',
  inputSchema: assetIdInputSchema,
  outputSchema: complianceLookupToolOutputSchema,
  async execute(input: AssetIdInput, context: AIContext) {
    const requester = toRequester(context);
    const report = await complianceService.getForAsset(input.assetId, requester);
    return {
      complianceScore: report.complianceScore,
      passCount: report.passCount,
      failCount: report.failCount,
      policyFailures: report.policyFailures,
    };
  },
};

export const recommendationLookupTool: ToolDefinition = {
  name: 'copilot_recommendation_lookup',
  description:
    'Lists the existing, persisted Recommendation rows for an asset via the existing RecommendationService — grounds an "explain recommendation N" answer without generating a new one.',
  inputSchema: assetIdInputSchema,
  outputSchema: recommendationLookupToolOutputSchema,
  async execute(input: AssetIdInput, context: AIContext) {
    const requester = toRequester(context);
    const result = await recommendationService.list(requester, {
      assetId: input.assetId,
      status: 'OPEN',
      page: 1,
      limit: RECOMMENDATIONS_LIMIT,
      sort: 'priority',
      order: 'desc',
    });
    return {
      recommendations: result.items.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        estimatedImpact: r.estimatedImpact ?? '',
        priority: r.priority,
      })),
      total: result.total,
    };
  },
};

export const assetLookupTool: ToolDefinition = {
  name: 'copilot_asset_lookup',
  description:
    'Confirms ownership of the asset and returns its currently discovered resource count — used to decide whether Intelligent Routing needs to trigger Discovery first.',
  inputSchema: assetIdInputSchema,
  outputSchema: assetLookupToolOutputSchema,
  async execute(input: AssetIdInput, context: AIContext) {
    const requester = toRequester(context);
    await getOwnedAsset(input.assetId, requester);
    const resources = await resourceRepository.findActiveByAsset(input.assetId);
    return { assetId: input.assetId, resourceCount: resources.length };
  },
};

export function registerCopilotTools(toolRegistry: ToolRegistry): void {
  for (const tool of [
    riskLookupTool,
    complianceLookupTool,
    recommendationLookupTool,
    assetLookupTool,
  ]) {
    if (!toolRegistry.has(tool.name)) {
      toolRegistry.register(tool);
    }
  }
}
