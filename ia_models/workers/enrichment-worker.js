/**
 * enrichment-worker.js
 *
 * Worker pour enrichissement SIRET via INSEE SIRENE API (open data)
 * Exécution via cron toutes les heures
 */

import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

const SIRENE_API = "https://api.insee.fr/entreprises/sirene/V3";

/**
 * Enrichit les données SIRET en attente
 * Exécution: toutes les heures via cron
 */
export async function enrichPendingSiret() {
  const pending = await prisma.siretEnrichment.findMany({
    where: { status: "pending" },
    take: 50, // Batch de 50
  });

  console.log(`[SIRENE Worker] Processing ${pending.length} pending enrichments`);

  for (const job of pending) {
    try {
      // Note: INSEE SIRENE API require API key
      // Pour démo: utiliser données mockes ou skip si pas de clé
      const apiKey = process.env.INSEE_API_KEY;

      if (!apiKey) {
        console.log(`[SIRENE] Skipping ${job.siret} (no INSEE_API_KEY)`);
        continue;
      }

      const response = await fetch(
        `${SIRENE_API}/siret/${job.siret}`,
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const etablissement = data.etablissement || {};

      await prisma.siretEnrichment.update({
        where: { id: job.id },
        data: {
          status: "completed",
          siren: data.siren,
          company: etablissement.enseigne || data.nomCommercial || "N/A",
          address: `${etablissement.numeroVoieEtablissement || ""} ${etablissement.typeVoieEtablissement || ""} ${etablissement.libelleVoieEtablissement || ""}`.trim(),
          postalCode: etablissement.codePostalEtablissement,
          city: etablissement.libelleCommuneEtablissement,
          sector: etablissement.nomenclatureActivitePrincipaleEtablissement,
          employees: parseInt(data.trancheEffectifsEtablissement || "0"),
          metadata: JSON.stringify({
            dateCreation: etablissement.dateCreationEtablissement,
            status: etablissement.etatAdministratifEtablissement,
          }),
        },
      });

      console.log(`[SIRENE] Enriched ${job.siret} successfully`);
    } catch (err) {
      console.error(`[SIRENE] Error enriching ${job.siret}:`, err.message);
      await prisma.siretEnrichment.update({
        where: { id: job.id },
        data: { status: "failed" },
      });
    }
  }
}

/**
 * Start worker (à appeler au boot du serveur)
 */
export function startEnrichmentWorker() {
  // Run immediately
  enrichPendingSiret().catch(err => console.error("[SIRENE Worker] Fatal:", err));

  // Then every hour
  setInterval(() => {
    enrichPendingSiret().catch(err => console.error("[SIRENE Worker] Fatal:", err));
  }, 60 * 60 * 1000);

  console.log("[SIRENE Worker] Started (every hour)");
}
