import { credentialEncryptionService } from '../src/services/credential-encryption.service.js';

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`   ${label}: OK`);
  } else {
    console.log(`   ${label}: FAILED${detail ? ` (${detail})` : ''}`);
    process.exitCode = 1;
  }
}

function main(): void {
  const secret = 'ghp_superSecretGitHubTokenValue1234567890';

  console.log('1. encrypt()');
  const ciphertext = credentialEncryptionService.encrypt(secret);
  check(
    'ciphertext is a non-empty string',
    typeof ciphertext === 'string' && ciphertext.length > 0,
  );
  check('ciphertext does not contain the plaintext', !ciphertext.includes(secret));

  console.log('2. decrypt() round-trip');
  const decrypted = credentialEncryptionService.decrypt(ciphertext);
  check('decrypted value matches the original secret', decrypted === secret, decrypted);

  console.log('3. two encryptions of the same value produce different ciphertext');
  const ciphertext2 = credentialEncryptionService.encrypt(secret);
  check('ciphertexts differ (fresh random IV each time)', ciphertext !== ciphertext2);
  check(
    'second ciphertext still decrypts correctly',
    credentialEncryptionService.decrypt(ciphertext2) === secret,
  );

  console.log('4. tamper detection');
  const raw = Buffer.from(ciphertext, 'base64');
  raw[raw.length - 1] = raw[raw.length - 1] ^ 0xff; // flip bits in the ciphertext tail
  const tampered = raw.toString('base64');
  let tamperRejected = false;
  try {
    credentialEncryptionService.decrypt(tampered);
  } catch {
    tamperRejected = true;
  }
  check('tampered ciphertext is rejected', tamperRejected, 'decrypted without error');

  if (process.exitCode === 1) {
    console.error('\nOne or more credential encryption checks FAILED.');
  } else {
    console.log('\nAll credential encryption checks passed.');
  }
}

main();
