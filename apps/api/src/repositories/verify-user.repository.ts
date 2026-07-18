import { userRepository } from './user.repository.js';
import { prisma } from '../db/prisma.js';

async function main(): Promise<void> {
  const email = `verify-${Date.now()}@example.test`;

  console.log('1. create()');
  const created = await userRepository.create({
    email,
    passwordHash: 'not-a-real-hash',
    firstName: 'Verify',
    lastName: 'Script',
  });
  console.log('   created user id:', created.id);

  console.log('2. findByEmail()');
  const found = await userRepository.findByEmail(email);
  console.log('   found:', found?.email === email ? 'OK' : 'MISMATCH');

  console.log('3. existsByEmail()');
  const exists = await userRepository.existsByEmail(email);
  console.log('   exists:', exists);

  console.log('4. count()');
  const count = await userRepository.count();
  console.log('   total users:', count);

  console.log('5. delete() (cleanup)');
  const deleted = await userRepository.delete(created.id);
  console.log('   deleted:', deleted?.id === created.id ? 'OK' : 'MISMATCH');

  console.log('6. findById() after delete (should be null)');
  const afterDelete = await userRepository.findById(created.id);
  console.log('   result:', afterDelete);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
