// Persistent GitHub + Claude mock servers for the E2E suite, matching the
// exact ports/paths apps/api/.env already points GITHUB_*_URL / CLAUDE_API_URL
// at (localhost:3999 / 3998 — the same convention every apps/api verify:*
// script uses, see apps/api/scripts/verify-oauth.ts / verify-ai.ts). Those
// scripts each spin their own short-lived mock; this is the same shape kept
// alive for the whole Playwright run instead, since E2E tests exercise the
// long-running dev server rather than a one-shot script.
import http from 'node:http';

const GITHUB_PORT = 3999;
const CLAUDE_PORT = 3998;

function readJsonBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

let tokenCounter = 0;

const githubServer = http.createServer((req, res) => {
  void (async () => {
    if (req.method === 'POST' && req.url === '/token') {
      const body = await readJsonBody(req);
      if (body.code === 'e2e-bad-code') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_verification_code' }));
        return;
      }
      tokenCounter += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: `e2e-mock-token-${tokenCounter}`, token_type: 'bearer' }));
      return;
    }

    const auth = req.headers.authorization ?? '';
    const authorized = auth.includes('e2e-good-credential') || auth.includes('e2e-mock-token');

    if (req.method === 'GET' && req.url === '/user') {
      if (!authorized) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'Bad credentials' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ login: 'e2e-user', public_repos: 2, followers: 3 }));
      return;
    }

    if (req.method === 'GET' && req.url === '/user/repos') {
      if (!authorized) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            id: 1,
            name: 'e2e-repo',
            full_name: 'e2e-user/e2e-repo',
            private: false,
            html_url: 'https://github.com/e2e-user/e2e-repo',
            description: 'E2E mock repository',
            default_branch: 'main',
            visibility: 'public',
            archived: false,
            updated_at: new Date().toISOString(),
          },
        ]),
      );
      return;
    }

    if (req.method === 'GET' && req.url === '/user/orgs') {
      if (!authorized) {
        res.writeHead(401);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([]));
      return;
    }

    res.writeHead(404);
    res.end();
  })();
});

const claudeServer = http.createServer((req, res) => {
  void (async () => {
    if (req.method !== 'POST' || !req.url?.startsWith('/messages')) {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = await readJsonBody(req);
    const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === 'user');
    const content = lastUser?.content ?? '';

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        model: body.model ?? 'claude-e2e-mock',
        content: [
          {
            type: 'text',
            text:
              '## Executive Summary\nE2E mock AI response.\n\n## Risk Analysis\nMock risk analysis text.\n\n## Compliance Analysis\nMock compliance text.\n\n## Recommendations\nMock recommendations text.\n\n## Conclusion\nMock conclusion.\n' +
              `\n\n(prompt excerpt: ${String(content).slice(0, 60)})`,
          },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 42, output_tokens: 18 },
      }),
    );
  })();
});

githubServer.listen(GITHUB_PORT, () => console.log(`[e2e] mock GitHub listening on :${GITHUB_PORT}`));
claudeServer.listen(CLAUDE_PORT, () => console.log(`[e2e] mock Claude listening on :${CLAUDE_PORT}`));
