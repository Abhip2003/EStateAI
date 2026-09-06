'use client';

import { useRouter } from 'next/navigation';
import { Bell, LogOut, Menu, Search, Settings, User as UserIcon } from 'lucide-react';
import { useAuth } from '../../lib/auth/AuthProvider';
import { useRealtime } from '../../lib/realtime/RealtimeProvider';
import { useUIStore } from '../../lib/store/uiStore';
import { useNotificationsStore } from '../../lib/store/notificationsStore';
import { Button } from '../ui/Button';
import { Avatar, AvatarFallback, initials } from '../ui/Avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/DropdownMenu';
import { ThemeToggle } from './ThemeToggle';
import { Breadcrumbs } from './Breadcrumbs';
import { Badge } from '../ui/Badge';

function NotificationBell() {
  const { items, unread, markAllRead } = useNotificationsStore();
  return (
    <DropdownMenu onOpenChange={(open) => open && markAllRead()}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="Notifications">
          <Bell className="size-4" />
          {unread > 0 ? (
            <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-destructive text-[10px] text-destructive-foreground">
              {unread > 9 ? '9+' : unread}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Notifications</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.length === 0 ? (
          <p className="px-2 py-3 text-center text-xs text-muted-foreground">No notifications yet.</p>
        ) : (
          <div className="max-h-80 space-y-1 overflow-y-auto">
            {items.map((n) => (
              <div key={n.id} className="rounded-sm px-2 py-1.5 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span>{n.title}</span>
                  <Badge variant={n.tone === 'error' ? 'default' : 'secondary'}>{n.tone}</Badge>
                </div>
                <p className="mt-0.5 text-[10px] text-muted-foreground">{new Date(n.createdAt).toLocaleTimeString()}</p>
              </div>
            ))}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const router = useRouter();
  if (!user) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="User menu"
          className="flex items-center gap-2 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Avatar>
            <AvatarFallback>{initials(`${user.firstName} ${user.lastName}`)}</AvatarFallback>
          </Avatar>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          {user.firstName} {user.lastName}
          <p className="font-normal text-muted-foreground">{user.email}</p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push('/settings')}>
          <Settings className="size-4" /> Settings
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => router.push('/settings')}>
          <UserIcon className="size-4" /> Profile
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            void logout().then(() => router.replace('/login'));
          }}
        >
          <LogOut className="size-4" /> Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Topbar({ title }: { title: string }) {
  const { connected } = useRealtime();
  const setMobileNavOpen = useUIStore((s) => s.setMobileNavOpen);
  const router = useRouter();

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-4 md:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          onClick={() => setMobileNavOpen(true)}
          aria-label="Open navigation"
        >
          <Menu className="size-5" />
        </Button>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold">{title}</h1>
          <Breadcrumbs currentLabel={title} />
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => router.push('/search')}
          aria-label="Search"
          className="hidden sm:inline-flex"
        >
          <Search className="size-4" />
        </Button>
        <span
          title={connected ? 'Live updates connected' : 'Reconnecting…'}
          className="mr-1 hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex"
        >
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
          {connected ? 'Live' : 'Reconnecting…'}
        </span>
        <ThemeToggle />
        <NotificationBell />
        <UserMenu />
      </div>
    </header>
  );
}
