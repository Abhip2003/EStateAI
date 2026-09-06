import {
  findingRepository,
  type ListFindingsParams,
} from '../../repositories/finding.repository.js';
import { resourceRepository } from '../../repositories/resource.repository.js';
import { eventService } from '../assets/event.service.js';
import { getOwnedAsset, type Requester } from '../assets/ownership.js';
import { ForbiddenError } from '../auth/errors.js';
import { FindingNotFoundError } from './analysis-errors.js';
import { ruleEngine } from './rule-engine.js';
import { recommendationService } from './recommendation.service.js';
import './rules/index.js';
import type { AnalysisResult } from './dto/analysis-result.js';
import { Prisma, type Finding, type Resource } from '../../generated/prisma/client.js';
import type { PaginatedResult } from '../../repositories/pagination.js';

export interface EvaluateResourcesInput {
  resources: Resource[];
  provider: string;
  assetId: string;
  requester: Requester;
}

class FindingService {
  // Called by DiscoveryService right after resource persistence + graph
  // extraction, for every resource touched in that run (created, updated,
  // or unchanged — unchanged resources still need re-evaluation, since a
  // rule change or a metadata field that didn't affect the resource hash
  // could still change a finding). One rule-code per resource is the unit
  // of idempotency (Finding's @@unique([resourceId, ruleCode])):
  //   - rule matches, no existing OPEN finding  -> create, FINDING_CREATED
  //   - rule matches, existing RESOLVED finding -> reopen, FINDING_UPDATED
  //   - rule matches, existing OPEN finding     -> update if changed
  //   - rule stops matching, existing OPEN      -> resolve, FINDING_RESOLVED
  async evaluateResources(input: EvaluateResourcesInput): Promise<AnalysisResult> {
    const { findingsByResource, stats } = ruleEngine.evaluate(input.resources);

    let created = 0;
    let updated = 0;
    let resolved = 0;
    let recommendationsGenerated = 0;

    for (const resource of input.resources) {
      const candidates = findingsByResource.get(resource.id) ?? [];
      const matchedRuleCodes = new Set(candidates.map((c) => c.ruleCode));
      const existingOpen = await findingRepository.findOpenByResource(resource.id);
      const existingOpenByRule = new Map(existingOpen.map((f) => [f.ruleCode, f]));

      for (const candidate of candidates) {
        const existing = await findingRepository.findByResourceAndRule(
          resource.id,
          candidate.ruleCode,
        );

        if (!existing) {
          const finding = await findingRepository.create({
            resourceId: resource.id,
            provider: input.provider,
            ruleCode: candidate.ruleCode,
            severity: candidate.severity,
            title: candidate.title,
            description: candidate.description,
            confidence: candidate.confidence,
            metadata: candidate.metadata as Prisma.InputJsonValue | undefined,
          });
          created += 1;
          await this.emitEvent(input.assetId, input.requester, 'FINDING_CREATED', finding);
          await recommendationService.generateForFinding(finding, input.requester, input.assetId);
          recommendationsGenerated += 1;
          continue;
        }

        const reopening = existing.status === 'RESOLVED';
        const changed =
          existing.severity !== candidate.severity ||
          existing.title !== candidate.title ||
          existing.description !== candidate.description;

        if (reopening || changed) {
          const finding = await findingRepository.update(existing.id, {
            severity: candidate.severity,
            title: candidate.title,
            description: candidate.description,
            confidence: candidate.confidence,
            metadata: candidate.metadata as Prisma.InputJsonValue | undefined,
            status: 'OPEN',
            resolvedAt: null,
          });
          if (finding) {
            updated += 1;
            await this.emitEvent(input.assetId, input.requester, 'FINDING_UPDATED', finding);
            await recommendationService.reopenForFinding(finding.id);
          }
        }
      }

      for (const [ruleCode, existing] of existingOpenByRule) {
        if (matchedRuleCodes.has(ruleCode)) {
          continue;
        }
        const resolvedFinding = await findingRepository.update(existing.id, {
          status: 'RESOLVED',
          resolvedAt: new Date(),
        });
        if (resolvedFinding) {
          resolved += 1;
          await this.emitEvent(input.assetId, input.requester, 'FINDING_RESOLVED', resolvedFinding);
          await recommendationService.resolveForFinding(resolvedFinding.id);
        }
      }
    }

    return {
      rulesExecuted: stats.rulesExecuted,
      resourcesEvaluated: stats.resourcesEvaluated,
      findingsCreated: created,
      findingsUpdated: updated,
      findingsResolved: resolved,
      recommendationsGenerated,
      durationMs: stats.durationMs,
    };
  }

  async list(requester: Requester, params: ListFindingsParams): Promise<PaginatedResult<Finding>> {
    if (params.assetId) {
      await getOwnedAsset(params.assetId, requester);
    } else if (requester.role !== 'ADMIN') {
      throw new ForbiddenError('assetId is required to list findings');
    }
    return findingRepository.list(params);
  }

  async getById(id: string, requester: Requester): Promise<Finding> {
    const finding = await findingRepository.findById(id);
    if (!finding) {
      throw new FindingNotFoundError(id);
    }
    // Findings have no assetId column — authorization walks through the
    // Resource they belong to, same as ResourceSearchService/GraphService.
    const resource = await resourceRepository.findById(finding.resourceId);
    if (resource) {
      await getOwnedAsset(resource.assetId, requester);
    } else if (requester.role !== 'ADMIN') {
      throw new ForbiddenError('You do not have access to this finding');
    }
    return finding;
  }

  private async emitEvent(
    assetId: string,
    requester: Requester,
    type: string,
    finding: Finding,
  ): Promise<void> {
    try {
      await eventService.createForAsset(assetId, requester, {
        type,
        severity: 'INFO',
        title: `${type} — ${finding.ruleCode}`,
        metadata: {
          findingId: finding.id,
          resourceId: finding.resourceId,
          ruleCode: finding.ruleCode,
          severity: finding.severity,
          status: finding.status,
        },
      });
    } catch {
      // Best-effort — see ResourceService.emitEvent for the same reasoning.
    }
  }
}

export const findingService = new FindingService();
