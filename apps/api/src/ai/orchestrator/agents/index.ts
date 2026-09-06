export type { OrchestratorAgent } from './agent.interface.js';
export type { DiscoveryAgent } from './discovery-agent.interface.js';
export type { RiskAgent } from './risk-agent.interface.js';
export type { ComplianceAgent } from './compliance-agent.interface.js';
export type { RecommendationAgent } from './recommendation-agent.interface.js';
export type { ReportAgent } from './report-agent.interface.js';
export type { CopilotAgent } from './copilot-agent.interface.js';

// Intentionally no implementations and no registrations here — Phase 17
// scope forbids implementing any of these agents. This barrel exists so a
// future phase's concrete agents/index.ts can import the interfaces
// without reaching into individual files, matching the pattern
// src/ai/index.ts already established for Phase 16.
