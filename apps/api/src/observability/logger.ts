import pino from 'pino';
import { config } from '../config/env.js';

// Paths pino redacts to `[Redacted]` wherever they appear in a logged
// object, regardless of nesting — covers the shapes our own request bodies,
// headers, and job payloads take (access/refresh tokens, provider
// credentials, API keys) without requiring every call site to remember to
// scrub before logging.
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.accessToken',
  '*.refreshToken',
  '*.token',
  '*.apiKey',
  '*.credential',
  '*.credentialCiphertext',
  '*.JWT_SECRET',
  '*.CREDENTIAL_ENCRYPTION_KEY',
  '*.CLAUDE_API_KEY',
  '*.OPENAI_API_KEY',
  '*.GEMINI_API_KEY',
  '*.GITHUB_CLIENT_SECRET',
];

export const pinoOptions: pino.LoggerOptions = {
  level: config.logging.level,
  redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
  // Pretty-printed, human-readable logs only in development; production
  // and test always emit plain structured JSON (the "structured JSON
  // logging" requirement, and what a log aggregator actually wants).
  transport:
    config.nodeEnv === 'development'
      ? {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        }
      : undefined,
};

// Standalone logger for code that runs outside a Fastify request lifecycle
// (job workers, the WebSocket gateway, AI provider calls) and therefore has
// no `request.log` with an attached requestId to log through. Configured
// identically to the request logger (same level/redaction/transport) so
// every log line in the process — request-scoped or not — is the same
// shape.
export const logger = pino(pinoOptions);
