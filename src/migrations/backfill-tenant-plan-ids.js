/**
 * Script one-time : backfill Tenant.planId depuis Tenant.plan (string legacy)
 *
 * À exécuter UNE SEULE FOIS après la migration saas-mvp-foundation.
 * Met à jour tenants.plan_id en cherchant le Plan par son nom.
 *
 * Run: node src/migrations/backfill-tenant-plan-ids.js
 */

import { prisma } from "../prisma.js";

async function backfill() {
  console.log("🔄 Backfill tenant planId depuis plan (string legacy)...\n");

  const tenants = await prisma.tenant.findMany({
    where: { planId: null },
    select: { id: true, name: true, slug: true, plan: true }
  });

  if (tenants.length === 0) {
    console.log("✓ Aucun tenant à migrer (tous ont déjà planId).");
    return;
  }

  const plans = await prisma.plan.findMany({
    select: { id: true, name: true }
  });

  const planByName = Object.fromEntries(plans.map((p) => [p.name.toLowerCase(), p.id]));

  let updated = 0;
  let skipped = 0;

  for (const tenant of tenants) {
    const planName = (tenant.plan || "free").toLowerCase();
    const planId = planByName[planName];

    if (!planId) {
      console.warn(`  ⚠️  Tenant "${tenant.slug}" — plan "${tenant.plan}" introuvable en DB. Skipped.`);
      skipped++;
      continue;
    }

    await prisma.tenant.update({
      where: { id: tenant.id },
      data: { planId }
    });

    console.log(`  ✓ ${tenant.slug} → plan "${tenant.plan}" (planId: ${planId})`);
    updated++;
  }

  console.log(`\n✨ Backfill terminé : ${updated} mis à jour, ${skipped} ignorés.`);
  await prisma.$disconnect();
}

backfill().catch((err) => {
  console.error("💥 Backfill échoué :", err);
  process.exit(1);
});
