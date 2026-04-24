/**
 * conversation-memory.js — Synthèse et persistance de mémoire post-conversation (Boatswain V1)
 *
 * Déclenché en fire-and-forget après chaque stream SSE terminé.
 * Extrait des insights de la conversation et met à jour le profil utilisateur.
 *
 * Flow :
 *   1. Récupère les N derniers messages de la conversation
 *   2. Appelle l'IA pour extraire : topics, style, contexte pro, points clés
 *   3. Met à jour le profil vault + Prisma via user-profile.js
 */

import { prisma } from "../../prisma.js";
import { updateUserProfile, initUserProfile } from "./user-profile.js";
import { getProviderForUser } from "../../ai-providers/index.js";

const MIN_USER_MESSAGES = 2; // Minimum pour déclencher une analyse
const ANALYSIS_COOLDOWN_MS = 5 * 60 * 1000; // 5 min entre deux analyses du même user

// Throttle map (userId → last analyzed timestamp)
const _lastAnalyzed = new Map();

/**
 * Vérifie si on doit analyser cette conversation (throttle).
 */
function shouldAnalyze(userId, messageCount) {
  if (messageCount < MIN_USER_MESSAGES) return false;
  const last = _lastAnalyzed.get(userId);
  if (last && Date.now() - last < ANALYSIS_COOLDOWN_MS) return false;
  return true;
}

/**
 * Extrait les insights d'une conversation via l'IA.
 * @param {object} provider — provider LLM
 * @param {Array}  messages — messages de la conversation { role, content }[]
 * @returns {object} insights
 */
async function extractInsights(provider, messages) {
  const conversationText = messages
    .filter(m => m.role === "user" || m.role === "assistant")
    .slice(-20) // Max 20 messages
    .map(m => `${m.role === "user" ? "USER" : "ASSISTANT"}: ${m.content.slice(0, 400)}`)
    .join("\n\n");

  const prompt = `Analyze this conversation excerpt and extract structured insights about the user.
Respond ONLY with a valid JSON object (no markdown, no explanations).

Conversation:
${conversationText}

Required JSON format:
{
  "topics": ["topic1", "topic2"],
  "summary": "One sentence describing what the user needed",
  "responseStyle": "concise|balanced|detailed",
  "professionalContext": "Detected role/industry if any, else null",
  "styleObservation": "Observation about communication style/preferences, else null",
  "personality": { "formal": true/false, "technical": true/false, "detail_oriented": true/false }
}`;

  try {
    let rawResponse = "";
    for await (const chunk of provider.stream([
      { role: "user", content: prompt }
    ], { model: provider.config.defaultModel, temperature: 0.1, maxTokens: 400 })) {

      if (chunk.type === "text") rawResponse += chunk.content;
    }

    // Clean and parse JSON
    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.warn("[ConversationMemory] Failed to extract insights:", err.message);
    return null;
  }
}

/**
 * Point d'entrée principal — appeler en fire-and-forget après un stream terminé.
 * @param {object} options
 * @param {number} options.userId
 * @param {string} options.conversationId
 * @param {object} options.user — { id, email, name }
 */
export async function processConversationMemory({ userId, conversationId, user }) {
  try {
    // 1. Récupérer les messages de la conversation
    const messages = await prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
      select: { role: true, content: true }
    });

    const userMessages = messages.filter(m => m.role === "user");
    if (!shouldAnalyze(userId, userMessages.length)) return;

    // 2. Marquer le throttle
    _lastAnalyzed.set(userId, Date.now());

    // 3. S'assurer que le profil existe
    await initUserProfile(userId, user || {});

    // 4. Récupérer le provider
    const provider = await getProviderForUser(userId);
    if (!provider) return;

    // 5. Extraire les insights
    const insights = await extractInsights(provider, messages);
    if (!insights) return;

    // 6. Mettre à jour le profil
    await updateUserProfile(userId, insights);

    console.log(`[ConversationMemory] Updated profile for user ${userId} (conv: ${conversationId})`);
  } catch (err) {
    // Never throw — this is fire-and-forget
    console.warn("[ConversationMemory] Non-critical error:", err.message);
  }
}
