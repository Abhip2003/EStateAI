import type { ToolDefinition } from '../../types/tool.types.js';
import type { AIContext } from '../../types/context.types.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import { riskService } from '../../../services/analysis/risk.service.js';
import { findingService } from '../../../services/analysis/finding.service.js';
import { getOwnedAsset } from '../../../services/assets/ownership.js';
import { resourceRepository } from '../../../repositories/resource.repository.js';
import type { Requester } from '../../../services/assets/ownership.js';
import { ToolExecutionError } from '../../errors/index.js';
import {
  assetIdInputSchema,
  riskEngineToolOutputSchema,
  assetLookupToolOutputSchema,
  findingStoreToolOutputSchema,
  repositoryRiskToolOutputSchema,
  placeholderRiskToolOutputSchema,
} from './risk.schemas.js';
import type { z } from 'zod';

type AssetIdInput = z.infer<typeof assetIdInputSchema>;

const FINDINGS_PAGE_SIZE = 500;

// AIContextUser.role is a loosely-typed string (Phase 16's AIContext is
// provider/domain-agnostic); the reused ownership helpers require the
// stricter Requester['role'] union. Every value that reaches here already
// passed through Fastify's JWT auth, which only ever issues one of that
// union's members — this cast reflects that guarantee, it doesn't weaken
// it. Same pattern as discovery/github.tool.ts's toRequester().
function toRequester(context: AIContext): Requester {
  return { id: context.user.id, role: context.user.role as Requester['role'] };
}

// Every tool in this file wraps EXISTING backend services — no risk
// score or finding is ever computed here. RiskEngineTool/FindingStoreTool
// read already-persisted RiskScore/Finding rows (riskService/
// findingService, both unchanged); RepositoryRiskTool is a read-only
// aggregation over FindingStoreTool's own data. Categories the existing
// rule engine doesn't yet evaluate (secrets, branch protection, workflow
// risk, dependency risk, security alerts) are registered as placeholder
// tools below, mirroring Discovery Agent's github.tool.ts placeholders.

export const riskEngineTool: ToolDefinition = {
  name: 'risk_engine_score',
  description:
    'Reads the existing RiskScore row for an asset via the existing RiskService — the authoritative overallScore and severity counts. Never recalculates the score itself.',
  inputSchema: assetIdInputSchema,
  outputSchema: riskEngineToolOutputSchema,
  async execute(input: AssetIdInput, context: AIContext) {
    const requester = toRequester(context);
    const riskScore = await riskService.getForAsset(input.assetId, requester);
    return {
      overallScore: riskScore?.overallScore ?? 0,
      counts: {
        critical: riskScore?.criticalCount ?? 0,
        high: riskScore?.highCount ?? 0,
        medium: riskScore?.mediumCount ?? 0,
        low: riskScore?.lowCount ?? 0,
        informational: riskScore?.informationalCount ?? 0,
      },
    };
  },
};

export const assetLookupTool: ToolDefinition = {
  name: 'risk_asset_lookup',
  description:
    'Confirms ownership of the asset and returns a count of its currently discovered resources, grouped by resourceType — read from the existing Resource store, no new discovery is triggered.',
  inputSchema: assetIdInputSchema,
  outputSchema: assetLookupToolOutputSchema,
  async execute(input: AssetIdInput, context: AIContext) {
    const requester = toRequester(context);
    await getOwnedAsset(input.assetId, requester);
    const resources = await resourceRepository.findActiveByAsset(input.assetId);
    const resourcesByType: Record<string, number> = {};
    for (const resource of resources) {
      resourcesByType[resource.resourceType] = (resourcesByType[resource.resourceType] ?? 0) + 1;
    }
    return { assetId: input.assetId, resourceCount: resources.length, resourcesByType };
  },
};

export const findingStoreTool: ToolDefinition = {
  name: 'risk_finding_store_list',
  description:
    'Lists the existing OPEN findings for an asset via the existing FindingService — the authoritative set of security problems the rule engine has already identified. Never creates or recalculates a finding.',
  inputSchema: assetIdInputSchema,
  outputSchema: findingStoreToolOutputSchema,
  async execute(input: AssetIdInput, context: AIContext) {
    const requester = toRequester(context);
    const result = await findingService.list(requester, {
      assetId: input.assetId,
      status: 'OPEN',
      page: 1,
      limit: FINDINGS_PAGE_SIZE,
      sort: 'severity',
      order: 'desc',
    });
    return {
      findings: result.items.map((finding) => ({
        id: finding.id,
        resourceId: finding.resourceId,
        provider: finding.provider,
        ruleCode: finding.ruleCode,
        severity: finding.severity,
        status: finding.status,
        title: finding.title,
        description: finding.description,
        confidence: finding.confidence,
        createdAt: finding.createdAt.toISOString(),
      })),
      total: result.total,
    };
  },
};

export const repositoryRiskTool: ToolDefinition = {
  name: 'risk_repository_aggregate',
  description:
    "Groups this asset's existing OPEN findings by resource, surfacing a per-resource finding count and highest severity — a read-only aggregation over FindingStoreTool's own data, not a new evaluation.",
  inputSchema: assetIdInputSchema,
  outputSchema: repositoryRiskToolOutputSchema,
  async execute(input: AssetIdInput, context: AIContext) {
    const requester = toRequester(context);
    const result = await findingService.list(requester, {
      assetId: input.assetId,
      status: 'OPEN',
      page: 1,
      limit: FINDINGS_PAGE_SIZE,
    });

    const severityRank: Record<string, number> = {
      CRITICAL: 5,
      HIGH: 4,
      MEDIUM: 3,
      LOW: 2,
      INFORMATIONAL: 1,
    };

    const byResource = new Map<string, { count: number; highest: string }>();
    for (const finding of result.items) {
      const existing = byResource.get(finding.resourceId);
      if (!existing) {
        byResource.set(finding.resourceId, { count: 1, highest: finding.severity });
        continue;
      }
      existing.count += 1;
      if (severityRank[finding.severity] > severityRank[existing.highest]) {
        existing.highest = finding.severity;
      }
    }

    return {
      repositories: [...byResource.entries()].map(([resourceId, agg]) => ({
        resourceId,
        findingCount: agg.count,
        highestSeverity: agg.highest as 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'INFORMATIONAL',
      })),
    };
  },
};

// The existing rule engine (services/analysis/rules/github/) evaluates
// visibility/archived/empty/description/topics only — it has no rules
// for secrets, branch protection, workflow permissions, dependency
// vulnerabilities, or GitHub security advisories yet. Per this phase's
// "reuse the existing Risk Engine, do not rewrite it" rule, these tools
// are registered (so the Risk Agent's tool surface matches the spec's
// example list and future phases have a stable name/schema to implement
// against) but deliberately reject at call time rather than inventing new,
// unreviewed risk calculations here — the same pattern Discovery Agent
// used for branches/contributors/releases/workflows/security/secrets.
function placeholderRiskTool(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    inputSchema: assetIdInputSchema,
    outputSchema: placeholderRiskToolOutputSchema,
    execute(_input, _context: AIContext) {
      return Promise.reject(
        new ToolExecutionError(
          name,
          'not yet supported — the existing rule engine does not evaluate this category yet (Phase 19 scope)',
        ),
      );
    },
  };
}

export const secretsScannerTool = placeholderRiskTool(
  'risk_secrets_scanner',
  'Placeholder — would flag exposed secrets per repository via a future secret-scanning rule.',
);
export const branchProtectionTool = placeholderRiskTool(
  'risk_branch_protection',
  'Placeholder — would flag missing branch protection per repository via a future rule.',
);
export const workflowRiskTool = placeholderRiskTool(
  'risk_workflow_risk',
  'Placeholder — would flag risky GitHub Actions workflow permissions via a future rule.',
);
export const dependencyRiskTool = placeholderRiskTool(
  'risk_dependency_risk',
  'Placeholder — would flag vulnerable dependencies via a future rule.',
);
export const securityAlertTool = placeholderRiskTool(
  'risk_security_alert',
  'Placeholder — would surface GitHub security advisories per repository via a future rule.',
);

export function registerRiskTools(toolRegistry: ToolRegistry): void {
  for (const tool of [
    riskEngineTool,
    assetLookupTool,
    findingStoreTool,
    repositoryRiskTool,
    secretsScannerTool,
    branchProtectionTool,
    workflowRiskTool,
    dependencyRiskTool,
    securityAlertTool,
  ]) {
    if (!toolRegistry.has(tool.name)) {
      toolRegistry.register(tool);
    }
  }
}
