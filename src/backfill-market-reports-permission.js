/**
 * One-off backfill: enable market_reports permission on all existing plans.
 * Usage: node src/backfill-market-reports-permission.js
 */
import { prisma } from "./prisma.js";

async function main() {
  const plans = await prisma.plan.findMany();
  let updated = 0;
  for (const p of plans) {
    let perms = {};
    try { perms = JSON.parse(p.permissionsJson || "{}"); } catch { perms = {}; }
    if (perms.market_reports === true) continue;
    perms.market_reports = true;
    await prisma.plan.update({
      where: { id: p.id },
      data: { permissionsJson: JSON.stringify(perms) },
    });
    updated++;
  }
  console.log(`[backfill] market_reports=true sur ${updated}/${plans.length} plans`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
