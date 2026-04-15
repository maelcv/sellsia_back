/**
 * Migration : KnowledgeDocument → Vault
 *
 * Convertit tous les KnowledgeDocument existants en fichiers .md dans le vault
 * du workspace de l'agent/propriétaire associé.
 *
 * Usage : node src/scripts/migrate-kb-to-vault.js [--dry-run]
 *
 * Structure cible :
 *   Knowledge/{type}/{slug}.md
 *
 * Frontmatter généré :
 *   ---
 *   title: <titre>
 *   type: <docType>
 *   agentId: <agentId>
 *   migratedAt: <ISO date>
 *   ---
 */

import { prisma } from "../prisma.js";
import { writeNote } from "../services/vault/vault-service.js";

const DRY_RUN = process.argv.includes("--dry-run");

function slugify(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function buildFrontmatter(doc) {
  return [
    "---",
    `title: "${doc.title.replace(/"/g, '\\"')}"`,
    `type: ${doc.type || "general"}`,
    doc.agentId ? `agentId: ${doc.agentId}` : null,
    `migratedAt: ${new Date().toISOString()}`,
    "---",
    "",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

async function resolveWorkspaceId(doc) {
  // Prefer workspace from agent
  if (doc.agentId) {
    const agent = await prisma.agent.findUnique({
      where: { id: doc.agentId },
      select: { workspaceId: true },
    });
    if (agent?.workspaceId) return agent.workspaceId;
  }

  // Fallback: workspace from owner user
  if (doc.clientId) {
    const user = await prisma.user.findUnique({
      where: { id: doc.clientId },
      select: { workspaceId: true },
    });
    if (user?.workspaceId) return user.workspaceId;
  }

  return null;
}

async function main() {
  console.log(`[migrate-kb-to-vault] Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}`);

  const docs = await prisma.knowledgeDocument.findMany({
    where: { isActive: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`[migrate-kb-to-vault] Found ${docs.length} documents to migrate`);

  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const doc of docs) {
    const workspaceId = await resolveWorkspaceId(doc);

    if (!workspaceId) {
      console.warn(`[skip] doc ${doc.id} "${doc.title}" — no workspaceId found`);
      skipped++;
      continue;
    }

    const folder = `Knowledge/${doc.type || "general"}`;
    const filename = `${slugify(doc.title) || doc.id}.md`;
    const notePath = `${folder}/${filename}`;

    const frontmatter = buildFrontmatter(doc);
    const content = `${frontmatter}\n${doc.content || ""}`;

    console.log(`[migrate] ${workspaceId}/${notePath}`);

    if (!DRY_RUN) {
      try {
        await writeNote(workspaceId, notePath, content);
        migrated++;
      } catch (err) {
        console.error(`[error] ${notePath}: ${err.message}`);
        errors++;
      }
    } else {
      migrated++;
    }
  }

  console.log(
    `\n[migrate-kb-to-vault] Done — migrated: ${migrated}, skipped: ${skipped}, errors: ${errors}`
  );

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error("[migrate-kb-to-vault] Fatal:", err);
  process.exit(1);
});
