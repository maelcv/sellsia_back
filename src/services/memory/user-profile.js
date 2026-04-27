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
 * Met à jour les sections structurées in-place plutôt que d'appender.
 * @param {number} userId
 * @param {object} insights — { summary, topics, styleObservation, professionalContext, inferredRole, inferredIndustry, newInterests, responseStyle, personality, preferredLanguage }
 */
export async function updateUserProfile(userId, insights = {}) {
  if (!insights || Object.keys(insights).length === 0) return;

  const now = new Date().toISOString().split("T")[0];
  const timestamp = new Date().toLocaleString("fr-FR", { timeZone: "Europe/Paris" });

  await initUserProfile(userId);

  let profile = await getUserProfile(userId);
  if (!profile) return;

  // ── Update frontmatter lastUpdated ──
  profile = profile.replace(/^lastUpdated: .*$/m, `lastUpdated: ${now}`);

  // ── Update Communication Preferences ──
  if (insights.responseStyle) {
    profile = profile.replace(
      /^(- Response style:).*/m,
      `$1 ${insights.responseStyle}`
    );
  }
  if (insights.preferredLanguage) {
    profile = profile.replace(
      /^(- Preferred language:).*/m,
      `$1 ${insights.preferredLanguage}`
    );
  }
  if (insights.personality) {
    const tone = insights.personality.formal ? "formal" : "casual";
    profile = profile.replace(/^(- Tone:).*/m, `$1 ${tone}`);
  }

  // ── Update Detected Interests (merge new interests) ──
  const newInterests = [
    ...(insights.topics || []),
    ...(insights.newInterests || [])
  ].filter(Boolean);
  if (newInterests.length > 0) {
    const interestLines = newInterests.map(t => `- ${t}`).join("\n");
    if (profile.includes("_No interests detected yet.")) {
      profile = profile.replace(
        /_No interests detected yet\. Will be updated as conversations progress\._/,
        interestLines
      );
    } else {
      // Append new interests under the section (avoiding duplicates)
      const existing = (profile.match(/^- (.+)$/gm) || []).map(l => l.slice(2).toLowerCase());
      const toAdd = newInterests.filter(i => !existing.includes(i.toLowerCase()));
      if (toAdd.length > 0) {
        profile = profile.replace(
          /(## Detected Interests\n)([\s\S]*?)(\n## )/,
          (_, header, body, next) => `${header}${body.trimEnd()}\n${toAdd.map(t => `- ${t}`).join("\n")}\n${next}`
        );
      }
    }
  }

  // ── Update Professional Context ──
  if (insights.inferredRole) {
    profile = profile.replace(
      /^(- Role:).*/m,
      `$1 ${insights.inferredRole}`
    );
  }
  if (insights.inferredIndustry || insights.professionalContext) {
    profile = profile.replace(
      /^(- Industry:).*/m,
      `$1 ${insights.inferredIndustry || insights.professionalContext}`
    );
  }

  // ── Update Interaction History — Frequent topics ──
  if (insights.topics?.length) {
    const topicStr = insights.topics.slice(0, 5).join(", ");
    profile = profile.replace(
      /^(- Frequent topics:).*/m,
      `$1 ${topicStr}`
    );
  }

  // ── Append observation block at bottom of Agent Notes ──
  const observationBlock = [
    insights.summary ? `**${timestamp}** — ${insights.summary}` : null,
    insights.styleObservation ? `Style: ${insights.styleObservation}` : null,
  ].filter(Boolean).join("  \n");

  if (observationBlock) {
    if (profile.includes("_Observations will be added automatically after each conversation._")) {
      profile = profile.replace(
        /_Observations will be added automatically after each conversation\._/,
        observationBlock
      );
    } else {
      profile = profile.trimEnd() + `\n- ${observationBlock}\n`;
    }
  }

  await writeRootNote(profilePath(userId), profile);

  // ── Sync Prisma metadata ──
  const updates = {};
  if (insights.topics?.length) updates.interestsJson = JSON.stringify(insights.topics);
  if (insights.responseStyle) updates.responseStyle = insights.responseStyle;
  if (insights.personality) updates.personalityJson = JSON.stringify(insights.personality);
  if (insights.preferredLanguage) updates.chatLanguage = insights.preferredLanguage;

  if (Object.keys(updates).length > 0) {
    await prisma.userProfile.upsert({
      where: { userId },
      create: { userId, chatLanguage: insights.preferredLanguage || "fr", responseStyle: "balanced", ...updates },
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
