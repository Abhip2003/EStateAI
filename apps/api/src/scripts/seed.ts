// Development/staging convenience seed — creates a single admin user so a
// fresh database has *something* to log in with, without inventing any
// fake assets/accounts/findings (those are only meaningful once a real
// GitHub OAuth connection exists, which a seed script can't fabricate
// honestly). Idempotent: safe to re-run against an already-seeded database.
//
// Lives under src/ (not prisma/) and is run via its compiled dist output
// (`node dist/scripts/seed.js`, see package.json's `prisma:seed` /
// prisma.config.ts's `migrations.seed`) rather than tsx-on-the-fly — the
// production Docker image ships `dist/` only, not `src/` (see
// apps/api/Dockerfile), so this needs to be a normal compiled module like
// everything else in this directory, not a standalone TS script with its
// own import story.
//
//   pnpm build && pnpm prisma:seed
//
// Never run against a production database with these placeholder
// credentials — see the console output below for the reminder.
import { userRepository } from '../repositories/user.repository.js';
import { passwordService } from '../services/password.service.js';
import { prisma } from '../db/prisma.js';

const SEED_ADMIN_EMAIL = 'admin@estateai.local';
const SEED_ADMIN_PASSWORD = 'ChangeMe123!';

async function main(): Promise<void> {
  const existing = await userRepository.findByEmail(SEED_ADMIN_EMAIL);
  if (existing) {
    console.log(`Seed admin already exists (${SEED_ADMIN_EMAIL}) — nothing to do.`);
    return;
  }

  const passwordHash = await passwordService.hash(SEED_ADMIN_PASSWORD);
  const admin = await userRepository.create({
    email: SEED_ADMIN_EMAIL,
    passwordHash,
    firstName: 'Admin',
    lastName: 'User',
    emailVerified: true,
    role: 'ADMIN',
  });

  console.log(`Created seed admin user: ${admin.email} (id: ${admin.id})`);
  console.log(`  Password: ${SEED_ADMIN_PASSWORD}`);
  console.log(
    '  Change this password immediately if this database is anything but a throwaway local/staging instance.',
  );
}

main()
  .catch((error: unknown) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
