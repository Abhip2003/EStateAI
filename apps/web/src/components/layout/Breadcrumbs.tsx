'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ChevronRight } from 'lucide-react';
import { NAV_ITEMS } from '@/lib/nav';

// Derives crumbs from the URL path plus NAV_ITEMS' labels — no per-page
// breadcrumb config to keep in sync, since the sidebar's own labels
// already describe every top-level segment. Dynamic segments (an asset
// id) render as a shortened id rather than a fetched name, to keep this
// component free of data-fetching concerns.
export function Breadcrumbs({ currentLabel }: { currentLabel?: string }) {
  const pathname = usePathname() ?? '/';
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const crumbs = segments.map((segment, i) => {
    const href = '/' + segments.slice(0, i + 1).join('/');
    const navMatch = NAV_ITEMS.find((item) => item.href === href);
    const isLast = i === segments.length - 1;
    const label = navMatch?.label ?? (isLast && currentLabel ? currentLabel : segment.slice(0, 8));
    return { href, label, isLast };
  });

  return (
    <nav aria-label="Breadcrumb" className="hidden items-center gap-1 text-xs text-muted-foreground md:flex">
      <Link href="/dashboard" className="hover:text-foreground">
        Home
      </Link>
      {crumbs.map((crumb) => (
        <span key={crumb.href} className="flex items-center gap-1">
          <ChevronRight className="size-3" />
          {crumb.isLast ? (
            <span className="text-foreground">{crumb.label}</span>
          ) : (
            <Link href={crumb.href} className="hover:text-foreground">
              {crumb.label}
            </Link>
          )}
        </span>
      ))}
    </nav>
  );
}
