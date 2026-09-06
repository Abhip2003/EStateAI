import { z } from 'zod';
import type { ToolDefinition } from '../../types/tool.types.js';
import type { AIContext } from '../../types/context.types.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import { complianceService } from '../../../services/policy/compliance.service.js';
import { policyService } from '../../../services/policy/policy.service.js';
import { findingService } from '../../../services/analysis/finding.service.js';
import { getOwnedAsset } from '../../../services/assets/ownership.js';
import { resourceRepository } from '../../../repositories/resource.repository.js';
import { policyResultRepository } from '../../../repositories/policy-result.repository.js';
import { policyRepository } from '../../../repositories/policy.repository.js';
import type { Requester } from '../../../services/assets/ownership.js';
import {
  assetIdInputSchema,
  complianceEngineToolOutputSchema,
  policyLookupToolOutputSchema,
  findingLookupToolOutputSchema,
  assetLookupToolOutputSchema,
  frameworkMappingToolOutputSchema,
  controlCoverageToolOutputSchema,
  evidenceToolOutputSchema,
  complianceStoreToolOutputSchema,
} from './compliance.schemas.js';
import { catalogForFramework, controlsForPolicy, frameworkName } from './compliance.mapping.js';
import type { ComplianceControlView } from './compliance.types.js';

type AssetIdInput = z.infer<typeof assetIdInputSchema>;

const PAGE_SIZE = 500;

// AIContextUser.role is a loosely-typed string (Phase 16's AIContext is
// provider/domain-agnostic); the reused ownership helpers require the
// stricter Requester['role'] union. Every value reaching here already
// passed through Fastify's JWT auth, which only ever issues one of that
// union's members — same cast pattern as risk.tool.ts's toRequester().
function toRequester(context: AIContext): Requester {
  return { id: context.user.id, role: context.user.role as Requester['role'] };
}

// Every tool in this file wraps EXISTING backend services (ComplianceService/
// PolicyService/FindingService/repositories) — no PolicyResult is ever
// recomputed here, and the compliance score is always read verbatim.
// FrameworkMappingTool/ControlCoverageTool/EvidenceTool add ONE genuinely
// new capability — framework/control mapping — that exists nowhere in the
// backend today (confirmed: no NIST/CIS/ISO/SOC2 concept anywhere in the
// schema), but they still only ever read already-persisted PolicyResult/
// Policy rows plus the static, code-owned catalog in compliance.mapping.ts;
// they never re-run PolicyEngine's rule evaluation or ComplianceService's
// score formula. Unlike Discovery/Risk Agents, no tool here is a
// call-time-rejecting placeholder — compliance mapping is agent-owned
// data, not bounded by an external provider's API surface, so every
// registered framework is fully functional from this phase.

export const complianceEngineTool: ToolDefinition = {
  name: 'compliance_engine_evaluate',
  description:
    'Reads the existing ComplianceReport for an asset via the existing ComplianceService — the authoritative complianceScore, pass/fail/warning/not-applicable counts, and policy outcomes. Never recalculates the score itself.',
  inputSchema: assetIdInputSchema,
  outputSchema: complianceEngineToolOutputSchema,
  async execute(input: AssetIdInput, context: AIContext) {
    const requester = toRequester(context);
    const report = await complianceService.getForAsset(input.assetId, requester);
    return {
      complianceScore: report.complianceScore,
      passCount: report.passCount,
      failCount: report.failCount,
      warningCount: report.warningCount,
      notApplicableCount: report.notApplicableCount,
      policyFailures: report.policyFailures,
      policyPasses: report.policyPasses,
    };
  },
};

export const policyLookupTool: ToolDefinition = {
  name: 'compliance_policy_lookup',
  description:
    'Lists the existing registered policy catalog via the existing PolicyService — read-only, never registers or evaluates a policy itself.',
  inputSchema: assetIdInputSchema,
  outputSchema: policyLookupToolOutputSchema,
  async execute(input: AssetIdInput, context: AIContext) {
    const requester = toRequester(context);
    const result = await policyService.list(requester, { page: 1, limit: PAGE_SIZE });
    return {
      policies: result.items.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        description: p.description,
        enabled: p.enabled,
        provider: p.provider,
        severity: p.severity,
      })),
      total: result.total,
    };
  },
};

export const findingLookupTool: ToolDefinition = {
  name: 'compliance_finding_lookup',
  description:
    'Lists this asset\'s existing OPEN findings via the existing FindingService — the "Risk Findings" context the Compliance Agent\'s assessment is grounded in. Never creates or recalculates a finding.',
  inputSchema: assetIdInputSchema,
  outputSchema: findingLookupToolOutputSchema,
  async execute(input: AssetIdInput, context: AIContext) {
    const requester = toRequester(context);
    const result = await findingService.list(requester, {
      assetId: input.assetId,
      status: 'OPEN',
      page: 1,
      limit: PAGE_SIZE,
    });
    return {
      findings: result.items.map((f) => ({
        id: f.id,
        resourceId: f.resourceId,
        ruleCode: f.ruleCode,
        severity: f.severity,
        title: f.title,
      })),
      total: result.total,
    };
  },
};

export const assetLookupTool: ToolDefinition = {
  name: 'compliance_asset_lookup',
  description:
    'Confirms ownership of the asset and returns a count of its currently discovered resources, grouped by resourceType — the "Asset Metadata" input the spec calls out, read from the existing Resource store.',
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

const frameworkMappingInputSchema = z.object({
  framework: z.enum(['NIST_CSF', 'CIS_CONTROLS', 'ISO_27001', 'SOC2']),
});
type FrameworkMappingInput = z.infer<typeof frameworkMappingInputSchema>;

export const frameworkMappingTool: ToolDefinition = {
  name: 'compliance_framework_mapping',
  description:
    "Returns a framework's full control catalog from the agent's own static mapping table (compliance.mapping.ts) — no backend call, since no existing service has a framework/control concept to wrap.",
  inputSchema: frameworkMappingInputSchema,
  outputSchema: frameworkMappingToolOutputSchema,
  execute(input: FrameworkMappingInput, _context: AIContext) {
    return Promise.resolve({ controls: catalogForFramework(input.framework) });
  },
};

const controlCoverageInputSchema = assetIdInputSchema.extend({
  framework: z.enum(['NIST_CSF', 'CIS_CONTROLS', 'ISO_27001', 'SOC2']),
});
type ControlCoverageInput = z.infer<typeof controlCoverageInputSchema>;

export const controlCoverageTool: ToolDefinition = {
  name: 'compliance_control_coverage',
  description:
    "Computes one framework's passed/failed/missing controls for an asset by joining the existing ComplianceReport's policy outcomes against compliance.mapping.ts's static catalog — never re-evaluates a policy.",
  inputSchema: controlCoverageInputSchema,
  outputSchema: controlCoverageToolOutputSchema,
  async execute(input: ControlCoverageInput, context: AIContext) {
    const requester = toRequester(context);
    const report = await complianceService.getForAsset(input.assetId, requester);
    const framework = input.framework;
    const catalog = catalogForFramework(framework);

    const covered = new Set<string>();
    const passedControls: ComplianceControlView[] = [];
    const failedControls: ComplianceControlView[] = [];

    for (const outcome of report.policyFailures) {
      for (const control of controlsForPolicy(outcome.policyCode, framework)) {
        covered.add(control.controlId);
        failedControls.push({
          framework,
          controlId: control.controlId,
          controlName: control.controlName,
          status: 'FAIL',
          policyCode: outcome.policyCode,
          policyName: outcome.policyName,
          resourceId: outcome.resourceId,
          reasoning: outcome.reason,
          evidence: [outcome.reason],
          priority: 'HIGH',
          confidence: 100,
        });
      }
    }
    for (const outcome of report.policyPasses) {
      for (const control of controlsForPolicy(outcome.policyCode, framework)) {
        covered.add(control.controlId);
        passedControls.push({
          framework,
          controlId: control.controlId,
          controlName: control.controlName,
          status: 'PASS',
          policyCode: outcome.policyCode,
          policyName: outcome.policyName,
          resourceId: outcome.resourceId,
          reasoning: outcome.reason,
          evidence: [outcome.reason],
          priority: 'LOW',
          confidence: 100,
        });
      }
    }

    const missingControls: ComplianceControlView[] = catalog
      .filter((control) => !covered.has(control.controlId))
      .map((control) => ({
        framework,
        controlId: control.controlId,
        controlName: control.controlName,
        status: 'MISSING',
        reasoning: `No registered policy currently evaluates "${control.controlName}" — this control has no coverage yet.`,
        evidence: [],
        priority: 'MEDIUM',
        confidence: 100,
      }));

    const coveragePercent =
      catalog.length === 0 ? 100 : Math.round((100 * covered.size) / catalog.length);

    return {
      framework,
      name: frameworkName(framework),
      passedControls,
      failedControls,
      missingControls,
      coveragePercent,
    };
  },
};

const evidenceInputSchema = z.object({
  policyCode: z.string().min(1),
  resourceId: z.string().min(1),
});
type EvidenceInput = z.infer<typeof evidenceInputSchema>;

export const evidenceTool: ToolDefinition = {
  name: 'compliance_evidence',
  description:
    'Builds evidence strings for one control from the underlying PolicyResult/Policy rows (existing repositories, unchanged) — reformats already-persisted evidence, never invents new evidence.',
  inputSchema: evidenceInputSchema,
  outputSchema: evidenceToolOutputSchema,
  async execute(input: EvidenceInput, _context: AIContext) {
    const policy = await policyRepository.findByCode(input.policyCode);
    if (!policy) {
      return { evidence: [] };
    }
    const result = await policyResultRepository.findByPolicyAndResource(
      policy.id,
      input.resourceId,
    );
    const evidence: string[] = [`Policy: ${policy.name} (${policy.code})`];
    if (result) {
      evidence.push(`Result: ${result.status} — ${result.reason}`);
      evidence.push(`Evaluated at: ${result.evaluatedAt.toISOString()}`);
    }
    return { evidence };
  },
};

export const complianceStoreTool: ToolDefinition = {
  name: 'compliance_store',
  description:
    "Returns the raw persisted PolicyResult rows for an asset's resources via the existing policyResultRepository — the actual compliance store, distinct from ComplianceEngineTool's aggregated report.",
  inputSchema: assetIdInputSchema,
  outputSchema: complianceStoreToolOutputSchema,
  async execute(input: AssetIdInput, context: AIContext) {
    const requester = toRequester(context);
    await getOwnedAsset(input.assetId, requester);
    const resources = await resourceRepository.findActiveByAsset(input.assetId);
    const results = await policyResultRepository.findByResourceIds(resources.map((r) => r.id));
    return {
      results: results.map((r) => ({
        id: r.id,
        policyId: r.policyId,
        resourceId: r.resourceId,
        status: r.status,
        reason: r.reason,
        evaluatedAt: r.evaluatedAt.toISOString(),
      })),
      total: results.length,
    };
  },
};

export function registerComplianceTools(toolRegistry: ToolRegistry): void {
  for (const tool of [
    complianceEngineTool,
    policyLookupTool,
    findingLookupTool,
    assetLookupTool,
    frameworkMappingTool,
    controlCoverageTool,
    evidenceTool,
    complianceStoreTool,
  ]) {
    if (!toolRegistry.has(tool.name)) {
      toolRegistry.register(tool);
    }
  }
}
