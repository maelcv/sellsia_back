import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log("Migration des rôles...");

  // Update users with legacy roles to new roles
  // Since the enum changed in schema.prisma, we might need to use executeRaw if Prisma client is not re-generated yet
  // or just use raw SQL to avoid type checking issues.

  await prisma.$executeRawUnsafe(`UPDATE "User" SET role = 'ADMIN' WHERE role = 'admin'`);
  await prisma.$executeRawUnsafe(`UPDATE "User" SET role = 'GESTIONNAIRE' WHERE role = 'client'`);
  await prisma.$executeRawUnsafe(`UPDATE "User" SET role = 'USER' WHERE role = 'sub_client'`);

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
