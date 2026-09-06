import { userRepository } from '../src/repositories/user.repository.js';
import { categoryRepository } from '../src/repositories/category.repository.js';
import { assetRepository } from '../src/repositories/asset.repository.js';
import { accountRepository } from '../src/repositories/account.repository.js';
import { prisma } from '../src/db/prisma.js';
import {
  api,
  createAdminAndCategory,
  createChecker,
  registerAndLogin,
} from './lib/verify-helpers.js';

interface AccountDto {
  id: string;
  assetId: string;
  provider: string;
  displayName: string | null;
  connectionStatus: string;
  credentialCiphertext?: string;
}

interface AccountListDto {
  items: AccountDto[];
  total: number;
}

async function main(): Promise<void> {
  const { check, state } = createChecker();
  const stamp = Date.now();
  const secret = 'sk_live_super_secret_token_1234567890';
  let categoryId: string | undefined;
  let assetId: string | undefined;
  let adminId: string | undefined;
  let ownerId: string | undefined;
  let otherId: string | undefined;
  let accountId: string | undefined;

  try {
    console.log('0. setup — admin+category, asset, owner + another user');
    const { admin, categoryId: newCategoryId } = await createAdminAndCategory('account');
    adminId = admin.id;
    categoryId = newCategoryId;

    const owner = await registerAndLogin(`verify-account-owner-${stamp}@example.test`);
    ownerId = owner.id;
    const other = await registerAndLogin(`verify-account-other-${stamp}@example.test`);
    otherId = other.id;
    const ownerToken = owner.accessToken;

    const assetRes = await api<{ id: string }>('POST', '/assets', ownerToken, {
      categoryId,
      name: `verify-account-asset-${stamp}`,
    });
    assetId = assetRes.body.id;

    console.log('1. create — connect an account with a credential');
    const connectRes = await api<AccountDto>('POST', '/accounts/connect', ownerToken, {
      assetId,
      provider: 'github',
      credential: secret,
      displayName: 'My GitHub',
      metadata: { plan: 'pro' },
    });
    check('status', connectRes.status === 201, `${connectRes.status}`);
    check(
      'response does not include credentialCiphertext',
      connectRes.body.credentialCiphertext === undefined,
      JSON.stringify(connectRes.body),
    );
    accountId = connectRes.body.id;

    console.log('2. encrypted storage — DB row holds ciphertext, not plaintext');
    const raw = await accountRepository.findById(accountId);
    check('row exists', raw !== null);
    check(
      'stored value is not the plaintext secret',
      raw?.credentialCiphertext !== secret,
      String(raw?.credentialCiphertext),
    );
    check(
      'stored value does not contain the plaintext secret',
      !raw?.credentialCiphertext?.includes(secret),
    );

    console.log('3. list — GET /accounts scoped to the owner');
    const listRes = await api<AccountListDto>('GET', '/accounts', ownerToken);
    check('status', listRes.status === 200, `${listRes.status}`);
    check(
      'owner sees the connected account',
      listRes.body.items.some((a) => a.id === accountId),
      'account missing from owner list',
    );

    console.log('4. update — change displayName');
    const updateRes = await api<AccountDto>('PATCH', `/accounts/${accountId}`, ownerToken, {
      displayName: 'Renamed GitHub',
    });
    check('status', updateRes.status === 200, `${updateRes.status}`);
    check(
      'displayName updated',
      updateRes.body.displayName === 'Renamed GitHub',
      updateRes.body.displayName ?? 'null',
    );

    console.log('5. rotate credential — new credential re-encrypts');
    const rotatedSecret = 'sk_live_rotated_token_9876543210';
    const rotateRes = await api<AccountDto>('PATCH', `/accounts/${accountId}`, ownerToken, {
      credential: rotatedSecret,
    });
    check('status', rotateRes.status === 200, `${rotateRes.status}`);
    const rawAfterRotate = await accountRepository.findById(accountId);
    check(
      'stored ciphertext changed after rotation',
      rawAfterRotate?.credentialCiphertext !== raw?.credentialCiphertext,
    );
    check(
      'rotated ciphertext does not contain the new plaintext secret',
      !rawAfterRotate?.credentialCiphertext?.includes(rotatedSecret),
    );

    console.log('6. unauthorized access — no token is rejected');
    const noAuth = await api('GET', '/accounts', undefined);
    check('status', noAuth.status === 401, `${noAuth.status}`);

    console.log("7. cross-user isolation — another user cannot see owner's account");
    const otherList = await api<AccountListDto>('GET', '/accounts', other.accessToken);
    check('status', otherList.status === 200, `${otherList.status}`);
    check(
      "other user's list does not contain owner's account",
      !otherList.body.items.some((a) => a.id === accountId),
      'cross-user leak detected',
    );

    console.log("8. cross-user isolation — another user cannot update owner's account");
    const otherUpdate = await api('PATCH', `/accounts/${accountId}`, other.accessToken, {
      displayName: 'Hijacked',
    });
    check('status', otherUpdate.status === 403, `${otherUpdate.status}`);

    console.log("9. cross-user isolation — another user cannot disconnect owner's account");
    const otherDelete = await api('DELETE', `/accounts/${accountId}`, other.accessToken);
    check('status', otherDelete.status === 403, `${otherDelete.status}`);

    console.log('10. disconnect — owner disconnects the account');
    const disconnectRes = await api<AccountDto>('DELETE', `/accounts/${accountId}`, ownerToken);
    check('status', disconnectRes.status === 200, `${disconnectRes.status}`);
    check(
      'connectionStatus is disconnected',
      disconnectRes.body.connectionStatus === 'disconnected',
      disconnectRes.body.connectionStatus,
    );
    const rawAfterDisconnect = await accountRepository.findById(accountId);
    check(
      'credentialCiphertext cleared after disconnect',
      rawAfterDisconnect?.credentialCiphertext === null,
    );

    if (state.failed) {
      console.error('\nOne or more account checks FAILED.');
    } else {
      console.log('\nAll account checks passed.');
    }
  } finally {
    console.log('11. cleanup');
    if (accountId) await accountRepository.delete(accountId);
    console.log('   account deleted');
    if (assetId) await assetRepository.delete(assetId);
    console.log('   asset deleted');
    if (categoryId) await categoryRepository.delete(categoryId);
    console.log('   category deleted');
    if (adminId) await userRepository.delete(adminId);
    if (ownerId) await userRepository.delete(ownerId);
    if (otherId) await userRepository.delete(otherId);
    console.log('   users deleted');
    await prisma.$disconnect();
  }

  if (state.failed) {
    process.exitCode = 1;
  }
}

void main();
