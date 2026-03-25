/**
 * Seed script — Multi-tenant setup
 *
 * Crée :
 *   - Les 3 agents globaux (commercial, directeur, technicien)
 *   - 2 tenants de test : seli-dev et acme-dev
 *   - 1 user client par tenant
 *   - 1 super-admin plateforme (sans tenant)
 *   - Les accès agents pour chaque user de test
 *
 * Sécurité : utilise upsert partout — peut être relancé sans risque.
 * Run: node src/seed.js
 */

import { prisma } from "./prisma.js";
import bcrypt from "bcryptjs";

// ── Plans SaaS (définissent les permissions par workspace) ────

const FREE_PERMISSIONS = {
  ai_provider: false,
  agents_local: false,
  agents_cloud: false,
  knowledge_base: true,
  feedback: false,
  logs: false,
  crm_services: true,
  channel_services: false,
  sub_clients: false,
  user_profiles: true,
  reminders: true,
  usage_stats: false,
  orchestration_logs: false
};

const PRO_PERMISSIONS = {
  ai_provider: true,
  agents_local: true,
  agents_cloud: true,
  knowledge_base: true,
  feedback: true,
  logs: true,
  crm_services: true,
  channel_services: true,
  sub_clients: true,
  user_profiles: true,
  reminders: true,
  usage_stats: true,
  orchestration_logs: true
};

const PLANS = [
  {
    name: "free",
    monthlyTokenLimit: 50_000,
    collaboratorLimit: 2,
    priceEurMonth: 0,
    featuresJson: JSON.stringify(["Chat IA", "CRM Sellsy", "Rappels"]),
    permissionsJson: JSON.stringify(FREE_PERMISSIONS),
    maxSubClients: 0,
    maxUsers: 3,
    maxAgents: 0,
    isActive: true
  },
  {
    name: "pro",
    monthlyTokenLimit: 1_000_000,
    collaboratorLimit: 20,
    priceEurMonth: 99,
    featuresJson: JSON.stringify([
      "Chat IA",
      "CRM Sellsy",
      "Rappels",
      "Agents personnalisés (local + cloud)",
      "Provider IA configurable",
      "Knowledge Base",
      "Canaux WhatsApp",
      "Sous-clients",
      "Logs & Analytics"
    ]),
    permissionsJson: JSON.stringify(PRO_PERMISSIONS),
    maxSubClients: 10,
    maxUsers: 50,
    maxAgents: 20,
    isActive: true
  }
];

// ── Agents globaux (partagés entre tous les tenants) ──────────

const AGENTS = [
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
  console.log("🌱 Démarrage du seed multi-tenant...\n");

  // ── 0. Plans SaaS ─────────────────────────────────────────

  console.log("💎 Plans SaaS...");

  let freePlan, proPlan;
  for (const plan of PLANS) {
    const result = await prisma.plan.upsert({
      where: { name: plan.name },
      update: {
        permissionsJson: plan.permissionsJson,
        maxSubClients: plan.maxSubClients,
        maxUsers: plan.maxUsers,
        maxAgents: plan.maxAgents,
        monthlyTokenLimit: plan.monthlyTokenLimit,
        collaboratorLimit: plan.collaboratorLimit,
        priceEurMonth: plan.priceEurMonth,
        featuresJson: plan.featuresJson
      },
      create: plan
    });
    if (plan.name === "free") freePlan = result;
    if (plan.name === "pro") proPlan = result;
    console.log(`  ✓ Plan "${result.name}" (id: ${result.id})`);
  }

  // ── 1. Agents globaux ──────────────────────────────────────

  console.log("\n📦 Agents globaux...");

  // Désactiver les anciens agents si présents
  await prisma.agent.updateMany({
    where: { id: { in: ["sales-copilot", "executive-copilot", "solution-architect-copilot"] } },
    data: { isActive: false }
  });

  for (const agent of AGENTS) {
    const result = await prisma.agent.upsert({
      where: { id: agent.id },
      update: {},
      create: agent
    });
    console.log(`  ✓ Agent global : ${result.id}`);
  }

  // ── 2. Tenants de test ────────────────────────────────────

  console.log("\n🏢 Tenants de test...");

  const seli = await prisma.tenant.upsert({
    where: { slug: "seli-dev" },
    update: { planId: proPlan.id },
    create: {
      name: "SELI Dev",
      slug: "seli-dev",
      status: "active",
      plan: "pro",
      planId: proPlan.id
    }
  });
  console.log(`  ✓ Tenant SELI : ${seli.id} (plan: pro)`);

  const acme = await prisma.tenant.upsert({
    where: { slug: "acme-dev" },
    update: { planId: freePlan.id },
    create: {
      name: "ACME Dev",
      slug: "acme-dev",
      status: "active",
      plan: "free",
      planId: freePlan.id
    }
  });
  console.log(`  ✓ Tenant ACME : ${acme.id} (plan: free)`);

  // ── 3. Users de test ──────────────────────────────────────

  console.log("\n👤 Users de test...");

  const passwordHash = await bcrypt.hash("Password123!", 12);

  // Super-admin plateforme (sans tenant — voit tout)
  const admin = await prisma.user.upsert({
    where: { email: "admin@sellsia.local" },
    update: {},
    create: {
      email: "admin@sellsia.local",
      passwordHash,
      role: "admin",
      companyName: "Sellsia Platform",
      tenantId: null // super-admin : pas de tenant
    }
  });
  console.log(`  ✓ Super-admin : ${admin.email} (sans tenant)`);

  // User client SELI
  const seliUser = await prisma.user.upsert({
    where: { email: "seller@seli-dev.local" },
    update: {},
    create: {
      email: "seller@seli-dev.local",
      passwordHash,
      role: "client",
      companyName: "SELI Dev",
      tenantId: seli.id // lié au tenant SELI
    }
  });
  console.log(`  ✓ Client SELI : ${seliUser.email} (tenant: ${seli.slug})`);

  // User client ACME
  const acmeUser = await prisma.user.upsert({
    where: { email: "seller@acme-dev.local" },
    update: {},
    create: {
      email: "seller@acme-dev.local",
      passwordHash,
      role: "client",
      companyName: "ACME Dev",
      tenantId: acme.id // lié au tenant ACME
    }
  });
  console.log(`  ✓ Client ACME : ${acmeUser.email} (tenant: ${acme.slug})`);

  // ── 4. Accès agents pour les users de test ────────────────

  console.log("\n🔑 Accès agents...");

  for (const agentId of ["commercial", "directeur", "technicien"]) {
    // Accès pour le user SELI
    await prisma.userAgentAccess.upsert({
      where: { userId_agentId: { userId: seliUser.id, agentId } },
      update: {},
      create: { userId: seliUser.id, agentId, status: "granted" }
    });
    // Accès pour le user ACME
    await prisma.userAgentAccess.upsert({
      where: { userId_agentId: { userId: acmeUser.id, agentId } },
      update: {},
      create: { userId: acmeUser.id, agentId, status: "granted" }
    });
  }
  console.log("  ✓ Accès agents accordés aux 2 users de test");

  // ── Résumé ────────────────────────────────────────────────

  console.log("\n✨ Seed terminé avec succès !");
  console.log("\n📋 Comptes de test :");
  console.log("  admin@sellsia.local  / Password123!  → super-admin (tous tenants)");
  console.log("  seller@seli-dev.local / Password123!  → client SELI");
  console.log("  seller@acme-dev.local / Password123!  → client ACME");

  await prisma.$disconnect();
}

seed().catch((err) => {
  console.error("💥 Seed échoué :", err);
  process.exit(1);
});
