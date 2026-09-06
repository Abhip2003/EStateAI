import { credentialEncryptionService } from '../credential-encryption.service.js';
import { getOwnedAccount } from '../assets/account.service.js';
import { eventService } from '../assets/event.service.js';
import { discoveryDurationSeconds } from '../../observability/metrics.js';
import type { Requester } from '../assets/ownership.js';
import { discoveryProviderRegistry } from './discovery-registry.js';
import { DiscoveryProviderError } from './discovery-errors.js';
import { resourceService, type PersistResourcesResult } from '../resources/resource.service.js';
import {
  relationshipService,
  type ExtractAndPersistResult,
} from '../graph/relationship.service.js';
import { findingService } from '../analysis/finding.service.js';
import { riskService } from '../analysis/risk.service.js';
import { policyService, type PolicyEvaluationSummary } from '../policy/policy.service.js';
import { complianceService } from '../policy/compliance.service.js';
import type { AnalysisResult } from '../analysis/dto/analysis-result.js';
import type { DiscoveredResource } from './dto/discovered-resource.js';
import type { DiscoveryResult } from './dto/discovery-result.js';

class DiscoveryService {
  // Orchestration only — no HTTP calls happen here, only inside
  // provider.discover(). Deliberately does not touch Account.lastSyncedAt
  // or Account.connectionStatus: those belong to SyncService's lifecycle,
  // not discovery's. Persists every discovered resource via
  // ResourceService (Phase 5A) — a persistence failure is captured in
  // `errors` like any other discovery failure, it does not crash the call.
  async discover(accountId: string, requester: Requester): Promise<DiscoveryResult> {
    const account = await getOwnedAccount(accountId, requester);
    // Unsupported provider is a structural problem, not a failed discovery
    // attempt — resolved before anything is attempted, and propagated as a
    // real error rather than folded into the DiscoveryResult.
    const provider = discoveryProviderRegistry.getProvider(account.provider);

    const startedAt = new Date();
    await eventService.createForAsset(account.assetId, requester, {
      type: 'DISCOVERY_STARTED',
      severity: 'INFO',
      title: `Discovery started for ${account.provider} account`,
      metadata: { accountId, provider: account.provider },
    });

    const warnings: string[] = [];
    const errors: string[] = [];
    let resources: DiscoveredResource[] = [];
    let persisted: PersistResourcesResult | undefined;
    let graph: ExtractAndPersistResult | undefined;
    let analysis: AnalysisResult | undefined;
    let policy: PolicyEvaluationSummary | undefined;
    let success = false;

    try {
      if (!account.credentialCiphertext) {
        throw new DiscoveryProviderError('No credential is stored for this account');
      }
      // Decrypted only in memory for the duration of this call — never
      // logged, never included in the DiscoveryResult or any AssetEvent.
      const credential = credentialEncryptionService.decrypt(account.credentialCiphertext);

      resources = await provider.discover(credential);

      // Persistence is part of a successful discovery, not a side concern
      // — if it throws, the whole attempt is a failure (same as a failed
      // provider call), caught below like everything else in this block.
      persisted = await resourceService.persist({
        accountId,
        assetId: account.assetId,
        resources,
        requester,
      });

      // After persistence, not before — extraction needs the real
      // Resource.id values persist() just produced, not the provider's
      // own ids.
      graph = await relationshipService.extractAndPersist(
        account.provider,
        resources,
        persisted.resources,
        requester,
        account.assetId,
      );

      // Analysis runs last, against the persisted Resource rows (real ids,
      // current field values) — never the raw DiscoveredResource batch.
      // Findings drive Recommendations (inside FindingService) and both
      // feed RiskService's recalculation for every scope this run touched.
      analysis = await findingService.evaluateResources({
        resources: persisted.resources,
        provider: account.provider,
        assetId: account.assetId,
        requester,
      });
      await riskService.recalculate(
        {
          resourceIds: persisted.resources.map((r) => r.id),
          accountId,
          assetId: account.assetId,
        },
        requester,
      );

      // Policies run last, against the same persisted Resource rows and
      // their now-current Findings — a Policy consumes what the Rule
      // Engine already detected, it never re-inspects the provider.
      // Compliance is recomputed fresh from the PolicyResult rows this
      // run just wrote, not carried forward from analysis's counts.
      policy = await policyService.evaluateResources({
        resources: persisted.resources,
        provider: account.provider,
        assetId: account.assetId,
        requester,
      });
      await complianceService.recalculateAndNotify(account.assetId, requester);

      success = true;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : 'Unknown discovery failure');
    }

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();
    discoveryDurationSeconds.observe(
      { provider: account.provider, success: String(success) },
      durationMs / 1000,
    );

    await eventService.createForAsset(account.assetId, requester, {
      type: success ? 'DISCOVERY_COMPLETED' : 'DISCOVERY_FAILED',
      severity: success ? 'INFO' : 'ERROR',
      title: success
        ? `Discovery completed for ${account.provider} account`
        : `Discovery failed for ${account.provider} account`,
      metadata: {
        accountId,
        provider: account.provider,
        resourceCount: resources.length,
        duration: durationMs,
        warnings,
        errors,
      },
    });

    return {
      success,
      provider: account.provider,
      accountId,
      resources,
      resourceCount: resources.length,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs,
      warnings,
      errors,
      persisted,
      graph,
      analysis,
      policy,
    };
  }
}

export const discoveryService = new DiscoveryService();
