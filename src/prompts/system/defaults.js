/**
 * Compatibilité — exporte SYSTEM_PROMPTS et les prompts spéciaux
 * depuis les fichiers JSON seeds. Permet la compatibilité avec l'ancien code.
 */
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadJSON(name) {
  try {
    return JSON.parse(readFileSync(resolve(__dirname, `../defaults/${name}.json`), "utf-8"));
  } catch { return {}; }
}

const orchestratorData = loadJSON("orchestrator");

export const SYSTEM_PROMPTS = {
  orchestrator: orchestratorData.systemPrompt || "",
  directeur:    loadJSON("directeur").systemPrompt || "",
  commercial:   loadJSON("commercial").systemPrompt || "",
  technicien:   loadJSON("technicien").systemPrompt || "",
};

export const ORCHESTRATOR_PLAN_PROMPT      = orchestratorData.planPrompt || "";
export const ORCHESTRATOR_SYNTHESIS_PROMPT = orchestratorData.synthesisPrompt || "";
export const SUGGESTIONS_PROMPT            = orchestratorData.suggestionsPrompt || "";
export const SUMMARY_PROMPT                = orchestratorData.summaryPrompt || "";
