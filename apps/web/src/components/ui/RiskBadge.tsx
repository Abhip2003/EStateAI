import { cn } from '@/lib/utils';
import type { FindingSeverity } from '@/lib/types';

const BADGE_BASE = 'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset';

const SEVERITY_STYLES: Record<FindingSeverity, string> = {
  CRITICAL: 'bg-red-100 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-400 dark:ring-red-500/30',
  HIGH: 'bg-orange-100 text-orange-700 ring-orange-600/20 dark:bg-orange-500/15 dark:text-orange-400 dark:ring-orange-500/30',
  MEDIUM: 'bg-amber-100 text-amber-700 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-400 dark:ring-amber-500/30',
  LOW: 'bg-lime-100 text-lime-700 ring-lime-600/20 dark:bg-lime-500/15 dark:text-lime-400 dark:ring-lime-500/30',
  INFORMATIONAL:
    'bg-slate-100 text-slate-600 ring-slate-500/20 dark:bg-slate-500/15 dark:text-slate-300 dark:ring-slate-500/30',
};

export function SeverityBadge({ severity }: { severity: FindingSeverity }) {
  return <span className={cn(BADGE_BASE, SEVERITY_STYLES[severity])}>{severity}</span>;
}

// Risk scores (0-100) don't carry a FindingSeverity themselves — this maps
// the numeric score into the same visual language as SeverityBadge so a
// dashboard/report reader learns one color scale, not two.
export function riskBand(score: number): { label: string; className: string } {
  if (score >= 75) return { label: 'Critical', className: SEVERITY_STYLES.CRITICAL };
  if (score >= 50) return { label: 'High', className: SEVERITY_STYLES.HIGH };
  if (score >= 25) return { label: 'Medium', className: SEVERITY_STYLES.MEDIUM };
  if (score > 0) return { label: 'Low', className: SEVERITY_STYLES.LOW };
  return { label: 'None', className: SEVERITY_STYLES.INFORMATIONAL };
}

export function RiskScoreBadge({ score }: { score: number }) {
  const band = riskBand(score);
  return (
    <span className={cn(BADGE_BASE, 'gap-1', band.className)}>
      {band.label} · {score}
    </span>
  );
}

const STATUS_STYLES: Record<string, string> = {
  PASS: 'bg-emerald-100 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-400 dark:ring-emerald-500/30',
  FAIL: 'bg-red-100 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-400 dark:ring-red-500/30',
  WARNING:
    'bg-amber-100 text-amber-700 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-400 dark:ring-amber-500/30',
  NOT_APPLICABLE:
    'bg-slate-100 text-slate-500 ring-slate-500/20 dark:bg-slate-500/15 dark:text-slate-400 dark:ring-slate-500/30',
  OPEN: 'bg-blue-100 text-blue-700 ring-blue-600/20 dark:bg-blue-500/15 dark:text-blue-400 dark:ring-blue-500/30',
  RESOLVED:
    'bg-emerald-100 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-400 dark:ring-emerald-500/30',
  DISMISSED:
    'bg-slate-100 text-slate-500 ring-slate-500/20 dark:bg-slate-500/15 dark:text-slate-400 dark:ring-slate-500/30',
  ACTIVE:
    'bg-emerald-100 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-400 dark:ring-emerald-500/30',
  INACTIVE:
    'bg-slate-100 text-slate-500 ring-slate-500/20 dark:bg-slate-500/15 dark:text-slate-400 dark:ring-slate-500/30',
  ARCHIVED:
    'bg-slate-100 text-slate-500 ring-slate-500/20 dark:bg-slate-500/15 dark:text-slate-400 dark:ring-slate-500/30',
  COMPLETED:
    'bg-emerald-100 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/15 dark:text-emerald-400 dark:ring-emerald-500/30',
  QUEUED: 'bg-blue-100 text-blue-700 ring-blue-600/20 dark:bg-blue-500/15 dark:text-blue-400 dark:ring-blue-500/30',
  RUNNING: 'bg-blue-100 text-blue-700 ring-blue-600/20 dark:bg-blue-500/15 dark:text-blue-400 dark:ring-blue-500/30',
  RETRYING:
    'bg-amber-100 text-amber-700 ring-amber-600/20 dark:bg-amber-500/15 dark:text-amber-400 dark:ring-amber-500/30',
  CANCELLED:
    'bg-slate-100 text-slate-500 ring-slate-500/20 dark:bg-slate-500/15 dark:text-slate-400 dark:ring-slate-500/30',
  DEAD: 'bg-red-100 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-400 dark:ring-red-500/30',
  FAILED: 'bg-red-100 text-red-700 ring-red-600/20 dark:bg-red-500/15 dark:text-red-400 dark:ring-red-500/30',
};

export function StatusBadge({ status }: { status: string }) {
  const className = STATUS_STYLES[status] ?? STATUS_STYLES.NOT_APPLICABLE;
  return <span className={cn(BADGE_BASE, className)}>{status}</span>;
}

// Same visual language as StatusBadge, scoped to PolicyResultStatus values
// specifically — a distinct name because "compliance" is the domain the
// spec calls out, not because the styling differs.
export function ComplianceBadge({ status }: { status: 'PASS' | 'FAIL' | 'WARNING' | 'NOT_APPLICABLE' }) {
  return <StatusBadge status={status} />;
}
