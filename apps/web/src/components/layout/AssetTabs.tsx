'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Asset Details tabs. The spec's own list (Overview, Accounts, Resources,
// Relationships, Findings, Recommendations, Risk, Compliance, Events, AI
// Reports) is a subset of what's here — Discovery (job history/live
// progress) and AI Copilot were already tabs before this phase and stay,
// since removing working navigation isn't part of "no backend/behavior
// regressions."
export function AssetTabs({ assetId }: { assetId: string }) {
  const pathname = usePathname();
  const base = `/assets/${assetId}`;
  const tabs = [
    { href: base, label: 'Overview', exact: true },
    { href: `${base}/accounts`, label: 'Accounts' },
    { href: `${base}/resources`, label: 'Resources' },
    { href: `${base}/relationships`, label: 'Relationships' },
    { href: `${base}/discovery`, label: 'Discovery' },
    { href: `${base}/findings`, label: 'Findings' },
    { href: `${base}/recommendations`, label: 'Recommendations' },
    { href: `${base}/risk`, label: 'Risk' },
    { href: `${base}/compliance`, label: 'Compliance' },
    { href: `${base}/events`, label: 'Events' },
    { href: `${base}/report`, label: 'AI Reports' },
    { href: `${base}/copilot`, label: 'AI Copilot' },
  ];

  return (
    <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-border">
      {tabs.map((tab) => {
        const active = tab.exact ? pathname === tab.href : pathname?.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? 'border-primary text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
