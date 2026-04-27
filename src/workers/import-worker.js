/**
 * import-worker.js
 *
 * Worker pour traitement des imports en masse (CSV/Excel)
 * Execution: toutes les 5 minutes pour jobs en attente
 */

import { prisma } from "../prisma.js";

/**
 * Process bulk import jobs en attente
 * Note: Implémentation simplifiée — traiter le fichier depuis fileUrl en JSON
 */
export async function processPendingImports() {
  try {
    let pending;
    try {
      pending = await prisma.bulkImportJob.findMany({
        where: { status: "pending" },
        take: 10,
      });
    } catch (err) {
      // Skip if RLS policies prevent access due to missing tenant/user context
      if (err?.message?.includes("Tenant or user not found") || err?.message?.includes("FATAL")) {
        console.log(`[Import Worker] Skipping (no tenant context)`);
        return;
      }
      throw err;
    }

    if (!pending || pending.length === 0) {
      console.log(`[Import Worker] No pending jobs`);
      return;
    }

    console.log(`[Import Worker] Processing ${pending.length} pending jobs`);

    for (const job of pending) {
      try {
        // Marquer comme en cours
        await prisma.bulkImportJob.update({
          where: { id: job.id },
          data: { status: "processing" },
        });

        // Bulk file import from storage is not yet implemented.
        // Mark as skipped so the job doesn't stay stuck in "processing".
        await prisma.bulkImportJob.update({
          where: { id: job.id },
          data: {
            status: "failed",
            errorLog: JSON.stringify([{ line: 0, error: "Bulk import from storage is not yet implemented." }]),
          },
        });

        console.log(`[Import] Job ${job.id} skipped — bulk file import not implemented`);
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
  } catch (err) {
    console.error("[Import Worker] Error:", err.message);
  }
}

/**
 * Start worker
 */
export function startImportWorker() {
  // Delay initial execution to allow DB connection to stabilize
  setTimeout(() => {
    processPendingImports().catch(err => console.error("[Import Worker] Error on startup:", err.message));
  }, 5000);

  // Then every 5 minutes
  setInterval(() => {
    processPendingImports().catch(err => console.error("[Import Worker] Error on interval:", err.message));
  }, 5 * 60 * 1000);

  console.log("[Import Worker] Started (every 5 min)");
}
