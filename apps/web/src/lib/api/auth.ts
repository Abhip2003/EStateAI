import { apiRequest } from './client';
import type { LoginResult, SafeUser } from '../types';

export const authApi = {
  login: (email: string, password: string) =>
    apiRequest<LoginResult>('/auth/login', { method: 'POST', body: { email, password }, auth: false }),

  me: () => apiRequest<SafeUser>('/auth/me'),

  logout: (refreshToken: string) =>
    apiRequest<{ status: string }>('/auth/logout', {
      method: 'POST',
      body: { refreshToken },
      auth: false,
    }),
};
