/**
 * Seed market report sources + default schedules + demo clients for a workspace.
 * Called from workspace creation hook and main seed.js.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_DATA_DIR = path.join(__dirname, "..", "ia_models", "market", "seed-data");
const SOURCES_DIR = path.join(SEED_DATA_DIR, "sources");
const CLIENTS_FILE = path.join(SEED_DATA_DIR, "clients.json");

function loadSeedSources() {
  if (!fs.existsSync(SOURCES_DIR)) return [];
  return fs
    .readdirSync(SOURCES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const raw = fs.readFileSync(path.join(SOURCES_DIR, f), "utf-8");
      const data = JSON.parse(raw);
      const slug = f.replace(/\.json$/, "");
      return {
        slug,
        label: data.label || data.name || slug,
        type: data.type || (f.includes("scrapper") ? "scrapping" : "api"),
        contentType: data.content_type || (data.urls_to_scrape || data.mappings ? "news" : "price"),
        configJson: JSON.stringify(data),
        enabled: data.enabled !== false,
      };
    });
}

function loadSeedClients() {
  if (!fs.existsSync(CLIENTS_FILE)) return [];
  return JSON.parse(fs.readFileSync(CLIENTS_FILE, "utf-8"));
}

/**
 * Idempotent: upserts 18 sources + 2 default schedules + demo clients for the given workspace.
 */
export async function seedMarketForWorkspace(prisma, workspaceId) {
  if (!workspaceId) throw new Error("workspaceId requis");

  const sources = loadSeedSources();
  for (const s of sources) {
    await prisma.marketSource.upsert({
      where: { workspaceId_slug: { workspaceId, slug: s.slug } },
      update: {
        label: s.label,
        type: s.type,
        contentType: s.contentType,
        // Don't overwrite config on re-seed (preserves user edits)
      },
      create: { workspaceId, ...s },
    });
  }

  const schedules = [
    { kind: "generic", cronExpr: "0 7 * * 1-5" },
    { kind: "unit", cronExpr: "0 15 * * 1-5" },
  ];
  for (const sch of schedules) {
    await prisma.marketReportSchedule.upsert({
      where: { workspaceId_kind: { workspaceId, kind: sch.kind } },
      update: {},
      create: {
        workspaceId,
        kind: sch.kind,
        cronExpr: sch.cronExpr,
        timezone: "Europe/Paris",
        enabled: false,
      },
    });
  }

  const clients = loadSeedClients();
  let clientsCreated = 0;
  for (const c of clients) {
    const existing = await prisma.marketClient.findFirst({
      where: { workspaceId, externalId: c.externalId },
    });
    if (!existing) {
      await prisma.marketClient.create({
        data: {
          workspaceId,
          externalId: c.externalId,
          nom: c.nom,
          contact: c.contact || null,
          email: c.email,
          langue: c.langue || "fr",
          note: c.note || null,
          produits: JSON.stringify(c.produits || []),
          active: true,
        },
      });
      clientsCreated++;
    }
  }

  return { sources: sources.length, clientsCreated };
}
