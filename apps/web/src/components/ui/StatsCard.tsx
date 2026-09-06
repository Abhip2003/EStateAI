import type { ComponentType, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface StatsCardProps {
  label: string;
  value: ReactNode;
  hint?: string;
  accent?: 'default' | 'danger' | 'success' | 'warning';
  icon?: ComponentType<{ className?: string }>;
  trend?: { value: string; direction: 'up' | 'down' | 'flat' };
}

const ACCENT_CLASSES: Record<NonNullable<StatsCardProps['accent']>, string> = {
  default: 'text-foreground',
  danger: 'text-destructive',
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
};

const TREND_CLASSES: Record<'up' | 'down' | 'flat', string> = {
  up: 'text-emerald-600 dark:text-emerald-400',
  down: 'text-destructive',
  flat: 'text-muted-foreground',
};

// StatCard/MetricCard in the spec's own component list are the same shape
// — one component, two names, so neither call site duplicates the other.
export function StatsCard({ label, value, hint, accent = 'default', icon: Icon, trend }: StatsCardProps) {
  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
        {Icon ? <Icon className="size-4 text-muted-foreground" /> : null}
      </div>
      <p className={cn('mt-2 text-2xl font-semibold', ACCENT_CLASSES[accent])}>{value}</p>
      <div className="mt-1 flex items-center gap-2">
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        {trend ? (
          <span className={cn('text-xs font-medium', TREND_CLASSES[trend.direction])}>
            {trend.direction === 'up' ? '↑' : trend.direction === 'down' ? '↓' : '→'} {trend.value}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export const StatCard = StatsCard;
export const MetricCard = StatsCard;
