/**
 * Seed script — Inserts the 3 default agents using Prisma.
 * Run with: node src/seed.js
 * Safe to run multiple times (uses upsert).
 */

import { prisma } from "./prisma.js";

const agents = [
  {
    id: "commercial",
    name: "Commercial",
    description: "Agent commercial : briefs compte, suivis, aide a la vente, relances, suggestions d'actions.",
    isActive: true
  },
  {
    id: "directeur",
    name: "Directeur",
    description: "Agent direction : reporting, alertes, analyse pipeline, syntheses, recommandations strategiques.",
    isActive: true
  },
  {
    id: "technicien",
    name: "Technicien",
    description: "Agent technique : configuration Sellsy, API, automatisation, integration, documentation.",
    isActive: true
  }
];

async function seed() {
  console.log("Seeding agents...");

  // Deactivate old agents if they exist
  await prisma.agent.updateMany({
    where: { id: { in: ["sales-copilot", "executive-copilot", "solution-architect-copilot"] } },
    data: { isActive: false }
  });
  console.log("  Deactivated old copilot agents (if any)");

  for (const agent of agents) {
    const result = await prisma.agent.upsert({
      where: { id: agent.id },
      update: {},
      create: agent
    });
    console.log(`  Upserted agent: ${result.id}`);
  }

  console.log("Done.");
  await prisma.$disconnect();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
