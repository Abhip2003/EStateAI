import type { ZodType } from 'zod';

// Plain string-keyed variables a template is rendered with. Kept as
// `unknown` at this layer — each template supplies its own zod schema to
// narrow and validate the shape it actually needs.
export type PromptVariables = Record<string, unknown>;

export interface PromptTemplateDefinition<TVars extends PromptVariables = PromptVariables> {
  id: string;
  version: string;
  description?: string;
  systemTemplate?: string;
  userTemplate: string;
  variablesSchema: ZodType<TVars>;
}

export interface RenderedPrompt {
  system?: string;
  user: string;
}
