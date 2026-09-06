'use client';

import { AppShell } from '../../components/layout/AppShell';
import { Card } from '../../components/ui/Card';
import { Avatar, AvatarFallback, initials } from '../../components/ui/Avatar';
import { Badge } from '../../components/ui/Badge';
import { ThemeToggle } from '../../components/layout/ThemeToggle';
import { useAuth } from '../../lib/auth/AuthProvider';

export default function SettingsPage() {
  const { user } = useAuth();

  return (
    <AppShell title="Settings">
      <div className="max-w-xl space-y-6">
        <Card title="Profile">
          {user ? (
            <div className="flex items-center gap-4">
              <Avatar className="size-14">
                <AvatarFallback className="text-lg">{initials(`${user.firstName} ${user.lastName}`)}</AvatarFallback>
              </Avatar>
              <div>
                <p className="text-base font-medium">
                  {user.firstName} {user.lastName}
                </p>
                <p className="text-sm text-muted-foreground">{user.email}</p>
                <Badge variant="secondary" className="mt-1">
                  {user.role}
                </Badge>
              </div>
            </div>
          ) : null}
          {user ? (
            <dl className="mt-6 grid grid-cols-1 gap-4 border-t border-border pt-4 sm:grid-cols-2">
              <div>
                <dt className="text-xs font-medium uppercase text-muted-foreground">Member since</dt>
                <dd className="text-sm">{new Date(user.createdAt).toLocaleDateString()}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase text-muted-foreground">Email verified</dt>
                <dd className="text-sm">{user.emailVerified ? 'Yes' : 'No'}</dd>
              </div>
            </dl>
          ) : null}
        </Card>

        <Card title="Appearance">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Theme</p>
              <p className="text-xs text-muted-foreground">Switch between light and dark mode.</p>
            </div>
            <ThemeToggle />
          </div>
        </Card>

        <Card title="About">
          <p className="text-sm text-muted-foreground">
            Profile editing isn&apos;t available yet — the API has no update-profile endpoint. Manage connected
            accounts from each asset&apos;s Accounts tab.
          </p>
        </Card>
      </div>
    </AppShell>
  );
}
