'use client';

import { createContext, useCallback, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { toast, Toaster } from 'sonner';
import { useNotificationsStore } from '@/lib/store/notificationsStore';

export type ToastTone = 'info' | 'warning' | 'error';

interface ToastContextValue {
  push: (title: string, tone?: ToastTone) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// The "Live notifications" surface — a lightweight toast stack fed by
// real-time AssetEvents (see AssetPageShell), independent of the request/
// response flow every page's own data fetching already handles. Backed by
// `sonner` (Phase 13) rather than a hand-rolled stack — same `push(title,
// tone)` call-site API as before, so AssetPageShell/other callers needed
// no changes.
export function ToastProvider({ children }: { children: ReactNode }) {
  const pushNotification = useNotificationsStore((s) => s.push);

  const push = useCallback(
    (title: string, tone: ToastTone = 'info') => {
      if (tone === 'error') toast.error(title);
      else if (tone === 'warning') toast.warning(title);
      else toast(title);
      pushNotification(title, tone);
    },
    [pushNotification],
  );

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster position="bottom-right" richColors closeButton />
    </ToastContext.Provider>
  );
}

export function useToasts(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToasts must be used within ToastProvider');
  return ctx;
}
