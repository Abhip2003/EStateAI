import type { AIMessage, AIRequest } from './dto/ai-request.js';
import type { KnowledgeContext } from '../knowledge/dto/knowledge-context.js';
import type { RetrievedItem } from '../knowledge/dto/retrieval-result.js';

// PromptBuilder takes a `KnowledgeContext` object (Phase 7C) rather than a
// freeform contextBlocks record — but this is a type-only import of the
// knowledge domain's DTO, not a call into KnowledgeService/ContextBuilder.
// PromptBuilder stays a pure function of its inputs: it renders whatever
// KnowledgeContext it's handed, it never builds one itself. That's what
// keeps it usable both by AIService (which builds the context via
// ContextBuilder before calling here) and by any future caller that
// already has a KnowledgeContext from elsewhere.
export interface PromptBuilderInput {
  systemPrompt?: string;
  userPrompt: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  knowledgeContext?: KnowledgeContext;
}

const SECTION_LABELS: {
  key: keyof Pick<
    KnowledgeContext,
    'resources' | 'relationships' | 'findings' | 'policies' | 'recommendations' | 'risk'
  >;
  label: string;
}[] = [
  { key: 'risk', label: 'risk' },
  { key: 'findings', label: 'findings' },
  { key: 'policies', label: 'policies' },
  { key: 'recommendations', label: 'recommendations' },
  { key: 'resources', label: 'resources' },
  { key: 'relationships', label: 'relationships' },
];

function renderSection(label: string, items: RetrievedItem[]): string | null {
  if (items.length === 0) return null;
  return `[${label}]\n${items.map((item) => `- ${item.summary}`).join('\n')}`;
}

function renderKnowledgeContext(context: KnowledgeContext): string {
  return SECTION_LABELS.map(({ key, label }) => renderSection(label, context[key]))
    .filter((section): section is string => section !== null)
    .join('\n\n');
}

class PromptBuilder {
  build(input: PromptBuilderInput, defaultMaxTokens: number): AIRequest {
    const messages: AIMessage[] = [];

    const contextSection = input.knowledgeContext
      ? renderKnowledgeContext(input.knowledgeContext)
      : '';

    const userContent = contextSection
      ? `${contextSection}\n\n[request]\n${input.userPrompt}`
      : input.userPrompt;

    messages.push({ role: 'user', content: userContent });

    return {
      model: input.model,
      systemPrompt: input.systemPrompt,
      messages,
      maxTokens: input.maxTokens ?? defaultMaxTokens,
      temperature: input.temperature,
    };
  }
}

export const promptBuilder = new PromptBuilder();
