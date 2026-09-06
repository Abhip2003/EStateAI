import type { Framework, FrameworkControl, FrameworkCapability } from './compliance.types.js';

// Static, code-owned framework/control catalogs and their mapping to
// existing Policy codes (services/policy/policies/github/*.policy.ts).
// Neither the Prisma schema nor any existing service has a framework or
// control concept — this file is the ONE place that introduces it, as a
// read-only data layer over already-persisted PolicyResult/Policy rows,
// never a re-implementation of PolicyEngine's own rule evaluation or
// ComplianceService's own score formula (see compliance.executor.ts's
// top comment for why complianceScore is always read verbatim, never
// recomputed per framework).
//
// These are a reasonable, illustrative mapping — not a certified auditor
// crosswalk — documented as such rather than implying more authority than
// exists. Coverage is naturally bounded by which policies exist today (5
// GitHub hygiene policies): most catalog controls per framework have no
// mapped policy yet and surface as MISSING, the same "bounded by existing
// backend capability" honesty Discovery/Risk Agents' placeholder tools
// established for their own gaps.

const FRAMEWORK_NAMES: Record<Framework, string> = {
  NIST_CSF: 'NIST Cybersecurity Framework',
  CIS_CONTROLS: 'CIS Critical Security Controls',
  ISO_27001: 'ISO/IEC 27001',
  SOC2: 'SOC 2',
};

// Every control a framework "has," independent of policy coverage. Adding
// a fifth framework later means adding one more catalog array here (plus
// one more Framework union member and, optionally, mapping entries below)
// — nothing in compliance.executor.ts changes.
const FRAMEWORK_CONTROLS: Record<Framework, FrameworkControl[]> = {
  NIST_CSF: [
    {
      framework: 'NIST_CSF',
      controlId: 'ID.AM-1',
      controlName: 'Physical devices and systems within the organization are inventoried',
    },
    {
      framework: 'NIST_CSF',
      controlId: 'ID.AM-2',
      controlName: 'Software platforms and applications within the organization are inventoried',
    },
    {
      framework: 'NIST_CSF',
      controlId: 'PR.AC-4',
      controlName: 'Access permissions and authorizations are managed',
    },
    {
      framework: 'NIST_CSF',
      controlId: 'PR.IP-6',
      controlName: 'Data is destroyed according to policy',
    },
    {
      framework: 'NIST_CSF',
      controlId: 'ID.SC-4',
      controlName: 'Suppliers and third-party partners are routinely assessed',
    },
    {
      framework: 'NIST_CSF',
      controlId: 'DE.CM-1',
      controlName: 'The network is monitored to detect potential cybersecurity events',
    },
  ],
  CIS_CONTROLS: [
    {
      framework: 'CIS_CONTROLS',
      controlId: 'CIS-1',
      controlName: 'Inventory and Control of Enterprise Assets',
    },
    { framework: 'CIS_CONTROLS', controlId: 'CIS-3', controlName: 'Data Protection' },
    {
      framework: 'CIS_CONTROLS',
      controlId: 'CIS-4',
      controlName: 'Secure Configuration of Enterprise Assets and Software',
    },
    { framework: 'CIS_CONTROLS', controlId: 'CIS-15', controlName: 'Service Provider Management' },
    {
      framework: 'CIS_CONTROLS',
      controlId: 'CIS-16',
      controlName: 'Application Software Security',
    },
  ],
  ISO_27001: [
    { framework: 'ISO_27001', controlId: 'A.8.1.1', controlName: 'Inventory of assets' },
    { framework: 'ISO_27001', controlId: 'A.8.2.1', controlName: 'Classification of information' },
    { framework: 'ISO_27001', controlId: 'A.9.4.1', controlName: 'Information access restriction' },
    {
      framework: 'ISO_27001',
      controlId: 'A.15.1.1',
      controlName: 'Information security policy for supplier relationships',
    },
    {
      framework: 'ISO_27001',
      controlId: 'A.12.6.1',
      controlName: 'Management of technical vulnerabilities',
    },
  ],
  SOC2: [
    {
      framework: 'SOC2',
      controlId: 'CC3.2',
      controlName: 'Risk assessment — objectives and asset identification',
    },
    { framework: 'SOC2', controlId: 'CC6.1', controlName: 'Logical access security' },
    {
      framework: 'SOC2',
      controlId: 'CC9.2',
      controlName: 'Vendor and business partner risk management',
    },
    { framework: 'SOC2', controlId: 'CC7.2', controlName: 'System monitoring for anomalies' },
  ],
};

// One existing Policy code -> the controls it's evidence for, across
// every framework it's relevant to. Every entry here traces back to a
// real, unchanged Policy under services/policy/policies/github/ — this
// table never invents a new rule, it only tags an existing one.
const POLICY_CONTROL_MAP: Record<string, FrameworkControl[]> = {
  NO_PUBLIC_REPOSITORIES: [
    {
      framework: 'NIST_CSF',
      controlId: 'PR.AC-4',
      controlName: 'Access permissions and authorizations are managed',
    },
    { framework: 'CIS_CONTROLS', controlId: 'CIS-3', controlName: 'Data Protection' },
    { framework: 'ISO_27001', controlId: 'A.9.4.1', controlName: 'Information access restriction' },
    { framework: 'SOC2', controlId: 'CC6.1', controlName: 'Logical access security' },
  ],
  REPOSITORIES_MUST_HAVE_DESCRIPTION: [
    {
      framework: 'NIST_CSF',
      controlId: 'ID.AM-2',
      controlName: 'Software platforms and applications within the organization are inventoried',
    },
    {
      framework: 'CIS_CONTROLS',
      controlId: 'CIS-1',
      controlName: 'Inventory and Control of Enterprise Assets',
    },
    { framework: 'ISO_27001', controlId: 'A.8.1.1', controlName: 'Inventory of assets' },
    {
      framework: 'SOC2',
      controlId: 'CC3.2',
      controlName: 'Risk assessment — objectives and asset identification',
    },
  ],
  REPOSITORIES_MUST_HAVE_TOPICS: [
    {
      framework: 'NIST_CSF',
      controlId: 'ID.AM-2',
      controlName: 'Software platforms and applications within the organization are inventoried',
    },
    {
      framework: 'CIS_CONTROLS',
      controlId: 'CIS-1',
      controlName: 'Inventory and Control of Enterprise Assets',
    },
    { framework: 'ISO_27001', controlId: 'A.8.2.1', controlName: 'Classification of information' },
    {
      framework: 'SOC2',
      controlId: 'CC3.2',
      controlName: 'Risk assessment — objectives and asset identification',
    },
  ],
  ARCHIVED_REPOSITORIES_ARE_ALLOWED: [
    {
      framework: 'NIST_CSF',
      controlId: 'ID.AM-2',
      controlName: 'Software platforms and applications within the organization are inventoried',
    },
    {
      framework: 'CIS_CONTROLS',
      controlId: 'CIS-1',
      controlName: 'Inventory and Control of Enterprise Assets',
    },
    { framework: 'ISO_27001', controlId: 'A.8.1.1', controlName: 'Inventory of assets' },
    {
      framework: 'SOC2',
      controlId: 'CC3.2',
      controlName: 'Risk assessment — objectives and asset identification',
    },
  ],
  FORK_REPOSITORIES_IGNORED: [
    {
      framework: 'NIST_CSF',
      controlId: 'ID.SC-4',
      controlName: 'Suppliers and third-party partners are routinely assessed',
    },
    { framework: 'CIS_CONTROLS', controlId: 'CIS-15', controlName: 'Service Provider Management' },
    {
      framework: 'ISO_27001',
      controlId: 'A.15.1.1',
      controlName: 'Information security policy for supplier relationships',
    },
    {
      framework: 'SOC2',
      controlId: 'CC9.2',
      controlName: 'Vendor and business partner risk management',
    },
  ],
};

export function frameworkName(framework: Framework): string {
  return FRAMEWORK_NAMES[framework];
}

export function catalogForFramework(framework: Framework): FrameworkControl[] {
  return FRAMEWORK_CONTROLS[framework];
}

export function controlsForPolicy(policyCode: string, framework?: Framework): FrameworkControl[] {
  const controls = POLICY_CONTROL_MAP[policyCode] ?? [];
  return framework ? controls.filter((c) => c.framework === framework) : controls;
}

export function listFrameworks(): FrameworkCapability[] {
  return (Object.keys(FRAMEWORK_CONTROLS) as Framework[]).map((framework) => ({
    framework,
    name: FRAMEWORK_NAMES[framework],
    controlCount: FRAMEWORK_CONTROLS[framework].length,
    mappedPolicyCodes: Object.entries(POLICY_CONTROL_MAP)
      .filter(([, controls]) => controls.some((c) => c.framework === framework))
      .map(([policyCode]) => policyCode),
  }));
}

export const ALL_FRAMEWORKS: Framework[] = Object.keys(FRAMEWORK_CONTROLS) as Framework[];
