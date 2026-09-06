// Performance test — WebSocket throughput. Each VU opens one connection,
// authenticates, subscribes to its own asset, and measures connect+
// subscribe round-trip latency — a proxy for connection-establishment
// throughput under concurrent load (see docs/ARCHITECTURE.md: connections
// are held in-memory/process-local, so this also exercises
// connection-registry.ts directly).
import http from 'k6/http';
import ws from 'k6/ws';
import { check } from 'k6';
import { BASE_URL, adminLoginRaw, authHeaders } from './helpers.js';

const WS_URL = BASE_URL.replace(/^http/, 'ws');

export const options = {
  vus: 50,
  iterations: 50,
  thresholds: {
    ws_connecting: ['p(95)<1000'],
  },
};

export function setup() {
  const admin = adminLoginRaw('admin@estateai.local', 'ChangeMe123!');
  const slug = `k6-ws-${Date.now()}`;
  const catRes = http.post(
    `${BASE_URL}/categories`,
    JSON.stringify({ name: slug, slug }),
    authHeaders(admin.accessToken),
  );
  return { categoryId: catRes.json('id') };
}

export default function (data) {
  const email = `k6-ws-${__VU}-${__ITER}-${Date.now()}@example.test`;
  const password = 'CorrectHorseBatteryStaple1!';
  http.post(
    `${BASE_URL}/auth/register`,
    JSON.stringify({ email, password, firstName: 'K6', lastName: 'WS' }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  const login = http
    .post(`${BASE_URL}/auth/login`, JSON.stringify({ email, password }), {
      headers: { 'Content-Type': 'application/json' },
    })
    .json();
  const headers = authHeaders(login.accessToken);
  const asset = http
    .post(`${BASE_URL}/assets`, JSON.stringify({ categoryId: data.categoryId, name: `k6-ws-asset-${__VU}` }), headers)
    .json();

  let connected = false;
  let subscribed = false;
  const res = ws.connect(`${WS_URL}/ws?token=${login.accessToken}`, {}, (socket) => {
    socket.on('message', (msg) => {
      const parsed = JSON.parse(msg);
      if (parsed.type === 'connected') {
        connected = true;
        socket.send(JSON.stringify({ type: 'subscribe', assetId: asset.id }));
      }
      if (parsed.type === 'subscribed') {
        subscribed = true;
        socket.close();
      }
    });
    socket.setTimeout(() => socket.close(), 5000);
  });
  check(null, {
    'received connected': () => connected,
    'received subscribed': () => subscribed,
  });
  check(res, { 'ws handshake status is 101': (r) => r && r.status === 101 });
}
