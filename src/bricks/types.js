/**
 * Brick SDK — Types partagés pour le système de briques.
 *
 * Une "brique" est l'unité atomique du Workflow Builder.
 * Chaque brique expose :
 *  - Son identifiant unique (id)
 *  - Ses métadonnées UI (name, description, icon, color, category)
 *  - Son schéma d'entrée/sortie (Zod → JSON Schema pour le frontend)
 *  - Sa fonction d'exécution (execute)
 *
 * Convention d'ID : "{category}:{namespace}:{action}"
 *   trigger:webhook
 *   trigger:schedule
 *   action:http_request
 *   action:send_email
 *   action:vault_write
 *   logic:condition
 */

import { z } from "zod";

export { z };

/**
 * Convertit un schéma Zod en JSON Schema simplifié pour le frontend.
 * Supporte : string, number, boolean, enum, optional, object.
 */
export function zodToJsonSchema(schema) {
  if (!schema || !schema._def) return { type: "object", properties: {} };

  const def = schema._def;

  if (def.typeName === "ZodObject") {
    const properties = {};
    const required = [];
    for (const [key, value] of Object.entries(def.shape())) {
      properties[key] = zodToJsonSchema(value);
      if (!(value._def?.typeName === "ZodOptional")) {
        required.push(key);
      }
    }
    return { type: "object", properties, required };
  }

  if (def.typeName === "ZodOptional") {
    return zodToJsonSchema(def.innerType);
  }

  if (def.typeName === "ZodString") {
    const result = { type: "string" };
    if (def.description) result.description = def.description;
    // Detect URL hint
    for (const check of def.checks || []) {
      if (check.kind === "url") result.format = "url";
      if (check.kind === "email") result.format = "email";
    }
    return result;
  }

  if (def.typeName === "ZodNumber") return { type: "number" };
  if (def.typeName === "ZodBoolean") return { type: "boolean" };

  if (def.typeName === "ZodEnum") {
    return { type: "string", enum: def.values };
  }

  if (def.typeName === "ZodRecord") return { type: "object" };
  if (def.typeName === "ZodAny") return {};

  return { type: "string" };
}

/**
 * Contexte d'exécution passé à chaque brique.
 * @typedef {Object} BrickContext
 * @property {string|null} workspaceId
 * @property {number|null} userId
 * @property {string}      runId
 */

/**
 * Interface attendue pour chaque définition de brique.
 * @typedef {Object} BrickDefinition
 * @property {string}   id          - Identifiant unique (ex: "action:send_email")
 * @property {string}   category    - "trigger" | "action" | "logic"
 * @property {string}   name        - Label affiché dans l'UI
 * @property {string}   description - Description courte
 * @property {string}   icon        - Nom d'icône lucide-react (ex: "Mail")
 * @property {string}   color       - Couleur hex pour le canvas
 * @property {object}   inputSchema - ZodObject validant les inputs
 * @property {object}   outputSchema - ZodObject décrivant le shape de l'output
 * @property {Function} execute     - async (inputs, context: BrickContext) => output
 */
