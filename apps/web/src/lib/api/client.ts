import type { ApiErrorBody } from '../types';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3000';

const ACCESS_TOKEN_KEY = 'estateai.accessToken';
const REFRESH_TOKEN_KEY = 'estateai.refreshToken';

export class ApiError extends Error {
  status: number;
  body: ApiErrorBody | undefined;

  constructor(status: number, message: string, body?: ApiErrorBody) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

// Thrown specifically when the access token is missing/expired and the
// refresh attempt also failed — callers (useApiQuery, AuthProvider) treat
// this as "log the user out", distinct from any other 401/403 the API
// might return for a request that IS authenticated but not authorized.
export class SessionExpiredError extends Error {
  constructor() {
    super('Session expired — please log in again.');
    this.name = 'SessionExpiredError';
  }
}

export function getTokens(): { accessToken: string | null; refreshToken: string | null } {
  if (typeof window === 'undefined') return { accessToken: null, refreshToken: null };
  return {
    accessToken: window.localStorage.getItem(ACCESS_TOKEN_KEY),
    refreshToken: window.localStorage.getItem(REFRESH_TOKEN_KEY),
  };
}

export function setTokens(accessToken: string, refreshToken: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  window.localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
}

export function clearTokens(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(ACCESS_TOKEN_KEY);
  window.localStorage.removeItem(REFRESH_TOKEN_KEY);
}

let refreshPromise: Promise<string | null> | null = null;

// Single-flight refresh: if several requests 401 at once, only one
// POST /auth/refresh call is made and every caller awaits the same result.
async function refreshAccessToken(): Promise<string | null> {
  const { refreshToken } = getTokens();
  if (!refreshToken) return null;

  if (!refreshPromise) {
    refreshPromise = fetch(`${API_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    })
      .then(async (res) => {
        if (!res.ok) return null;
        const body = (await res.json()) as { accessToken: string; refreshToken: string };
        setTokens(body.accessToken, body.refreshToken);
        return body.accessToken;
      })
      .catch(() => null)
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  auth?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(path, API_URL);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function doFetch(path: string, options: RequestOptions, accessToken: string | null) {
  const headers: Record<string, string> = {};
  // Only declare a JSON body when one is actually being sent — Fastify's
  // default JSON body parser rejects an empty body when this header is
  // present (FST_ERR_CTP_EMPTY_JSON_BODY), which every body-less POST
  // (sync/discover/cancel/retry, ...) was tripping before this fix.
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (options.auth !== false && accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return fetch(buildUrl(path, options.query), {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

// The one chokepoint every API call in this app flows through — attaches
// the bearer token, retries exactly once on 401 after a token refresh, and
// normalizes every non-2xx response into a thrown ApiError/SessionExpiredError
// so callers only ever handle success or a single error shape.
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { accessToken } = getTokens();
  let res = await doFetch(path, options, accessToken);

  if (res.status === 401 && options.auth !== false) {
    const newToken = await refreshAccessToken();
    if (!newToken) {
      clearTokens();
      throw new SessionExpiredError();
    }
    res = await doFetch(path, options, newToken);
    if (res.status === 401) {
      clearTokens();
      throw new SessionExpiredError();
    }
  }

  if (!res.ok) {
    let body: ApiErrorBody | undefined;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      body = undefined;
    }
    throw new ApiError(res.status, body?.message ?? `Request failed (${res.status})`, body);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}
