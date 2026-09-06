'use client';

import { useEffect, useRef, useState } from 'react';
import { Copy, Plus, Send, Sparkles, Trash2 } from 'lucide-react';
import { copilotApi } from '../../lib/api/copilot';
import { Button } from '../ui/Button';
import { Textarea } from '../ui/Input';
import { Markdown } from '../shared/Markdown';
import { cn } from '../../lib/utils';
import { useConversations, type ChatMessage } from '../../lib/copilot/useConversations';

const SUGGESTED_PROMPTS = [
  'What are the biggest risks right now?',
  'Summarize this asset’s compliance posture.',
  'Which findings should I fix first?',
  'Are there any public repositories I should be worried about?',
];

// Full response arrives in one shot (CopilotService never streams — see
// ARCHITECTURE.md/DECISIONS.md) — this reveals it progressively on the
// client so the UI still *feels* like a streaming assistant. Not real
// token streaming.
function useTypewriter(fullText: string, active: boolean): string {
  const [shown, setShown] = useState(active ? '' : fullText);

  useEffect(() => {
    if (!active) {
      // Resetting to the full text is the point of this effect running
      // again when `active` flips off — not an accidental cascade.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShown(fullText);
      return;
    }
    let i = 0;
    const step = Math.max(1, Math.floor(fullText.length / 120));
    const timer = setInterval(() => {
      i += step;
      setShown(fullText.slice(0, i));
      if (i >= fullText.length) clearInterval(timer);
    }, 12);
    return () => clearInterval(timer);
  }, [fullText, active]);

  return shown;
}

function MessageBubble({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
  const displayed = useTypewriter(message.content, message.role === 'assistant' && streaming);
  const isUser = message.role === 'user';

  return (
    <div className={cn('group flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'relative max-w-[85%] rounded-lg px-3 py-2 text-sm',
          isUser
            ? 'bg-primary text-primary-foreground'
            : message.isError
              ? 'bg-destructive/10 text-destructive ring-1 ring-inset ring-destructive/30'
              : 'bg-muted',
        )}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <Markdown content={displayed || ' '} />
        )}
        {message.citations && message.citations.length > 0 ? (
          <ul className="mt-2 list-inside list-disc text-xs opacity-80">
            {message.citations.map((citation) => (
              <li key={citation}>{citation}</li>
            ))}
          </ul>
        ) : null}
        {message.metadata ? (
          <p className="mt-2 text-xs opacity-60">
            {message.metadata.provider}/{message.metadata.model} · {message.metadata.latencyMs}ms · $
            {message.metadata.estimatedCostUsd.toFixed(4)}
          </p>
        ) : null}
        {!isUser ? (
          <button
            type="button"
            onClick={() => void navigator.clipboard.writeText(message.content)}
            className="absolute -right-2 -top-2 hidden rounded-full bg-card p-1 text-muted-foreground shadow ring-1 ring-border group-hover:block"
            aria-label="Copy message"
          >
            <Copy className="size-3" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function ChatPanel({ assetId }: { assetId: string }) {
  const { conversations, active, activeId, setActiveId, createConversation, updateConversation, deleteConversation } =
    useConversations(assetId);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [lastAssistantId, setLastAssistantId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = active?.messages ?? [];

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    let conversationId = activeId;
    let current = messages;
    if (!conversationId) {
      conversationId = createConversation();
      current = [];
    }

    const userMessage: ChatMessage = { id: crypto.randomUUID(), role: 'user', content: trimmed };
    current = [...current, userMessage];
    updateConversation(conversationId, current);
    setInput('');
    setSending(true);

    try {
      const result = await copilotApi.chat(assetId, trimmed);
      const assistantMessage: ChatMessage =
        result.status === 'SUCCESS'
          ? {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: result.answer ?? '',
              citations: result.citations,
              metadata: result.metadata,
            }
          : {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: result.error ?? 'The copilot could not answer that question.',
              isError: true,
            };
      setLastAssistantId(assistantMessage.id);
      updateConversation(conversationId, [...current, assistantMessage]);
    } catch (err) {
      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: err instanceof Error ? err.message : 'The copilot could not answer that question.',
        isError: true,
      };
      setLastAssistantId(assistantMessage.id);
      updateConversation(conversationId, [...current, assistantMessage]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-[36rem] overflow-hidden rounded-lg border border-border bg-card shadow-sm">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-border sm:flex">
        <div className="border-b border-border p-2">
          <Button variant="secondary" size="sm" className="w-full" onClick={() => createConversation()}>
            <Plus className="size-4" /> New chat
          </Button>
        </div>
        <div className="flex-1 space-y-1 overflow-y-auto p-2">
          {conversations.map((c) => (
            <div
              key={c.id}
              className={cn(
                'group flex items-center justify-between rounded-md px-2 py-1.5 text-xs',
                c.id === activeId ? 'bg-muted font-medium' : 'hover:bg-muted/60',
              )}
            >
              <button type="button" onClick={() => setActiveId(c.id)} className="flex-1 truncate text-left">
                {c.title}
              </button>
              <button
                type="button"
                onClick={() => deleteConversation(c.id)}
                className="hidden text-muted-foreground hover:text-destructive group-hover:block"
                aria-label="Delete conversation"
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
          {conversations.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">No conversations yet.</p>
          ) : null}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
          {messages.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <Sparkles className="size-8 text-muted-foreground" />
              <p className="max-w-sm text-sm text-muted-foreground">
                Ask a question about this asset&apos;s security posture, grounded in its live resources, findings,
                policies, and risk data.
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTED_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    onClick={() => void send(prompt)}
                    className="rounded-full border border-border px-3 py-1.5 text-xs hover:bg-muted"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <MessageBubble key={message.id} message={message} streaming={message.id === lastAssistantId} />
            ))
          )}
          {sending ? <p className="text-xs text-muted-foreground">Copilot is thinking…</p> : null}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send(input);
          }}
          className="flex gap-2 border-t border-border p-3"
        >
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(input);
              }
            }}
            placeholder="Ask the copilot about this asset…"
            className="min-h-9 flex-1 resize-none"
            rows={1}
          />
          <Button type="submit" size="icon" disabled={sending || !input.trim()} aria-label="Send">
            <Send className="size-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}
