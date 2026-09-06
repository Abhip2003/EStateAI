import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  httpErrorsTotal,
  httpRequestDurationSeconds,
  httpRequestsTotal,
} from '../observability/metrics.js';

// Route templates (e.g. "/assets/:id"), not raw URLs — using the raw URL as
// a metric label would blow up cardinality (one series per asset id ever
// requested). Fastify exposes the matched route on request.routeOptions
// once routing has resolved, even for 404s it's left undefined, so those
// fall back to a fixed label instead of one series per garbage path.
function routeLabel(request: { routeOptions?: { url?: string } }): string {
  return request.routeOptions?.url ?? 'unmatched';
}

// Best-effort — assetId shows up in a route param (`/assets/:id`, `/assets/:assetId/...`),
// a query string (`?assetId=`), or occasionally the body (`POST /ai/generate`).
// Not every request has one; this is a logging convenience, not a contract.
function extractAssetId(request: FastifyRequest): string | undefined {
  const params = request.params as Record<string, unknown> | undefined;
  const query = request.query as Record<string, unknown> | undefined;
  const body = request.body as Record<string, unknown> | undefined;
  const candidate = params?.assetId ?? params?.id ?? query?.assetId ?? body?.assetId;
  return typeof candidate === 'string' ? candidate : undefined;
}

function correlationId(request: FastifyRequest): string {
  const header = request.headers['x-correlation-id'];
  return (Array.isArray(header) ? header[0] : header) ?? request.id;
}

// Wires every cross-cutting request concern in one place: an `x-request-id`
// response header, a `requestId` field spliced into every 4xx/5xx JSON body
// (without any individual route's local mapXError needing to know this
// exists), per-request HTTP metrics, and — per Phase 12 — one unified
// structured log line per request (requestId, correlationId, userId,
// assetId, route, statusCode, responseTimeMs, error stack on 5xx) in place
// of Fastify's own generic "incoming request"/"request completed" pair.
// `disableRequestLogging: true` (server.ts) is what turns those off, so
// this doesn't produce duplicate log lines for the same request.
export function observabilityPlugin(app: FastifyInstance): void {
  app.addHook('onRequest', (request, _reply, done) => {
    (request as unknown as { metricsStart: number }).metricsStart = performance.now();
    done();
  });

  // Captures the thrown error so the onResponse log line below can include
  // its message/stack — onResponse itself never receives the error object.
  app.addHook('onError', (request, _reply, error, done) => {
    (request as unknown as { loggedError?: Error }).loggedError = error;
    done();
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    reply.header('x-correlation-id', correlationId(request));

    if (reply.statusCode < 400 || typeof payload !== 'string') {
      return payload;
    }

    try {
      const body: unknown = JSON.parse(payload);
      if (body && typeof body === 'object' && !Array.isArray(body) && !('requestId' in body)) {
        return JSON.stringify({ ...body, requestId: request.id });
      }
    } catch {
      // Not a JSON body (e.g. a plain-text 404 from an unmatched route) —
      // leave it untouched, the header above still carries the id.
    }
    return payload;
  });

  app.addHook('onResponse', async (request, reply) => {
    const start = (request as unknown as { metricsStart?: number }).metricsStart;
    const durationSeconds = start ? (performance.now() - start) / 1000 : 0;
    const responseTimeMs = Math.round(durationSeconds * 1000);
    const route = routeLabel(request);
    const labels = { method: request.method, route, status_code: String(reply.statusCode) };

    httpRequestsTotal.inc(labels);
    httpRequestDurationSeconds.observe(labels, durationSeconds);
    if (reply.statusCode >= 400) {
      httpErrorsTotal.inc(labels);
    }

    const error = (request as unknown as { loggedError?: Error }).loggedError;
    const logPayload = {
      requestId: request.id,
      correlationId: correlationId(request),
      userId: request.user?.id,
      assetId: extractAssetId(request),
      method: request.method,
      route,
      statusCode: reply.statusCode,
      responseTimeMs,
      ...(error ? { err: { message: error.message, stack: error.stack } } : {}),
    };

    if (reply.statusCode >= 500) {
      request.log.error(logPayload, 'request completed');
    } else if (reply.statusCode >= 400) {
      request.log.warn(logPayload, 'request completed');
    } else {
      request.log.info(logPayload, 'request completed');
    }
  });
}
