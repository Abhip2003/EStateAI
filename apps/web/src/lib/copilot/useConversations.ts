'use client';

import { useCallback, useEffect, useState } from 'react';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: string[];
  metadata?: { provider: string; model: string; latencyMs: number; estimatedCostUsd: number };
  isError?: boolean;
}

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: string;
}

function storageKey(assetId: string): string {
  return `estateai.copilot.conversations.${assetId}`;
}

// The backend copilot (Phase 8) is deliberately stateless — every
// POST /copilot/chat call is one independent message, with no
// conversation/session model on the server (see ARCHITECTURE.md).
// "Conversation history" here is therefore a client-only concern: this
// hook persists conversation transcripts to localStorage, scoped per
// asset, purely for display/UX continuity across page visits — it is
// never sent back to the API as prior turns (see DECISIONS.md).
export function useConversations(assetId: string) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey(assetId));
      const parsed: Conversation[] = raw ? JSON.parse(raw) : [];
      // Loading this asset's saved conversations from localStorage is the
      // whole point of this effect running on mount/assetId change — not
      // an accidental cascade.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setConversations(parsed);
      setActiveId(parsed[0]?.id ?? null);
    } catch {
      setConversations([]);
    }
  }, [assetId]);

  const persist = useCallback(
    (next: Conversation[]) => {
      setConversations(next);
      window.localStorage.setItem(storageKey(assetId), JSON.stringify(next));
    },
    [assetId],
  );

  const createConversation = useCallback((): string => {
    const id = crypto.randomUUID();
    const conversation: Conversation = { id, title: 'New conversation', messages: [], updatedAt: new Date().toISOString() };
    persist([conversation, ...conversations]);
    setActiveId(id);
    return id;
  }, [conversations, persist]);

  const updateConversation = useCallback(
    (id: string, messages: ChatMessage[]) => {
      const title = messages.find((m) => m.role === 'user')?.content.slice(0, 60) ?? 'New conversation';
      const next = conversations.map((c) => (c.id === id ? { ...c, messages, title, updatedAt: new Date().toISOString() } : c));
      persist(next);
    },
    [conversations, persist],
  );

  const deleteConversation = useCallback(
    (id: string) => {
      const next = conversations.filter((c) => c.id !== id);
      persist(next);
      if (activeId === id) setActiveId(next[0]?.id ?? null);
    },
    [conversations, persist, activeId],
  );

  const active = conversations.find((c) => c.id === activeId) ?? null;

  return { conversations, active, activeId, setActiveId, createConversation, updateConversation, deleteConversation };
}
