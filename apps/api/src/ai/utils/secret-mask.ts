// Belt-and-suspenders for anywhere in src/ai/ that logs a request/response
// object outside Fastify's request-scoped logger (which already redacts
// via pino, see observability/logger.ts). Masks values that look like API
// keys/tokens so a raw `console.log`/`logger.info` of a config or header
// object never leaks a secret verbatim.
const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|authorization|credential)/i;

export function maskSecret(value: string | undefined): string {
  if (!value) return '(unset)';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export function maskSecretsInObject<T extends Record<string, unknown>>(obj: T): T {
  const masked = { ...obj } as Record<string, unknown>;
  for (const [key, value] of Object.entries(masked)) {
    if (SECRET_KEY_PATTERN.test(key) && typeof value === 'string') {
      masked[key] = maskSecret(value);
    }
  }
  return masked as T;
}
