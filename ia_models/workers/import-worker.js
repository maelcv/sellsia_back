/**
 * import-worker.js
 *
 * Worker pour traitement des imports en masse (CSV/Excel)
 * Execution: toutes les 5 minutes pour jobs en attente
 */

import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

/**
 * Process bulk import jobs en attente
 * Note: Implémentation simplifiée — traiter le fichier depuis fileUrl en JSON
 */
export async function processPendingImports() {
  const pending = await prisma.bulkImportJob.findMany({
    where: { status: "pending" },
    take: 10,
  });

  console.log(`[Import Worker] Processing ${pending.length} pending jobs`);

  for (const job of pending) {
    try {
      // Marquer comme en cours
      await prisma.bulkImportJob.update({
        where: { id: job.id },
        data: { status: "processing" },
      });

      // TODO: Fetch file from storage + parse CSV/Excel
      // Pour démo: simuler 5 lignes traitées
      const rowsToProcess = Math.min(job.totalRows, 5);

      await prisma.bulkImportJob.update({
        where: { id: job.id },
        data: {
          processedRows: rowsToProcess,
          successCount: Math.floor(rowsToProcess * 0.95), // 95% success rate
          status: rowsToProcess >= job.totalRows ? "completed" : "processing",
          completedAt: rowsToProcess >= job.totalRows ? new Date() : null,
        },
      });

      console.log(`[Import] Job ${job.id} processed ${rowsToProcess}/${job.totalRows}`);
    } catch (err) {
      console.error(`[Import] Error processing job ${job.id}:`, err.message);
      await prisma.bulkImportJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          errorLog: JSON.stringify([{ line: 0, error: err.message }]),
        },
      });
    }
  }
}

/**
 * Start worker
 */
export function startImportWorker() {
  // Run immediately
  processPendingImports().catch(err => console.error("[Import Worker] Fatal:", err));

  // Then every 5 minutes
  setInterval(() => {
    processPendingImports().catch(err => console.error("[Import Worker] Fatal:", err));
  }, 5 * 60 * 1000);

  console.log("[Import Worker] Started (every 5 min)");
}
