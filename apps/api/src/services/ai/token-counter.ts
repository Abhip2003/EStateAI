// A deliberate approximation, not a real per-vendor tokenizer (tiktoken,
// Claude's tokenizer, SentencePiece for Gemini) — pulling in three heavy,
// vendor-specific tokenizer dependencies for a pre-request estimate isn't
// worth it when every provider's actual response already returns the true
// usage counts, which is what AIRequestLog/AIResponse.usage record.
// ~4 characters per token is the commonly-cited English-text average
// across GPT/Claude-family tokenizers.
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
