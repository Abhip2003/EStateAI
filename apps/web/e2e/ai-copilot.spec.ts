import { test, expect } from '@playwright/test';
import { API_URL, loginSeedAdmin, registerAndLogin, createCategory, createAsset } from './helpers';

test.describe('AI', () => {
  test('Generate Report — POST /ai/generate against the mock Claude server', async ({ request }) => {
    const user = await registerAndLogin(request, 'e2e-ai-generate');
    const res = await request.post(`${API_URL}/ai/generate`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
      data: { prompt: 'Summarize the security posture of this asset in one paragraph.' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.provider).toBe('claude');
    expect(typeof body.text).toBe('string');
    expect(body.text.length).toBeGreaterThan(0);
    expect(body.usage.totalTokens).toBeGreaterThan(0);
  });
});

test.describe('Copilot', () => {
  test('Chat — asset-scoped question gets a grounded answer', async ({ request }) => {
    const admin = await loginSeedAdmin(request);
    const categoryId = await createCategory(request, admin.accessToken, `e2e-cat-copilot-${Date.now()}`);
    const user = await registerAndLogin(request, 'e2e-copilot');
    const asset = await createAsset(request, user.accessToken, categoryId, 'e2e-copilot-asset');

    const res = await request.post(`${API_URL}/copilot/chat`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
      data: { assetId: asset.id, message: 'What is the current risk level of this asset?' },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('SUCCESS');
    expect(typeof body.answer).toBe('string');
    expect(body.answer.length).toBeGreaterThan(0);
  });

  test('WebSocket updates — a copilot chat emits COPILOT_CHAT_* events over GET /ws', async ({ page, request }) => {
    const admin = await loginSeedAdmin(request);
    const categoryId = await createCategory(request, admin.accessToken, `e2e-cat-copilot-ws-${Date.now()}`);
    const user = await registerAndLogin(request, 'e2e-copilot-ws');
    const asset = await createAsset(request, user.accessToken, categoryId, 'e2e-copilot-ws-asset');

    // Runs the WebSocket client inside the real browser (native WebSocket),
    // same runtime apps/web's RealtimeProvider itself uses — Node's own
    // `WebSocket` global isn't available on this project's Node 20.
    // `about:blank` has an opaque/null origin, which Chromium refuses to
    // open a WebSocket from — navigate to a real same-app page first.
    await page.goto('/login');
    const eventsPromise = page.evaluate(
      ({ token, assetId }) => {
        return new Promise<string[]>((resolve, reject) => {
          const seen: string[] = [];
          const ws = new WebSocket(`ws://localhost:3000/ws?token=${encodeURIComponent(token)}`);
          const timer = setTimeout(() => {
            ws.close();
            resolve(seen);
          }, 10_000);
          ws.addEventListener('message', (ev) => {
            const parsed = JSON.parse(String((ev as MessageEvent).data));
            // Asset domain events arrive wrapped as {type:'event', assetId,
            // event: {type: 'COPILOT_CHAT_COMPLETED', ...}} — see
            // websocket-gateway.ts's `send(connection.socket, {type:
            // 'event', assetId, event})`. Track both the envelope type and
            // (when present) the inner event type.
            seen.push(parsed.type === 'event' ? parsed.event?.type : parsed.type);
            if (parsed.type === 'connected') {
              ws.send(JSON.stringify({ type: 'subscribe', assetId }));
            }
            if (parsed.type === 'event' && parsed.event?.type === 'COPILOT_CHAT_COMPLETED') {
              clearTimeout(timer);
              ws.close();
              resolve(seen);
            }
          });
          ws.addEventListener('error', () => reject(new Error('WebSocket error')));
        });
      },
      { token: user.accessToken, assetId: asset.id },
    );

    // Give the socket a moment to connect + subscribe before firing the
    // chat call that should generate the event it's waiting on.
    await page.waitForTimeout(500);
    await request.post(`${API_URL}/copilot/chat`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
      data: { assetId: asset.id, message: 'Hello copilot, over WebSocket verification.' },
    });

    const types = await eventsPromise;
    expect(types).toContain('connected');
    expect(types).toContain('subscribed');
    expect(types).toContain('COPILOT_CHAT_COMPLETED');
  });
});
