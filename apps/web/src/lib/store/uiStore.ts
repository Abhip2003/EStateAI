import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// The one piece of truly cross-cutting client UI state — whether the
// mobile nav drawer is open, whether the desktop sidebar is collapsed, and
// (Phase 13) which asset was last picked on a global asset-scoped page —
// neither is server data, neither belongs to one page, so Zustand (not
// React Query, not prop drilling) is the right tool per the spec's own
// "Zustand only where global state is needed" instruction.
interface UIState {
  mobileNavOpen: boolean;
  setMobileNavOpen: (open: boolean) => void;
  sidebarCollapsed: boolean;
  toggleSidebarCollapsed: () => void;
  lastAssetId: string | null;
  setLastAssetId: (id: string | null) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      mobileNavOpen: false,
      setMobileNavOpen: (open) => set({ mobileNavOpen: open }),
      sidebarCollapsed: false,
      toggleSidebarCollapsed: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      lastAssetId: null,
      setLastAssetId: (id) => set({ lastAssetId: id }),
    }),
    { name: 'estateai.ui', partialize: (s) => ({ lastAssetId: s.lastAssetId, sidebarCollapsed: s.sidebarCollapsed }) },
  ),
);
