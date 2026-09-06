import type { z } from 'zod';
import type { ToolDefinition } from '../../types/tool.types.js';
import type { AIContext } from '../../types/context.types.js';
import type { ToolRegistry } from '../../tools/tool-registry.js';
import { discoveryService } from '../../../services/discovery/discovery.service.js';
import { getOwnedAccount } from '../../../services/assets/account.service.js';
import { resourceRepository } from '../../../repositories/resource.repository.js';
import type { Requester } from '../../../services/assets/ownership.js';
import { ToolExecutionError } from '../../errors/index.js';
import {
  accountIdInputSchema,
  githubRepositoryToolOutputSchema,
  githubOrganizationToolOutputSchema,
  githubLanguageToolOutputSchema,
  githubTopicToolOutputSchema,
  placeholderToolOutputSchema,
} from './discovery.schemas.js';
import type { DiscoveryAgentResource, LanguageSummary, TopicSummary } from './discovery.types.js';
import type { Resource } from '../../../generated/prisma/client.js';

type AccountIdInput = z.infer<typeof accountIdInputSchema>;

// AIContextUser.role is a loosely-typed string (Phase 16's AIContext is
// provider/domain-agnostic); the reused ownership helpers require the
// stricter Requester['role'] union. Every value that reaches here already
// passed through Fastify's JWT auth, which only ever issues one of that
// union's members — this cast reflects that guarantee, it doesn't weaken it.
function toRequester(context: AIContext): Requester {
  return { id: context.user.id, role: context.user.role as Requester['role'] };
}

// Every tool in this file wraps EXISTING backend services — no GitHub API
// calls are made from here. `github_discover_repositories` is the one
// tool that actually triggers a real discovery run (via the existing
// `discoveryService.discover()`, unchanged); the read-only tools below it
// (`github_list_organizations`/`github_summarize_languages`/
// `github_summarize_topics`) shape already-persisted `Resource` rows —
// they never re-trigger discovery, so calling several tools in one agent
// run costs exactly one real GitHub round trip, not one per tool.

function toAgentResource(resource: Resource): DiscoveryAgentResource {
  return {
    id: resource.id,
    provider: resource.provider,
    providerResourceId: resource.providerResourceId,
    resourceType: resource.resourceType,
    displayName: resource.displayName,
    description: resource.description ?? undefined,
    externalUrl: resource.externalUrl ?? undefined,
    metadata: (resource.metadata as Record<string, unknown> | null) ?? {},
  };
}

export const githubRepositoryTool: ToolDefinition = {
  name: 'github_discover_repositories',
  description:
    "Runs a real GitHub discovery for the given account via the existing DiscoveryService — fetches the account's user profile, repositories, and organizations, persists them as Resources, and extracts relationships. This is the only tool in this file that performs a live discovery run.",
  inputSchema: accountIdInputSchema,
  outputSchema: githubRepositoryToolOutputSchema,
  async execute(input: AccountIdInput, context: AIContext) {
    const requester = toRequester(context);
    const result = await discoveryService.discover(input.accountId, requester);

    const persistedByProviderResourceId = new Map(
      (result.persisted?.resources ?? []).map((resource) => [
        resource.providerResourceId,
        resource,
      ]),
    );

    const shape = (resourceType: string): DiscoveryAgentResource[] =>
      result.resources
        .filter((resource) => resource.resourceType === resourceType)
        .map((resource) => {
          const persisted = persistedByProviderResourceId.get(resource.providerResourceId);
          return {
            id: persisted?.id,
            provider: resource.provider,
            providerResourceId: resource.providerResourceId,
            resourceType: resource.resourceType,
            displayName: resource.displayName,
            description: resource.description,
            externalUrl: resource.externalUrl,
            metadata: resource.metadata,
          };
        });

    return {
      success: result.success,
      resourceCount: result.resourceCount,
      repositories: shape('repository'),
      organizations: shape('organization'),
      relationships: {
        created: result.graph?.created ?? 0,
        updated: result.graph?.updated ?? 0,
        unchanged: result.graph?.unchanged ?? 0,
      },
      warnings: result.warnings,
      errors: result.errors,
    };
  },
};

export const githubOrganizationTool: ToolDefinition = {
  name: 'github_list_organizations',
  description:
    'Lists organizations already discovered and persisted for this account, read from the existing Resource store — does not trigger a new discovery run.',
  inputSchema: accountIdInputSchema,
  outputSchema: githubOrganizationToolOutputSchema,
  async execute(input: AccountIdInput, context: AIContext) {
    const requester = toRequester(context);
    await getOwnedAccount(input.accountId, requester);
    const resources = await resourceRepository.findActiveByAccount(input.accountId);
    return {
      organizations: resources
        .filter((resource) => resource.resourceType === 'organization')
        .map(toAgentResource),
    };
  },
};

export const githubLanguageTool: ToolDefinition = {
  name: 'github_summarize_languages',
  description:
    "Aggregates the primary language already recorded on each of this account's discovered repositories into a per-language repository count — a summary over existing data, not a new API call.",
  inputSchema: accountIdInputSchema,
  outputSchema: githubLanguageToolOutputSchema,
  async execute(input: AccountIdInput, context: AIContext) {
    const requester = toRequester(context);
    await getOwnedAccount(input.accountId, requester);
    const resources = await resourceRepository.findActiveByAccount(input.accountId);

    const counts = new Map<string, number>();
    for (const resource of resources) {
      if (resource.resourceType !== 'repository') continue;
      const metadata = (resource.metadata as Record<string, unknown> | null) ?? {};
      const language = typeof metadata.language === 'string' ? metadata.language : undefined;
      if (!language) continue;
      counts.set(language, (counts.get(language) ?? 0) + 1);
    }

    const languages: LanguageSummary[] = [...counts.entries()]
      .map(([language, repositoryCount]) => ({ language, repositoryCount }))
      .sort((a, b) => b.repositoryCount - a.repositoryCount);
    return { languages };
  },
};

export const githubTopicTool: ToolDefinition = {
  name: 'github_summarize_topics',
  description:
    "Aggregates the topics already recorded on each of this account's discovered repositories into a per-topic repository count — a summary over existing data, not a new API call.",
  inputSchema: accountIdInputSchema,
  outputSchema: githubTopicToolOutputSchema,
  async execute(input: AccountIdInput, context: AIContext) {
    const requester = toRequester(context);
    await getOwnedAccount(input.accountId, requester);
    const resources = await resourceRepository.findActiveByAccount(input.accountId);

    const counts = new Map<string, number>();
    for (const resource of resources) {
      if (resource.resourceType !== 'repository') continue;
      const metadata = (resource.metadata as Record<string, unknown> | null) ?? {};
      const topics = Array.isArray(metadata.topics) ? (metadata.topics as unknown[]) : [];
      for (const topic of topics) {
        if (typeof topic !== 'string') continue;
        counts.set(topic, (counts.get(topic) ?? 0) + 1);
      }
    }

    const topics: TopicSummary[] = [...counts.entries()]
      .map(([topic, repositoryCount]) => ({ topic, repositoryCount }))
      .sort((a, b) => b.repositoryCount - a.repositoryCount);
    return { topics };
  },
};

// The underlying GitHubDiscoveryProvider (services/discovery/github/) only
// fetches /user, /user/repos, /user/orgs — it does not call GitHub's
// branches/contributors/releases/actions/security-advisories/secret-scanning
// endpoints. Per this phase's "no duplicated API logic" / "do not rewrite
// existing discovery logic" rules, these tools are registered (so the
// Discovery Agent's tool surface matches the spec's full example list and
// future phases have a stable name/schema to implement against) but
// deliberately reject at call time rather than silently returning empty
// data or reaching around the existing provider to add new, unreviewed
// GitHub API calls here — the same pattern Phase 16 used for its
// interface-only LLM provider placeholders.
function placeholderGithubTool(name: string, description: string): ToolDefinition {
  return {
    name,
    description,
    inputSchema: accountIdInputSchema,
    outputSchema: placeholderToolOutputSchema,
    execute(_input, _context: AIContext) {
      return Promise.reject(
        new ToolExecutionError(
          name,
          'not yet supported — the underlying GitHubDiscoveryProvider does not fetch this data (Phase 18 scope)',
        ),
      );
    },
  };
}

export const githubBranchTool = placeholderGithubTool(
  'github_list_branches',
  'Placeholder — would list branches per repository via the GitHub branches API.',
);
export const githubContributorTool = placeholderGithubTool(
  'github_list_contributors',
  'Placeholder — would list contributors per repository via the GitHub contributors API.',
);
export const githubReleaseTool = placeholderGithubTool(
  'github_list_releases',
  'Placeholder — would list releases per repository via the GitHub releases API.',
);
export const githubWorkflowTool = placeholderGithubTool(
  'github_list_workflows',
  'Placeholder — would list GitHub Actions workflows per repository via the GitHub Actions API.',
);
export const githubSecurityTool = placeholderGithubTool(
  'github_list_security_advisories',
  'Placeholder — would list security advisories per repository via the GitHub security advisories API.',
);
export const githubSecretTool = placeholderGithubTool(
  'github_list_secret_scanning_alerts',
  'Future placeholder — would list secret scanning alerts per repository via the GitHub secret scanning API.',
);

export function registerGithubTools(toolRegistry: ToolRegistry): void {
  for (const tool of [
    githubRepositoryTool,
    githubOrganizationTool,
    githubLanguageTool,
    githubTopicTool,
    githubBranchTool,
    githubContributorTool,
    githubReleaseTool,
    githubWorkflowTool,
    githubSecurityTool,
    githubSecretTool,
  ]) {
    if (!toolRegistry.has(tool.name)) {
      toolRegistry.register(tool);
    }
  }
}
