/**
 * Brick Registry — Catalogue centralisé de toutes les briques disponibles.
 *
 * Pour ajouter une nouvelle brique :
 *   1. Créer le fichier dans le dossier correspondant (triggers/, actions/, logic/)
 *   2. L'importer ici et l'ajouter à BRICKS
 *
 * Le registry est utilisé par :
 *   - automation-engine.js (exécution DAG)
 *   - GET /api/automations/bricks (catalogue frontend)
 */

import { zodToJsonSchema } from "./types.js";

import { webhookTrigger }   from "./triggers/webhook.js";
import { scheduleTrigger }  from "./triggers/schedule.js";
import { httpRequestAction } from "./actions/http-request.js";
import { sendEmailAction }   from "./actions/send-email.js";
import { vaultWriteAction }  from "./actions/vault-write.js";
import { conditionLogic }    from "./logic/condition.js";

const BRICKS = [
  webhookTrigger,
  scheduleTrigger,
  httpRequestAction,
  sendEmailAction,
  vaultWriteAction,
  conditionLogic,
];

// Lookup map pour accès O(1)
const BRICK_MAP = new Map(BRICKS.map((b) => [b.id, b]));

/**
 * Retourne la définition complète d'une brique (avec la fonction execute).
 * @param {string} id
 * @returns {BrickDefinition|undefined}
 */
export function getBrick(id) {
  return BRICK_MAP.get(id);
}

/**
 * Retourne toutes les briques sérialisables pour le frontend.
 * Les fonctions execute sont exclues.
 */
export function getAllBricksForClient() {
  return BRICKS.map(({ execute, inputSchema, outputSchema, ...meta }) => ({
    ...meta,
    inputSchema:  zodToJsonSchema(inputSchema),
    outputSchema: zodToJsonSchema(outputSchema),
  }));
}

/**
 * Retourne toutes les briques (usage interne engine uniquement).
 */
export function getAllBricks() {
  return BRICKS;
}
