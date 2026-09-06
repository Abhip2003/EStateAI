import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { oauthService } from '../services/oauth/oauth.service.js';
import {
  DuplicateOAuthConnectionError,
  InvalidOAuthStateError,
  OAuthCodeExchangeError,
  OAuthConfigurationError,
  OAuthProviderError,
} from '../services/oauth/oauth-errors.js';
import { AssetNotFoundError } from '../services/assets/errors.js';
import { ForbiddenError } from '../services/auth/errors.js';
import { formatValidationErrors } from './shared/validation.js';

const providerParamsSchema = z.object({ provider: z.string().min(1) });
const initiateQuerySchema = z.object({ assetId: z.string().min(1) });
const callbackQuerySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

function mapOAuthError(
  err: unknown,
): { code: number; body: { status: 'error'; message: string } } | null {
  if (err instanceof ForbiddenError) {
    return { code: 403, body: { status: 'error', message: err.message } };
  }
  if (err instanceof AssetNotFoundError) {
    return { code: 404, body: { status: 'error', message: err.message } };
  }
  if (err instanceof DuplicateOAuthConnectionError) {
    return { code: 409, body: { status: 'error', message: err.message } };
  }
  if (
    err instanceof InvalidOAuthStateError ||
    err instanceof OAuthCodeExchangeError ||
    err instanceof OAuthProviderError
  ) {
    return { code: 400, body: { status: 'error', message: err.message } };
  }
  if (err instanceof OAuthConfigurationError) {
    return { code: 500, body: { status: 'error', message: err.message } };
  }
  return null;
}

export function oauthRoutes(app: FastifyInstance): void {
  const authenticate = {
    preHandler: (request: FastifyRequest, reply: FastifyReply) => app.authenticate(request, reply),
  };

  // Authenticated: this is the step that knows who is connecting and to
  // which asset. Redirects the browser to the provider's consent screen.
  app.get('/oauth/:provider', authenticate, async (request, reply) => {
    const paramsParsed = providerParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    const queryParsed = initiateQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      reply.code(400);
      return formatValidationErrors(queryParsed.error);
    }

    try {
      const authorizationUrl = await oauthService.initiate(
        paramsParsed.data.provider,
        request.user,
        queryParsed.data.assetId,
      );
      return reply.code(302).redirect(authorizationUrl);
    } catch (err) {
      const mapped = mapOAuthError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  // Not behind app.authenticate — see OAuthService.handleCallback for why.
  // Security comes from the single-use, TTL'd state token, not a header
  // GitHub's redirect could never carry.
  app.get('/oauth/:provider/callback', async (request, reply) => {
    const paramsParsed = providerParamsSchema.safeParse(request.params);
    if (!paramsParsed.success) {
      reply.code(400);
      return formatValidationErrors(paramsParsed.error);
    }

    const queryParsed = callbackQuerySchema.safeParse(request.query);
    if (!queryParsed.success) {
      reply.code(400);
      return formatValidationErrors(queryParsed.error);
    }

    try {
      const account = await oauthService.handleCallback(
        paramsParsed.data.provider,
        queryParsed.data.code,
        queryParsed.data.state,
      );
      reply.code(200);
      return { status: 'ok', account };
    } catch (err) {
      const mapped = mapOAuthError(err);
      if (mapped) {
        reply.code(mapped.code);
        return mapped.body;
      }
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });
}
