// Side-effect-only import: each agent file self-registers into
// agentRegistry on load, same pattern as services/policy/policies/index.ts
// and services/analysis/rules/index.ts. Adding a new agent means creating
// the file and adding one more import line here; nothing else changes.
import { agentRegistry } from '../agent-registry.js';
import { discoveryAgent } from './discovery.agent.js';
import { riskAgent } from './risk.agent.js';
import { complianceAgent } from './compliance.agent.js';
import { recommendationAgent } from './recommendation.agent.js';
import { reportAgent } from './report.agent.js';

agentRegistry.register(discoveryAgent);
agentRegistry.register(riskAgent);
agentRegistry.register(complianceAgent);
agentRegistry.register(recommendationAgent);
agentRegistry.register(reportAgent);
