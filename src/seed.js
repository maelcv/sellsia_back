import { 
  seedAgents, 
  seedSubAgents, 
  seedIntegrations, 
  seedProviders,
  BASE_AGENTS,
  BASE_SUB_AGENTS,
  INTEGRATION_TYPES,
  IA_PROVIDERS
} from "./lib/seed-lib.js";
import { prisma } from "./prisma.js";

async function seed() {
  console.log("🌱 Seed plateforme démarré...\n");

  await seedAgents();
  await seedSubAgents();
  await seedIntegrations();
  await seedProviders();

  console.log("\n✨ Seed terminé !");
  console.log("\n🤖 Agents globaux :", BASE_AGENTS.map(a => a.name).join(", "));
  console.log("🤖 Sous-agents & outils :", BASE_SUB_AGENTS.length);
  console.log("🔗 Types d'intégration :", INTEGRATION_TYPES.length);
  console.log("⚡ Providers IA :", IA_PROVIDERS.length);
  console.log("💡 Plans, workspaces et utilisateurs : gérés séparément (fixture ou onboarding UI).");

  await prisma.$disconnect();
}

seed().catch((err) => {
  console.error("💥 Seed échoué :", err);
  process.exit(1);
});
