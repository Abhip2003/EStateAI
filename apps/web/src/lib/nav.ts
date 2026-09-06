import {
  Activity,
  BookOpen,
  Boxes,
  LayoutDashboard,
  Lightbulb,
  MessageSquare,
  Network,
  Plug,
  Radar,
  Settings as SettingsIcon,
  ShieldCheck,
  ShieldQuestion,
  Sparkles,
  Target,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

// The single source of truth for sidebar nav + breadcrumb labels — one
// list instead of duplicating hrefs/labels between Sidebar and Topbar.
export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/assets', label: 'Assets', icon: Boxes },
  { href: '/accounts', label: 'Connected Accounts', icon: Plug },
  { href: '/discovery', label: 'Discovery Jobs', icon: Radar },
  { href: '/resources', label: 'Resources', icon: Network },
  { href: '/findings', label: 'Findings', icon: ShieldQuestion },
  { href: '/recommendations', label: 'Recommendations', icon: Lightbulb },
  { href: '/risk', label: 'Risk Dashboard', icon: Target },
  { href: '/compliance', label: 'Compliance Dashboard', icon: ShieldCheck },
  { href: '/policies', label: 'Policies', icon: ShieldCheck },
  { href: '/reports', label: 'AI Reports', icon: Sparkles },
  { href: '/knowledge', label: 'Knowledge Base', icon: BookOpen },
  { href: '/copilot', label: 'AI Copilot', icon: MessageSquare },
  { href: '/activity', label: 'Activity Timeline', icon: Activity },
  { href: '/settings', label: 'Settings', icon: SettingsIcon },
];
