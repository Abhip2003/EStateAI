import { passwordService } from '../src/services/password.service.js';

async function main(): Promise<void> {
  const correctPassword = 'CorrectHorseBatteryStaple';
  const wrongPassword = 'WrongPassword123';

  console.log('1. hash()');
  const hash = await passwordService.hash(correctPassword);
  console.log('   hash:', hash);

  console.log('2. verify() with correct password');
  const isCorrectValid = await passwordService.verify(correctPassword, hash);
  console.log('   result:', isCorrectValid === true ? 'OK (matched)' : 'FAILED (did not match)');

  console.log('3. verify() with wrong password');
  const isWrongValid = await passwordService.verify(wrongPassword, hash);
  console.log(
    '   result:',
    isWrongValid === false ? 'OK (correctly rejected)' : 'FAILED (incorrectly matched)',
  );

  if (!isCorrectValid || isWrongValid) {
    console.error('\nVerification FAILED');
    process.exitCode = 1;
    return;
  }

  console.log('\nAll password service checks passed.');
}

void main();
