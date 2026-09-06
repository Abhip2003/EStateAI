// Declares which tools each agent is allowed to call — the Phase 24
// spec's "every agent should declare which tools they can use." This is
// an allowlist checked by ToolExecutor.run() (not by ToolRegistry.execute(),
// which stays permission-agnostic for backward compatibility with every
// pre-Phase-24 internal call site that already calls it directly without
// an agentId). Each agent's own tool file names are always included, so
// an agent using only tools it registered itself continues to work with
// no change; the generic builtin tools (postgres/github/filesystem/
// websearch/knowledge) are added per agent based on what that agent
// plausibly needs.
export const AGENT_TOOL_ACCESS: Record<string, string[]> = {
  'discovery-agent': [
    'github_discover_repositories',
    'github_list_organizations',
    'github_summarize_languages',
    'github_summarize_topics',
  ],
  'risk-agent': [
    'risk_engine_score',
    'risk_asset_lookup',
    'risk_finding_store_list',
    'risk_repository_aggregate',
    'knowledge_search',
  ],
  'compliance-agent': [
    'compliance_engine_evaluate',
    'compliance_policy_lookup',
    'compliance_finding_lookup',
    'compliance_asset_lookup',
    'compliance_framework_mapping',
    'compliance_control_coverage',
    'compliance_evidence',
    'compliance_store',
    'postgres_query',
    'postgres_list_tables',
    'postgres_table_info',
    'knowledge_search',
  ],
  'recommendation-agent': [
    'recommendation_engine_list',
    'recommendation_finding_lookup',
    'recommendation_asset_lookup',
    'knowledge_search',
  ],
  'report-agent': ['report_asset_lookup', 'knowledge_search'],
  'copilot-agent': [
    'copilot_risk_lookup',
    'copilot_compliance_lookup',
    'copilot_recommendation_lookup',
    'copilot_asset_lookup',
    'knowledge_search',
    'github_repository_info',
    'github_repo_branches',
    'github_list_files',
    'github_commit_history',
    'github_list_pull_requests',
    'github_list_issues',
    'postgres_query',
    'postgres_list_tables',
    'postgres_table_info',
    'web_search',
  ],
};

// True if `agentId` is declared as allowed to call `toolName` — an
// unrecognized agentId (should never happen for a registered
// OrchestratorAgent) is denied by default, not allowed.
export function isToolAllowedForAgent(agentId: string, toolName: string): boolean {
  return AGENT_TOOL_ACCESS[agentId]?.includes(toolName) ?? false;
}
