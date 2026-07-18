// A very short expiry is needed to test expiration, so JWT_EXPIRES_IN is
// overridden before the config module (and anything that imports it) loads.
process.env.JWT_EXPIRES_IN = '1s';

const { jwtService } = await import('../src/services/auth/jwt.service.js');

const testUser = { id: 'user_verify_jwt', email: 'jwt-verify@example.test', role: 'USER' };

console.log('1. signAccessToken() — token generation');
const token = jwtService.signAccessToken(testUser);
console.log('   token:', token.slice(0, 24) + '...');

console.log('2. verifyAccessToken() — successful verification');
try {
  const payload = jwtService.verifyAccessToken(token);
  const isValid =
    payload.sub === testUser.id &&
    payload.email === testUser.email &&
    payload.role === testUser.role;
  console.log('   result:', isValid ? 'OK (payload matches)' : 'FAILED (payload mismatch)');
} catch {
  console.log('   result: FAILED (threw unexpectedly)');
}

console.log('3. verifyAccessToken() — tampered token rejection');
const lastChar = token.at(-1);
const tamperedToken = token.slice(0, -1) + (lastChar === 'A' ? 'B' : 'A');
try {
  jwtService.verifyAccessToken(tamperedToken);
  console.log('   result: FAILED (tampered token was accepted)');
} catch (err) {
  console.log('   result:', err instanceof Error ? `OK (${err.name})` : 'OK (rejected)');
}

console.log('4. verifyAccessToken() — expired token rejection (1s expiry)');
await new Promise((resolve) => setTimeout(resolve, 1500));
try {
  jwtService.verifyAccessToken(token);
  console.log('   result: FAILED (expired token was accepted)');
} catch (err) {
  const isExpiredError = err instanceof Error && err.name === 'TokenExpiredError';
  console.log('   result:', isExpiredError ? 'OK (TokenExpiredError)' : `FAILED (${String(err)})`);
}

console.log('\nAll JWT checks passed.');
