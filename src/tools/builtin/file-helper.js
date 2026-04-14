/**
 * File Helper Sub-Agent — Analyse les fichiers uploadés par l'utilisateur
 * et extrait le contenu pertinent pour enrichir le contexte.
 */

import { BaseSubAgent } from "./base-sub-agent.js";

// File tools imported at runtime from tools.js
import { FILE_TOOLS } from "../mcp/tools.js";

const SYSTEM_PROMPT = `Tu es un sous-agent specialise dans l'analyse de fichiers.

ROLE : Analyser les fichiers fournis par l'utilisateur et extraire les informations pertinentes pour repondre a la demande.

PROCESSUS :
1. Identifie le type de chaque fichier disponible (PDF, CSV, Excel, Word)
2. Utilise l'outil de parsing adapte pour extraire le contenu
3. Analyse le contenu extrait en relation avec la demande
4. Synthetise les informations pertinentes

REGLES :
- Extrais UNIQUEMENT les informations pertinentes pour la demande
- Structure ta reponse de maniere claire et exploitable
- Si un fichier ne contient pas d'information utile, indique-le brievement
- Ne modifie jamais le contenu des fichiers, tu ne fais que les lire`;

export class FileHelperSubAgent extends BaseSubAgent {
  constructor({ provider }) {
    super({
      type: "file",
      provider,
      tools: FILE_TOOLS,
      systemPrompt: SYSTEM_PROMPT
    });
  }
}
