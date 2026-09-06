import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Card({
  title,
  action,
  children,
  className,
  noPadding = false,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  noPadding?: boolean;
}) {
  return (
    <div className={cn('rounded-lg border border-border bg-card text-card-foreground shadow-sm', className)}>
      {title ? (
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          {action}
        </div>
      ) : null}
      <div className={noPadding ? undefined : 'p-4'}>{children}</div>
    </div>
  );
}
