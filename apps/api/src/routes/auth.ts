import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { registerService } from '../services/auth/register.service.js';
import { loginService } from '../services/auth/login.service.js';
import { refreshTokenService } from '../services/auth/refresh-token.service.js';
import { jwtService } from '../services/auth/jwt.service.js';
import { userRepository } from '../repositories/user.repository.js';
import {
  EmailAlreadyExistsError,
  InvalidCredentialsError,
  InvalidRefreshTokenError,
} from '../services/auth/errors.js';
import { formatValidationErrors } from './shared/validation.js';

const registerBodySchema = z.object({
  email: z.email(),
  password: z.string().min(8),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
});

const loginBodySchema = z.object({
  email: z.email(),
  password: z.string().min(1),
});

const refreshBodySchema = z.object({
  refreshToken: z.string().min(1),
});

const logoutBodySchema = z.object({
  refreshToken: z.string().min(1),
});

export function authRoutes(app: FastifyInstance): void {
  app.post('/auth/register', async (request, reply) => {
    const parsed = registerBodySchema.safeParse(request.body);

    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      const user = await registerService.register(parsed.data);
      reply.code(201);
      return user;
    } catch (err) {
      if (err instanceof EmailAlreadyExistsError) {
        reply.code(409);
        return { status: 'error', message: err.message };
      }

      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.post('/auth/login', async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);

    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      const result = await loginService.login(parsed.data);
      reply.code(200);
      return result;
    } catch (err) {
      if (err instanceof InvalidCredentialsError) {
        reply.code(401);
        return { status: 'error', message: err.message };
      }

      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.get(
    '/auth/me',
    { preHandler: (request, reply) => app.authenticate(request, reply) },
    (request, reply) => {
      reply.code(200);
      return request.user;
    },
  );

  app.post('/auth/refresh', async (request, reply) => {
    const parsed = refreshBodySchema.safeParse(request.body);

    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      const rotated = await refreshTokenService.rotate(parsed.data.refreshToken);

      const user = await userRepository.findById(rotated.userId);
      if (!user) {
        reply.code(401);
        return { status: 'error', message: 'Invalid or expired refresh token' };
      }

      const accessToken = jwtService.signAccessToken(user);

      reply.code(200);
      return { accessToken, refreshToken: rotated.token };
    } catch (err) {
      if (err instanceof InvalidRefreshTokenError) {
        reply.code(401);
        return { status: 'error', message: err.message };
      }

      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });

  app.post('/auth/logout', async (request, reply) => {
    const parsed = logoutBodySchema.safeParse(request.body);

    if (!parsed.success) {
      reply.code(400);
      return formatValidationErrors(parsed.error);
    }

    try {
      await refreshTokenService.revoke(parsed.data.refreshToken);
      reply.code(200);
      return { status: 'ok' };
    } catch (err) {
      app.log.error(err);
      reply.code(500);
      return { status: 'error', message: 'Internal server error' };
    }
  });
}
