import { create } from 'zustand';
import type { ToastTone } from '@/components/layout/ToastProvider';

export interface NotificationEntry {
  id: string;
  title: string;
  tone: ToastTone;
  createdAt: string;
}

const MAX_NOTIFICATIONS = 30;

// Backs the Topbar notification bell — every toast ToastProvider.push()
// fires also lands here so there's a browsable history, not just a
// transient popup. In-memory only (Zustand, no persist): a page refresh
// clears it, same lifetime as the WebSocket connection it's fed by.
interface NotificationsState {
  items: NotificationEntry[];
  unread: number;
  push: (title: string, tone: ToastTone) => void;
  markAllRead: () => void;
}

export const useNotificationsStore = create<NotificationsState>((set) => ({
  items: [],
  unread: 0,
  push: (title, tone) =>
    set((s) => ({
      items: [{ id: crypto.randomUUID(), title, tone, createdAt: new Date().toISOString() }, ...s.items].slice(
        0,
        MAX_NOTIFICATIONS,
      ),
      unread: s.unread + 1,
    })),
  markAllRead: () => set({ unread: 0 }),
}));
