import WebSocket from 'ws';
import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import { agentPlanExecutionRepository } from '../src/repositories/agent-plan-execution.repository.js';
import {
  api,
  BASE_URL,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';

const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws';

type ServerMessage =
  | { type: 'connected' }
  | { type: 'subscribed'; assetId: string }
  | { type: 'unsubscribed'; assetId: string }
  | { type: 'event'; assetId: string; event: { type: string; title: string } }
  | { type: 'error'; message: string };

// A small test harness around a raw `ws` connection: collects every
// message it receives (in order) and lets a check wait for the next one
// matching a predicate, with a timeout — messages can arrive interleaved
// (e.g. a burst of agent-progress events), so tests assert on "a matching
// message eventually arrived", not strictly on send/receive pairing.
class TestClient {
  readonly socket: WebSocket;
  private readonly received: ServerMessage[] = [];
  private readonly waiters: {
    predicate: (m: ServerMessage) => boolean;
    resolve: (m: ServerMessage) => void;
  }[] = [];
  closeCode: number | null = null;

  constructor(token: string | undefined) {
    const url = token ? `${WS_URL}?token=${encodeURIComponent(token)}` : WS_URL;
    this.socket = new WebSocket(url);
    this.socket.on('message', (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as ServerMessage;
      this.received.push(message);
      for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
        if (this.waiters[i].predicate(message)) {
          this.waiters[i].resolve(message);
          this.waiters.splice(i, 1);
        }
      }
    });
    this.socket.on('close', (code: number) => {
      this.closeCode = code;
    });
  }

  waitForOpenOrClose(timeoutMs = 5000): Promise<'open' | 'close'> {
    return new Promise((resolve) => {
      const onOpen = () => {
        cleanup();
        resolve('open');
      };
      const onClose = () => {
        cleanup();
        resolve('close');
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve('close');
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.off('open', onOpen);
        this.socket.off('close', onClose);
      };
      this.socket.on('open', onOpen);
      this.socket.on('close', onClose);
    });
  }

  send(message: Record<string, unknown>): void {
    this.socket.send(JSON.stringify(message));
  }

  waitFor(
    predicate: (m: ServerMessage) => boolean,
    timeoutMs = 5000,
  ): Promise<ServerMessage | null> {
    const already = this.received.find(predicate);
    if (already) return Promise.resolve(already);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      this.waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  eventsReceived(): ServerMessage[] {
    return this.received.filter((m) => m.type === 'event');
  }

  close(): void {
    if (this.socket.readyState === WebSocket.OPEN) this.socket.close();
  }
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const stamp = Date.now();
  let categoryId: string | undefined;
  let assetId: string | undefined;
  let otherAssetId: string | undefined;
  let adminId: string | undefined;
  let ownerId: string | undefined;
  let otherId: string | undefined;
  const clients: TestClient[] = [];
  const planIdsToClean: string[] = [];

  try {
    console.log('1. setup — admin+category, owner + another user, one asset each');
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('websocket');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-ws-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const other = await registerAndLogin(`verify-ws-other-${stamp}@example.test`);
    otherId = other.id;

    const assetRes = await api<{ id: string }>('POST', '/assets', owner.accessToken, {
      categoryId,
      name: `verify-ws-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const otherAssetRes = await api<{ id: string }>('POST', '/assets', other.accessToken, {
      categoryId,
      name: `verify-ws-other-asset-${stamp}`,
    });
    otherAssetId = otherAssetRes.body.id;

    console.log('2. authentication — missing/invalid token is rejected, valid token is accepted');
    const noToken = new TestClient(undefined);
    clients.push(noToken);
    const noTokenErr = await noToken.waitFor((m) => m.type === 'error');
    check(
      'missing token: server sends an error message',
      noTokenErr?.type === 'error',
      JSON.stringify(noTokenErr),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    check(
      'missing token: connection is closed (4401)',
      noToken.closeCode === 4401,
      `${noToken.closeCode}`,
    );

    const badToken = new TestClient('not-a-real-token');
    clients.push(badToken);
    const badTokenErr = await badToken.waitFor((m) => m.type === 'error');
    check('invalid token: server sends an error message', badTokenErr?.type === 'error');
    await new Promise((resolve) => setTimeout(resolve, 200));
    check(
      'invalid token: connection is closed (4401)',
      badToken.closeCode === 4401,
      `${badToken.closeCode}`,
    );

    const ownerClient = new TestClient(owner.accessToken);
    clients.push(ownerClient);
    const connectedMsg = await ownerClient.waitFor((m) => m.type === 'connected');
    check('valid token: server sends "connected"', connectedMsg?.type === 'connected');

    console.log('3. subscribe/unsubscribe — happy path and malformed messages');
    ownerClient.send({ type: 'subscribe', assetId });
    const subMsg = await ownerClient.waitFor((m) => m.type === 'subscribed');
    check(
      'subscribe to owned asset succeeds',
      subMsg?.type === 'subscribed' && subMsg.assetId === assetId,
      JSON.stringify(subMsg),
    );

    ownerClient.send({ type: 'unsubscribe', assetId });
    const unsubMsg = await ownerClient.waitFor((m) => m.type === 'unsubscribed');
    check(
      'unsubscribe succeeds',
      unsubMsg?.type === 'unsubscribed' && unsubMsg.assetId === assetId,
      JSON.stringify(unsubMsg),
    );

    ownerClient.socket.send('not valid json{{{');
    const malformedErr = await ownerClient.waitFor(
      (m) => m.type === 'error' && m.message.includes('Invalid message'),
    );
    check(
      'malformed message gets an error reply, connection stays open',
      malformedErr?.type === 'error',
    );
    check(
      'connection survives a malformed message',
      ownerClient.socket.readyState === WebSocket.OPEN,
    );

    // Re-subscribe for the event-delivery checks below.
    ownerClient.send({ type: 'subscribe', assetId });
    await ownerClient.waitFor((m) => m.type === 'subscribed');

    console.log('4. authorization — cannot subscribe to an asset you do not own');
    const otherClient = new TestClient(other.accessToken);
    clients.push(otherClient);
    await otherClient.waitFor((m) => m.type === 'connected');
    otherClient.send({ type: 'subscribe', assetId }); // owner's asset, not other's
    const forbiddenMsg = await otherClient.waitFor((m) => m.type === 'error');
    check(
      "subscribing to another user's asset is rejected",
      forbiddenMsg?.type === 'error',
      JSON.stringify(forbiddenMsg),
    );

    otherClient.send({ type: 'subscribe', assetId: otherAssetId });
    const ownSubMsg = await otherClient.waitFor((m) => m.type === 'subscribed');
    check('subscribing to your own asset still works', ownSubMsg?.type === 'subscribed');

    console.log('5. event delivery — a real AssetEvent reaches only the subscribed client');
    const eventTitle = `ws-check-event-${stamp}`;
    await api('POST', `/assets/${assetId}/events`, owner.accessToken, {
      type: 'WS_CHECK',
      title: eventTitle,
    });
    const delivered = await ownerClient.waitFor(
      (m) => m.type === 'event' && m.assetId === assetId && m.event.title === eventTitle,
    );
    check(
      'subscribed owner receives the pushed event',
      delivered?.type === 'event',
      JSON.stringify(delivered),
    );

    const leaked = otherClient
      .eventsReceived()
      .some((m) => m.type === 'event' && m.assetId === assetId);
    check('a client subscribed to a different asset never receives it', !leaked);

    console.log('6. event delivery — agent execution progress (real PLAN_*/AGENT_* events)');
    const preCount = ownerClient.eventsReceived().length;
    const planRes = await api<{ planId: string }>('POST', '/agents/execute', owner.accessToken, {
      requestType: 'DISCOVERY_SUMMARY',
      assetId,
    });
    planIdsToClean.push(planRes.body.planId);
    await ownerClient.waitFor((m) => m.type === 'event' && m.event.type === 'PLAN_COMPLETED');
    const agentEventTypes = ownerClient
      .eventsReceived()
      .slice(preCount)
      .map((m) => (m.type === 'event' ? m.event.type : ''));
    check(
      'PLAN_CREATED/AGENT_STARTED/AGENT_COMPLETED/PLAN_COMPLETED all arrive live',
      ['PLAN_CREATED', 'AGENT_STARTED', 'AGENT_COMPLETED', 'PLAN_COMPLETED'].every((t) =>
        agentEventTypes.includes(t),
      ),
      agentEventTypes.join(','),
    );

    console.log('7. disconnect/reconnect — a fresh connection works after the old one closes');
    ownerClient.close();
    await ownerClient.waitForOpenOrClose();
    check('connection closes cleanly', ownerClient.closeCode !== null);

    const reconnected = new TestClient(owner.accessToken);
    clients.push(reconnected);
    await reconnected.waitFor((m) => m.type === 'connected');
    reconnected.send({ type: 'subscribe', assetId });
    await reconnected.waitFor((m) => m.type === 'subscribed');

    const secondEventTitle = `ws-check-reconnect-${stamp}`;
    await api('POST', `/assets/${assetId}/events`, owner.accessToken, {
      type: 'WS_CHECK',
      title: secondEventTitle,
    });
    const reconnectedDelivery = await reconnected.waitFor(
      (m) => m.type === 'event' && m.event.title === secondEventTitle,
    );
    check(
      'a reconnected client resubscribes and receives new events',
      reconnectedDelivery?.type === 'event',
      JSON.stringify(reconnectedDelivery),
    );

    if (state.failed) {
      console.error('\nOne or more websocket checks FAILED.');
    } else {
      console.log('\nAll websocket checks passed.');
    }
  } finally {
    console.log('8. cleanup');
    for (const client of clients) client.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    for (const planId of planIdsToClean) {
      try {
        await agentPlanExecutionRepository.delete(planId);
      } catch {
        // Already deleted or never persisted — fine.
      }
    }
    if (assetId) await assetRepository.delete(assetId);
    if (otherAssetId) await assetRepository.delete(otherAssetId);
    console.log('   assets deleted');
    if (categoryId) await categoryRepository.delete(categoryId);
    console.log('   category deleted');
    if (adminId) await userRepository.delete(adminId);
    if (ownerId) await userRepository.delete(ownerId);
    if (otherId) await userRepository.delete(otherId);
    console.log('   users deleted');
  }

  if (state.failed) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
