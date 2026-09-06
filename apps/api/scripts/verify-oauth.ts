import http from 'node:http';
import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import { accountRepository } from '../src/repositories/account.repository.js';
import { prisma } from '../src/db/prisma.js';
import {
  api,
  BASE_URL,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';

const MOCK_PORT = 3999;
const MOCK_GITHUB_USER_ID = 990011;
const MOCK_ACCESS_TOKEN_PREFIX = 'mock-gh-access-token-';

interface AccountDto {
  id: string;
  provider: string;
  displayName: string | null;
  username: string | null;
  credentialCiphertext?: string;
}

// Stands in for github.com/login/oauth/access_token and api.github.com/user
// — GITHUB_TOKEN_URL / GITHUB_USER_URL in .env point here for local
// verification, since we have no real GitHub OAuth App credentials to
// exercise the actual handshake against.
function startMockGitHubServer(): Promise<http.Server> {
  let tokenCounter = 0;

  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/token') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString()));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { code?: string };
        if (parsed.code === 'trigger-exchange-failure') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad_verification_code' }));
          return;
        }
        tokenCounter += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            access_token: `${MOCK_ACCESS_TOKEN_PREFIX}${tokenCounter}`,
            token_type: 'bearer',
            scope: 'read:user user:email',
          }),
        );
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/user') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id: MOCK_GITHUB_USER_ID,
          login: 'verify-oauth-user',
          name: 'Verify OAuth User',
          email: 'verify-oauth@example.test',
          avatar_url: 'https://example.test/avatar.png',
        }),
      );
      return;
    }

    res.writeHead(404);
    res.end();
  });

  return new Promise((resolve) => {
    server.listen(MOCK_PORT, () => resolve(server));
  });
}

function extractState(location: string): string {
  const url = new URL(location);
  const state = url.searchParams.get('state');
  if (!state) throw new Error(`No state found in redirect location: ${location}`);
  return state;
}

async function main(): Promise<void> {
  const { check, state: checkState } = createChecker();
  const stamp = Date.now();
  let categoryId: string | undefined;
  let assetId: string | undefined;
  let otherAssetId: string | undefined;
  let adminId: string | undefined;
  let ownerId: string | undefined;
  let otherId: string | undefined;
  let connectedAccountId: string | undefined;
  const mockServer = await startMockGitHubServer();

  try {
    console.log('0. setup — admin+category, asset, owner + another user');
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('oauth');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-oauth-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const other = await registerAndLogin(`verify-oauth-other-${stamp}@example.test`);
    otherId = other.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-oauth-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    const otherAssetRes = await api<{ id: string }>('POST', '/assets', other.accessToken, {
      categoryId,
      name: `verify-oauth-other-asset-${stamp}`,
    });
    otherAssetId = otherAssetRes.body.id;

    console.log('1. unauthorized — initiating without a token is rejected');
    const noAuthInitiate = await fetch(`${BASE_URL}/oauth/github?assetId=${assetId}`, {
      redirect: 'manual',
    });
    check('status', noAuthInitiate.status === 401, `${noAuthInitiate.status}`);

    console.log("2. ownership enforcement — owner cannot initiate OAuth for another user's asset");
    const crossInitiate = await fetch(`${BASE_URL}/oauth/github?assetId=${otherAssetId}`, {
      method: 'GET',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    check('status', crossInitiate.status === 403, `${crossInitiate.status}`);

    console.log('3. authorization URL generation');
    const initiateRes = await fetch(`${BASE_URL}/oauth/github?assetId=${assetId}`, {
      method: 'GET',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    check('status is a redirect', initiateRes.status === 302, `${initiateRes.status}`);
    const location = initiateRes.headers.get('location') ?? '';
    check('redirect location present', location.length > 0);
    check('location contains client_id', location.includes('client_id='));
    check('location contains state', location.includes('state='));
    check('location contains redirect_uri', location.includes('redirect_uri='));
    const validState = extractState(location);

    console.log('4. missing code rejection');
    const missingCode = await api('GET', `/oauth/github/callback?state=${validState}`, undefined);
    check('status', missingCode.status === 400, `${missingCode.status}`);

    console.log('5. missing state rejection');
    const missingState = await api('GET', '/oauth/github/callback?code=some-code', undefined);
    check('status', missingState.status === 400, `${missingState.status}`);

    console.log('6. invalid state rejection');
    const invalidState = await api(
      'GET',
      '/oauth/github/callback?code=some-code&state=not-a-real-state',
      undefined,
    );
    check('status', invalidState.status === 400, `${invalidState.status}`);

    console.log('7. successful callback — completes the handshake and connects the account');
    const callbackRes = await api<{ status: string; account: AccountDto }>(
      'GET',
      `/oauth/github/callback?code=valid-code&state=${validState}`,
      undefined,
    );
    check('status', callbackRes.status === 200, `${callbackRes.status}`);
    check('provider is github', callbackRes.body.account?.provider === 'github');
    check('username from mock profile', callbackRes.body.account?.username === 'verify-oauth-user');
    check(
      'response does not include credentialCiphertext',
      callbackRes.body.account?.credentialCiphertext === undefined,
    );
    connectedAccountId = callbackRes.body.account?.id;

    console.log('8. state is single-use — replaying the same state now fails');
    const replay = await api(
      'GET',
      `/oauth/github/callback?code=valid-code&state=${validState}`,
      undefined,
    );
    check('status', replay.status === 400, `${replay.status}`);

    console.log(
      '9. encrypted token storage — DB row holds ciphertext, not the mock plaintext token',
    );
    const raw = connectedAccountId ? await accountRepository.findById(connectedAccountId) : null;
    check('row exists', raw !== null);
    check(
      'stored value does not contain the mock access token prefix',
      !raw?.credentialCiphertext?.includes(MOCK_ACCESS_TOKEN_PREFIX),
    );

    console.log('10. duplicate prevention — connecting the same GitHub user again is rejected');
    const secondInitiate = await fetch(`${BASE_URL}/oauth/github?assetId=${assetId}`, {
      method: 'GET',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    const secondState = extractState(secondInitiate.headers.get('location') ?? '');
    const duplicateRes = await api(
      'GET',
      `/oauth/github/callback?code=valid-code-2&state=${secondState}`,
      undefined,
    );
    check('status', duplicateRes.status === 409, `${duplicateRes.status}`);

    if (checkState.failed) {
      console.error('\nOne or more OAuth checks FAILED.');
    } else {
      console.log('\nAll OAuth checks passed.');
    }
  } finally {
    console.log('11. cleanup');
    mockServer.close();
    if (connectedAccountId) await accountRepository.delete(connectedAccountId);
    console.log('   account deleted');
    if (assetId) await assetRepository.delete(assetId);
    if (otherAssetId) await assetRepository.delete(otherAssetId);
    console.log('   assets deleted');
    if (categoryId) await categoryRepository.delete(categoryId);
    console.log('   category deleted');
    if (adminId) await userRepository.delete(adminId);
    if (ownerId) await userRepository.delete(ownerId);
    if (otherId) await userRepository.delete(otherId);
    console.log('   users deleted');
    await prisma.$disconnect();
  }

  if (checkState.failed) {
    process.exitCode = 1;
  }
}

void main();
