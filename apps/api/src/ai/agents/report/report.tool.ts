import type { ToolDefinition } from '../../types/tool.types.js';
import type { AIContext } from '../../types/context.types.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import { getOwnedAsset } from '../../../services/assets/ownership.js';
import { resourceRepository } from '../../../repositories/resource.repository.js';
import type { Requester } from '../../../services/assets/ownership.js';
import { assetIdInputSchema, assetLookupToolOutputSchema } from './report.schemas.js';
import type { z } from 'zod';

type AssetIdInput = z.infer<typeof assetIdInputSchema>;

function toRequester(context: AIContext): Requester {
  return { id: context.user.id, role: context.user.role as Requester['role'] };
}

// The Report Agent has no evaluation logic of its own to wrap — its job
// is pure aggregation over Discovery/Risk/Compliance/Recommendation
// Agent output already produced (via OrchestrationContext or their own
// memory). This is its only tool: confirms ownership of the target
// asset before anything is aggregated, same pattern every other agent
// uses as its first ownership check.
export const assetLookupTool: ToolDefinition = {
  name: 'report_asset_lookup',
  description:
    'Confirms ownership of the asset and returns a count of its currently discovered resources — the ownership check every report run starts from.',
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

export function registerReportTools(toolRegistry: ToolRegistry): void {
  for (const tool of [assetLookupTool]) {
    if (!toolRegistry.has(tool.name)) {
      toolRegistry.register(tool);
    }
  }
}
