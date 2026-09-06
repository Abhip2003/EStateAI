import type { AgentTask } from './agent-task.js';

export interface ExecutionPlan {
  id: string;
  requestType: string;
  assetId: string;
  tasks: AgentTask[];
}

// The fixed catalog of request types any agent's supports()/plan() may
// react to. Free-form-string-shaped on purpose (same reasoning as
// Account.provider/JobType): a new request type is a new string an agent
// opts into via supports(), never a migration or a switch statement here.
export const RequestType = {
  DISCOVERY_SUMMARY: 'DISCOVERY_SUMMARY',
  RISK_SUMMARY: 'RISK_SUMMARY',
  COMPLIANCE_SUMMARY: 'COMPLIANCE_SUMMARY',
  RECOMMENDATIONS: 'RECOMMENDATIONS',
  SECURITY_REPORT: 'SECURITY_REPORT',
} as const;

export type RequestType = (typeof RequestType)[keyof typeof RequestType];

export const KNOWN_REQUEST_TYPES: RequestType[] = Object.values(RequestType);
