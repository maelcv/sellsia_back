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
  orchestration_logs: false,
  email_service: false,
  calendar: false,
  documents: false,
  data_enrichment: false,
  mass_import: false,
  analytics: false,
  custom_fields: false,
  external_connections: false,
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
  orchestration_logs: true,
  email_service: true,
  calendar: true,
  documents: true,
  data_enrichment: true,
  mass_import: true,
  analytics: true,
  custom_fields: true,
  external_connections: true,
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

// NOTE: Base agents (Commercial, Director, Technical) are created via POST /api/agents-management/seed-base-agents
// They should NOT be pre-seeded here - they're created on-demand by the admin setup flow

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

  // ── 1. Clean up old agents ────────────────────────────────────

  console.log("\n📦 Cleaning up old agents...");

  // Désactiver les anciens agents si présents
  const oldAgents = await prisma.agent.updateMany({
    where: { id: { in: ["sales-copilot", "executive-copilot", "solution-architect-copilot"] } },
    data: { isActive: false }
  });
  console.log(`  ✓ Cleaned up ${oldAgents.count} old agents`);

  // ── 2. Tenants de test ────────────────────────────────────

  console.log("\n🏢 Workspaces de test...");

  const seli = await prisma.workspace.upsert({
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
  console.log(`  ✓ Workspace SELI : ${seli.id} (plan: pro)`);

  const acme = await prisma.workspace.upsert({
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

  // Super-admin plateforme (sans workspace — voit tout)
  const admin = await prisma.user.upsert({
    where: { email: "admin@sellsia.local" },
    update: {},
    create: {
      email: "admin@sellsia.local",
      passwordHash,
      role: "admin",
      companyName: "Sellsia Platform",
      workspaceId: null // super-admin : pas de workspace
    }
  });
  console.log(`  ✓ Super-admin : ${admin.email} (sans workspace)`);

  // User client SELI
  const seliUser = await prisma.user.upsert({
    where: { email: "seller@seli-dev.local" },
    update: {},
    create: {
      email: "seller@seli-dev.local",
      passwordHash,
      role: "client",
      companyName: "SELI Dev",
      workspaceId: seli.id // lié au workspace SELI
    }
  });
  console.log(`  ✓ Client SELI : ${seliUser.email} (workspace: ${seli.slug})`);

  // User client ACME
  const acmeUser = await prisma.user.upsert({
    where: { email: "seller@acme-dev.local" },
    update: {},
    create: {
      email: "seller@acme-dev.local",
      passwordHash,
      role: "client",
      companyName: "ACME Dev",
      workspaceId: acme.id // lié au workspace ACME
    }
  });
  console.log(`  ✓ Client ACME : ${acmeUser.email} (workspace: ${acme.slug})`);

  // ── 4. Integration types (pour IntegrationsPage) ────────────

  console.log("\n🔗 Integration types...");

  const integrationTypes = [
    // CRM
    {
      name: "Sellsy",
      category: "crm",
      logoUrl: "https://www.sellsy.com/favicon.ico",
      configSchema: { token: { type: "string" }, apiUrl: { type: "string" } },
    },
    {
      name: "HubSpot",
      category: "crm",
      logoUrl: "https://www.hubspot.com/favicon.ico",
      configSchema: { apiKey: { type: "string" } },
    },
    // Mail
    {
      name: "Gmail SMTP",
      category: "mail",
      logoUrl: "https://www.google.com/favicon.ico",
      configSchema: {
        email: { type: "string" },
        password: { type: "string" },
        smtpServer: { type: "string", default: "smtp.gmail.com" },
        port: { type: "number", default: 587 },
      },
    },
    // WhatsApp
    {
      name: "Meta Business WhatsApp",
      category: "whatsapp",
      logoUrl: "https://www.whatsapp.com/favicon.ico",
      configSchema: {
        businessAccountId: { type: "string" },
        accessToken: { type: "string" },
        phoneNumber: { type: "string" },
      },
    },
    // Calendar
    {
      name: "Google Calendar",
      category: "calendar",
      logoUrl: "https://www.google.com/favicon.ico",
      configSchema: {
        clientId: { type: "string" },
        clientSecret: { type: "string" },
        refreshToken: { type: "string" },
      },
    },
    // Other
    {
      name: "Webhook",
      category: "other",
      logoUrl: null,
      configSchema: {
        url: { type: "string" },
        secret: { type: "string" },
      },
    },
  ];

  for (const typeData of integrationTypes) {
    await prisma.integrationType.upsert({
      where: { name_category: { name: typeData.name, category: typeData.category } },
      update: {},
      create: typeData,
    });
  }
  console.log(`  ✓ ${integrationTypes.length} integration types seeded`);

  // ── 5. IA Providers (ExternalService) ─────────────────────────

  console.log("\n🤖 IA Providers...");

  const iaProviders = [
    {
      code: "claude-3-5-sonnet",
      name: "Claude 3.5 Sonnet",
      category: "ia_cloud",
      defaultConfig: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        version: "2024-10-22"
      })
    },
    {
      code: "claude-haiku",
      name: "Claude Haiku",
      category: "ia_cloud",
      defaultConfig: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        version: "2025-10-01"
      })
    },
    {
      code: "gpt-4",
      name: "GPT-4 Turbo",
      category: "ia_cloud",
      defaultConfig: JSON.stringify({
        model: "gpt-4-turbo",
        version: "2024-04-09"
      })
    },
    {
      code: "gpt-4o",
      name: "GPT-4o",
      category: "ia_cloud",
      defaultConfig: JSON.stringify({
        model: "gpt-4o",
        version: "2024-11-20"
      })
    },
    {
      code: "llama2-local",
      name: "Llama 2 (Local)",
      category: "ia_local",
      defaultConfig: JSON.stringify({
        model: "llama2",
        endpoint: "http://localhost:8000"
      })
    }
  ];

  for (const provider of iaProviders) {
    await prisma.externalService.upsert({
      where: { code: provider.code },
      update: {},
      create: provider
    });
  }
  console.log(`  ✓ ${iaProviders.length} IA providers seeded`);

  // ── 6. Admin Platform Agent ────────────────────────────────

  console.log("\n🤖 Admin Platform Agent...");

  await prisma.agent.upsert({
    where: { id: "admin-platform-agent" },
    update: {},
    create: {
      id: "admin-platform-agent",
      name: "Administrateur Plateforme",
      description: "Accès aux métriques et analytics de plateforme (admin uniquement)",
      isActive: true,
      agentType: "local",
      workspaceId: null, // Global agent
      createdAt: new Date(),
    },
  });
  console.log("  ✓ Admin Platform Agent créé");

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
