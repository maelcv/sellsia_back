/**
 * user-profile.js — Service de profil utilisateur IA (Boatswain V1)
 *
 * Gère le profil markdown de chaque utilisateur dans le vault :
 *   Global/Users/<userId>/profile.md
 *
 * Opérations :
 *   - getUserProfile(userId)      : lit le profil existant
 *   - initUserProfile(userId, user) : crée le profil initial
 *   - updateUserProfile(userId, conversationInsights) : enrichit avec les insights extraits
 *   - syncUserProfileToDb(userId, profileData) : synchronise les métadonnées dans UserProfile (Prisma)
 */

import { writeRootNote, readRootNote, appendRootNote } from "../vault/vault-service.js";
import { prisma } from "../../prisma.js";

const USERS_BASE_PATH = "Global/Users";

/**
 * Retourne le chemin vault du profil d'un utilisateur.
 */
function profilePath(userId) {
  return `${USERS_BASE_PATH}/${userId}/profile.md`;
}

/**
 * Lit le profil markdown d'un utilisateur.
 * Retourne null si inexistant.
 */
export async function getUserProfile(userId) {
  try {
    const note = await readRootNote(profilePath(userId));
    return note?.content || null;
  } catch {
    return null;
  }
}

/**
 * Crée le profil initial d'un utilisateur s'il n'existe pas encore.
 */
export async function initUserProfile(userId, user = {}) {
  const existing = await getUserProfile(userId);
  if (existing) return existing;

  const now = new Date().toISOString().split("T")[0];
  const content = `---
userId: ${userId}
name: ${user.name || user.email || "Unknown"}
email: ${user.email || ""}
createdAt: ${now}
lastUpdated: ${now}
---

# AI User Profile

## Communication Preferences
- Response style: balanced
- Preferred language: fr
- Tone: professional

## Detected Interests
_No interests detected yet. Will be updated as conversations progress._

## Professional Context
- Role: _to be detected_
- Industry: _to be detected_

## Interaction History
- First conversation: ${now}
- Frequent topics: _none yet_

## Agent Notes
_Observations will be added automatically after each conversation._
`;

  await writeRootNote(profilePath(userId), content);

  // Init Prisma record
  await prisma.userProfile.upsert({
    where: { userId },
    create: { userId, chatLanguage: "fr", responseStyle: "balanced" },
    update: {}
  });

  return content;
}

/**
 * Enrichit le profil utilisateur avec des insights extraits d'une conversation.
 * @param {number} userId
 * @param {object} insights — { summary, topics, styleObservation, professionalContext }
 */
export async function updateUserProfile(userId, insights = {}) {
  if (!insights || Object.keys(insights).length === 0) return;

  const now = new Date().toISOString().split("T")[0];
  const timestamp = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });

  // Ensure profile exists
  await initUserProfile(userId);

  const appendBlock = `
---
*Auto-update — ${timestamp}*

${insights.summary ? `### Conversation Summary\n${insights.summary}\n` : ""}
${insights.topics?.length ? `### Topics Detected\n${insights.topics.map(t => `- ${t}`).join("\n")}\n` : ""}
${insights.styleObservation ? `### Communication Style\n${insights.styleObservation}\n` : ""}
${insights.professionalContext ? `### Professional Context Update\n${insights.professionalContext}\n` : ""}
`;

  await appendRootNote(profilePath(userId), appendBlock);

  // Update Prisma metadata
  const updates = {};
  if (insights.topics?.length) {
    updates.interestsJson = JSON.stringify(insights.topics);
  }
  if (insights.responseStyle) {
    updates.responseStyle = insights.responseStyle;
  }
  if (insights.personality) {
    updates.personalityJson = JSON.stringify(insights.personality);
  }

  if (Object.keys(updates).length > 0) {
    await prisma.userProfile.upsert({
      where: { userId },
      create: { userId, chatLanguage: "fr", responseStyle: "balanced", ...updates },
      update: { ...updates, lastUpdatedAt: new Date() }
    });
  }
}

/**
 * Récupère le profil Prisma structuré (pour les agents IA).
 */
export async function getUserProfileData(userId) {
  try {
    return await prisma.userProfile.findUnique({ where: { userId } });
  } catch {
    return null;
  }
}
