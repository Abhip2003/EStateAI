import type { ZodType } from 'zod';
import { ParsingError } from '../errors/index.js';

// Strips a common model habit — wrapping JSON in a ```json fenced code
// block — before parsing. Applied unconditionally; a no-op on plain JSON.
function stripCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}

export interface ParseResult<T> {
  success: boolean;
  data?: T;
  error?: ParsingError;
}

// Best-effort single parse: JSON.parse then zod validate. Returns a
// result object rather than throwing, so retryParse() (below) can attempt
// repair without relying on exception control flow for the expected
// "model produced bad JSON" case.
export function tryParse<T>(raw: string, schema: ZodType<T>): ParseResult<T> {
  let json: unknown;
  try {
    json = JSON.parse(stripCodeFence(raw));
  } catch (error) {
    return {
      success: false,
      error: new ParsingError(
        `response is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        raw,
      ),
    };
  }

  const result = schema.safeParse(json);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    return {
      success: false,
      error: new ParsingError('response did not match expected schema', raw, issues),
    };
  }

  return { success: true, data: result.data };
}

// Throws if parsing fails after the raw attempt — for callers who don't
// want to retry, want the ParsingError to propagate directly.
export function parse<T>(raw: string, schema: ZodType<T>): T {
  const result = tryParse(raw, schema);
  if (!result.success || result.data === undefined) {
    throw result.error ?? new ParsingError('response did not match expected schema', raw);
  }
  return result.data;
}

// Retries malformed-response parsing by re-invoking the model with the
// parse failure as feedback, via the caller-supplied `repair` callback
// (typically another LLMClient.generate() call with a "fix this JSON"
// follow-up prompt). Kept independent of LLMClient so parser/ has no
// dependency on llm/ — the caller wires the two together.
export async function parseWithRetry<T>(
  raw: string,
  schema: ZodType<T>,
  options: {
    maxAttempts?: number;
    repair: (previousRaw: string, error: ParsingError) => Promise<string>;
  },
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 2;
  let current = raw;
  let lastError: ParsingError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = tryParse(current, schema);
    if (result.success && result.data !== undefined) {
      return result.data;
    }
    lastError = result.error;
    if (attempt < maxAttempts) {
      current = await options.repair(current, result.error as ParsingError);
    }
  }

  throw lastError ?? new ParsingError('response did not match expected schema', raw);
}
