import { AlertCircle, AlertTriangle, Info, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AssetEvent } from '@/lib/types';

const SEVERITY_ICON: Record<AssetEvent['severity'], typeof Info> = {
  INFO: Info,
  WARNING: AlertTriangle,
  ERROR: AlertCircle,
  CRITICAL: XCircle,
};

const SEVERITY_COLOR: Record<AssetEvent['severity'], string> = {
  INFO: 'text-blue-500',
  WARNING: 'text-amber-500',
  ERROR: 'text-destructive',
  CRITICAL: 'text-destructive',
};

export function Timeline({ events }: { events: AssetEvent[] }) {
  return (
    <ol className="relative space-y-0 border-l border-border pl-6">
      {events.map((event) => {
        const Icon = SEVERITY_ICON[event.severity];
        return (
          <li key={event.id} className="relative pb-6 last:pb-0">
            <span
              className={cn(
                'absolute -left-[29px] flex size-5 items-center justify-center rounded-full bg-card ring-2 ring-border',
                SEVERITY_COLOR[event.severity],
              )}
            >
              <Icon className="size-3.5" />
            </span>
            <div className="flex flex-wrap items-baseline justify-between gap-x-3">
              <p className="text-sm font-medium">{event.title}</p>
              <time className="text-xs text-muted-foreground" dateTime={event.createdAt}>
                {new Date(event.createdAt).toLocaleString()}
              </time>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{event.type}</p>
            {event.description ? <p className="mt-1 text-sm">{event.description}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}
