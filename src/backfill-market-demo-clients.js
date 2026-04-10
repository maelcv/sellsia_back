/**
 * One-off backfill: inject demo market clients into all existing workspaces
 * that have the market_reports feature enabled.
 * Usage: node src/backfill-market-demo-clients.js
 */
import { prisma } from "./prisma.js";
import { seedMarketForWorkspace } from "./seed-market.js";

async function main() {
  // Find all workspaces that have market_reports sources already seeded
  const workspaces = await prisma.workspace.findMany({
    select: { id: true, name: true },
  });

  console.log(`[backfill] ${workspaces.length} workspace(s) trouvé(s)`);

  let total = 0;
  for (const ws of workspaces) {
    const { clientsCreated } = await seedMarketForWorkspace(prisma, ws.id);
    if (clientsCreated > 0) {
      console.log(`  ✓ ${ws.name || ws.id} : ${clientsCreated} client(s) créé(s)`);
      total += clientsCreated;
    } else {
      console.log(`  — ${ws.name || ws.id} : clients déjà présents`);
    }
  }

  console.log(`\n[backfill] Total : ${total} client(s) créé(s) sur ${workspaces.length} workspace(s)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
