import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log("Migration des rôles...");

  const adminUsers = await prisma.user.updateMany({
    where: { role: 'admin' },
    data: { role: 'ADMIN' }
  });
  console.log(`- Admins migrés: ${adminUsers.count}`);

  const clientUsers = await prisma.user.updateMany({
    where: { role: 'client' },
    data: { role: 'GESTIONNAIRE' }
  });
  console.log(`- Gestionnaires migrés: ${clientUsers.count}`);

  const subClientUsers = await prisma.user.updateMany({
    where: { role: 'sub_client' },
    data: { role: 'USER' }
  });
  console.log(`- Users migrés: ${subClientUsers.count}`);

  console.log("Migration terminée.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
