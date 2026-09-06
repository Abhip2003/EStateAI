import type { ReactNode } from 'react';
import { AuthGuard } from './AuthGuard';
import { Sidebar, MobileSidebar } from './Sidebar';
import { Topbar } from './Topbar';

export function AppShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <AuthGuard>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <MobileSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <Topbar title={title} />
          <main className="flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
        </div>
      </div>
    </AuthGuard>
  );
}
