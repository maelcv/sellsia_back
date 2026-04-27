/**
 * Vault Sync Worker — Synchronise les dossiers Obsidian au démarrage du serveur.
 * Crée Global/Users/<userId>/profile.md et Workspaces/<wsId>/<userId>/Uploads/ pour chaque user.
 * S'assure aussi que les agents globaux (dont le généraliste) existent en DB.
 */

import { prisma } from "../prisma.js";
import { initUserProfile } from "../services/memory/user-profile.js";
import { ensureWorkspaceBaseStructure, createFolder } from "../services/vault/vault-service.js";

async function ensureGlobalAgents() {
  const GLOBAL_AGENTS = [
    {
      id: "generaliste",
      name: "Généraliste",
      description: "Agent généraliste : météo, géographie, actualités, recherche web — fallback pour toute demande hors spécialités CRM.",
      agentType: "local",
      isActive: true,
      systemPrompt: "Tu es le Generaliste Agent de Boatswain. Tu prends en charge les demandes hors specialite des agents Commercial, Directeur et Technicien.\n\nObjectifs:\n- Fournir une reponse utile, fiable et actionnable meme sur des sujets externes au CRM.\n- Prioriser les informations factuelles et recentes.\n\nComportement obligatoire:\n- Si l'utilisateur demande la meteo: utilise get_user_gps pour obtenir sa localisation, puis get_meteo pour les previsions.\n- Si la question depend d'informations externes (actualites, marche, reglementation, evenement, geographie): utilise web_search.\n- Si une source precise est pertinente: utilise web_scrape pour lire le contenu de la page.\n- Croise plusieurs sources quand possible avant de conclure.\n- Si les informations sont incertaines ou incompletes, indique-le clairement et propose une recommandation prudente.\n\nStyle de reponse:\n- Concis, direct, professionnel.\n- 1 a 4 phrases par defaut.\n- Pas de narration technique, pas de nom d'outils, pas de parametres internes.\n- Termine si possible par une recommandation concrete ou une question de clarification."
    }
  ];

  for (const agentDef of GLOBAL_AGENTS) {
    const { systemPrompt, ...agentData } = agentDef;
    try {
      const agent = await prisma.agent.upsert({
        where: { id: agentData.id },
        update: { name: agentData.name, description: agentData.description, isActive: agentData.isActive },
        create: { ...agentData, workspaceId: null, allowedSubAgents: "[]", allowedTools: "[]" }
      });

      // Ensure the system prompt exists for this agent
      const existingPrompt = await prisma.agentPrompt.findFirst({
        where: { agentId: agent.id, isActive: true }
      });
      if (!existingPrompt) {
        await prisma.agentPrompt.create({
          data: { agentId: agent.id, systemPrompt, version: 1, isActive: true }
        });
        console.log(`[VaultSync] Agent "${agent.name}" créé en DB`);
      }
    } catch (err) {
      console.error(`[VaultSync] Failed to ensure agent ${agentDef.id}:`, err.message);
    }
  }
}

export async function startVaultSyncWorker() {
  try {
    console.log("[VaultSync] Starting vault synchronization...");

    // 0. S'assurer que les agents globaux existent en DB
    await ensureGlobalAgents();

    // 1. Récupérer tous les users avec workspace
    const users = await prisma.user.findMany({
      where: { workspaceId: { not: null } },
      select: { id: true, email: true, companyName: true, workspaceId: true }
    });

    if (users.length === 0) {
      console.log("[VaultSync] No workspace users found, skipping sync");
      return;
    }

    // 2. Initialiser profils Global/Users/<userId>/profile.md
    const profileResults = await Promise.allSettled(
      users.map(u =>
        initUserProfile(u.id, {
          email: u.email,
          name: u.companyName || u.email
        })
      )
    );

    // 3. Aussi les admins (workspaceId null)
    const admins = await prisma.user.findMany({
      where: { role: "ADMIN" },
      select: { id: true, email: true, companyName: true }
    });

    if (admins.length > 0) {
      await Promise.allSettled(
        admins.map(u =>
          initUserProfile(u.id, {
            email: u.email,
            name: u.companyName || u.email
          })
        )
      );
    }

    // 4. Grouper users par workspace
    const byWorkspace = {};
    for (const u of users) {
      if (!byWorkspace[u.workspaceId]) {
        byWorkspace[u.workspaceId] = [];
      }
      byWorkspace[u.workspaceId].push(u);
    }

    // 5. Créer structures Workspaces/<id>/<userId>/ + Uploads/
    for (const [wsId, members] of Object.entries(byWorkspace)) {
      const tasks = [];

      for (const member of members) {
        // Créer la base Workspaces/<id>/<userId>/
        tasks.push(
          ensureWorkspaceBaseStructure(wsId, member.id).catch(err => {
            console.error(
              `[VaultSync] ensureWorkspaceBaseStructure failed for workspace=${wsId}, user=${member.id}:`,
              err.message
            );
          })
        );

        // Créer Workspaces/<id>/<userId>/Uploads/
        tasks.push(
          createFolder(wsId, `${member.id}/Uploads`, member.id).catch(err => {
            // Acceptable si le dossier existe déjà
            if (!err.message?.includes("already exists")) {
              console.error(
                `[VaultSync] createFolder Uploads failed for workspace=${wsId}, user=${member.id}:`,
                err.message
              );
            }
          })
        );
      }

      await Promise.allSettled(tasks);
    }

    // Résumé
    const successfulProfiles = profileResults.filter(r => r.status === "fulfilled").length;
    const totalWorkspaces = Object.keys(byWorkspace).length;
    console.log(
      `[VaultSync] Synced ${users.length} users across ${totalWorkspaces} workspace(s) — ${successfulProfiles} profiles created/updated`
    );
  } catch (err) {
    console.error("[VaultSync] Critical sync failure:", err.message);
  }
}
