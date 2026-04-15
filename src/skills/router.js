/**
 * Skill Router — Sélectionne le skill le plus pertinent pour une demande utilisateur.
 *
 * Deux modes :
 * 1. LLM-based : envoie la demande + catalogue au LLM pour sélection précise
 * 2. Fallback regex : sélection basée sur les mots-clés use_when / do_not_use_when
 *
 * Appelé par le dispatcher APRÈS le choix d'agent, AVANT l'exécution.
 */

import { getSkillCatalog, getSkill } from "./catalog.js";

/**
 * Prompt système pour le routeur de skills.
 */
const SKILL_ROUTER_PROMPT = `Tu es un routeur de skills pour une plateforme d'agents IA CRM.

Ta mission :
- analyser la demande utilisateur
- choisir le skill le plus pertinent parmi la liste fournie
- ne sélectionner qu'un seul skill principal sauf si la demande exige clairement une combinaison
- signaler les informations manquantes
- ne jamais inventer un skill absent de la liste

Règles de sélection :
- base-toi d'abord sur use_when
- élimine les skills incompatibles via do_not_use_when
- privilégie le skill le plus spécifique plutôt que le plus générique
- si aucun skill ne correspond bien, retourne "no_skill"
- si plusieurs skills sont possibles, choisis celui qui porte la valeur principale de la demande

Réponds UNIQUEMENT en JSON valide avec cette structure exacte :
{
  "intent": "description courte de l'intent detecte",
  "chosen_skill": "skill_id ou no_skill",
  "secondary_skills": [],
  "confidence": 0.0,
  "reason": "explication courte du choix",
  "missing_inputs": []
}`;

/**
 * Build the skill catalog block for the router prompt.
 */
function buildCatalogBlock(catalog) {
  return catalog
    .map(
      (skill) =>
        `- id: ${skill.id}\n  name: ${skill.name}\n  use_when:\n${skill.use_when.map((u) => `    - ${u}`).join("\n")}\n  do_not_use_when:\n${skill.do_not_use_when.map((u) => `    - ${u}`).join("\n")}`
    )
    .join("\n\n");
}

/**
 * Route via LLM — precise skill selection.
 */
async function routeWithLLM(provider, userMessage, pageContext) {
  const catalog = getSkillCatalog();
  if (catalog.length === 0) {
    return { chosen_skill: "no_skill", confidence: 0, reason: "No skills loaded" };
  }

  const catalogBlock = buildCatalogBlock(catalog);
  const contextInfo = pageContext?.type
    ? `\nContexte page Sellsy : ${pageContext.type}${pageContext.entityName ? ` — ${pageContext.entityName}` : ""}`
    : "";

  const systemPrompt = `${SKILL_ROUTER_PROMPT}\n\nCATALOGUE DES SKILLS :\n${catalogBlock}${contextInfo}`;

  try {
    const result = await provider.classify(systemPrompt, userMessage);

    if (result.parseError) {
      return fallbackRoute(userMessage);
    }

    return {
      intent: result.intent || "",
      chosen_skill: result.chosen_skill || "no_skill",
      secondary_skills: result.secondary_skills || [],
      confidence: result.confidence || 0.5,
      reason: result.reason || "",
      missing_inputs: result.missing_inputs || []
    };
  } catch (error) {
    console.error("[SkillRouter] LLM routing failed:", error.message);
    return fallbackRoute(userMessage);
  }
}

/**
 * Fallback regex-based routing.
 * Scores each skill based on keyword matches in use_when / do_not_use_when.
 */
function fallbackRoute(userMessage) {
  const catalog = getSkillCatalog();
  const msg = userMessage.toLowerCase();

  let bestSkill = null;
  let bestScore = 0;

  for (const skill of catalog) {
    // Check do_not_use_when exclusions first
    const excluded = skill.do_not_use_when.some((rule) => {
      const keywords = rule.toLowerCase().split(/[\s,→()]+/).filter((w) => w.length > 3);
      return keywords.filter((kw) => msg.includes(kw)).length >= 2;
    });
    if (excluded) continue;

    // Score use_when matches
    let score = 0;
    for (const rule of skill.use_when) {
      const keywords = rule.toLowerCase().split(/[\s,→()]+/).filter((w) => w.length > 3);
      const matches = keywords.filter((kw) => msg.includes(kw)).length;
      score += matches;
    }

    // Boost by keyword detection
    const keywordMap = {
      sales_writer_v1: /\b(r[ée]dig|[eé]cri[st]|mail|email|relance|message|linkedin|reformul|brouillon)\b/,
      sales_analysis_v1: /\b(brief|synth[eè]se|analyse.*(client|compte)|potentiel|pr[ée]par.*(rdv|rendez)|r[ée]sum[ée])\b/,
      sales_strategy_v1: /\b(strat[ée]gi|priorit|recommand|next.?action|plan.?d.?action|prioris|d[ée]bloqu|quoi.?faire)\b/,
      pipeline_diagnostic_v1: /\b(pipeline|stagnant|risque|oubli[ée]|devis.*(non|pas).*(relanc)|diagnostic|audit|[ée]tat.*(des|du))\b/,
      crm_action_v1: /\b(cr[ée]er|ajouter|modifier|mettre.*jour|note|t[aâ]che|changer|aller.*sur|ouvre|montre.?moi|navigu)\b/
    };

    if (keywordMap[skill.id] && keywordMap[skill.id].test(msg)) {
      score += 5;
    }

    if (score > bestScore) {
      bestScore = score;
      bestSkill = skill;
    }
  }

  if (!bestSkill || bestScore === 0) {
    return {
      intent: "unknown",
      chosen_skill: "no_skill",
      secondary_skills: [],
      confidence: 0,
      reason: "Fallback: aucun skill ne correspond",
      missing_inputs: []
    };
  }

  return {
    intent: bestSkill.name,
    chosen_skill: bestSkill.id,
    secondary_skills: [],
    confidence: Math.min(0.8, bestScore * 0.15),
    reason: `Fallback regex: ${bestSkill.name} (score: ${bestScore})`,
    missing_inputs: []
  };
}

/**
 * Main entry point — select the best skill for a user message.
 *
 * @param {Object} provider - LLM provider instance
 * @param {string} userMessage - User's message
 * @param {Object} pageContext - Current Sellsy page context
 * @param {Object} options
 * @param {boolean} options.useLLM - Use LLM routing (default: true)
 * @returns {Object} { chosen_skill, skill, secondary_skills, confidence, reason, missing_inputs }
 */
export async function selectSkill(provider, userMessage, pageContext, { useLLM = true } = {}) {
  let routingResult;

  if (useLLM && provider) {
    routingResult = await routeWithLLM(provider, userMessage, pageContext);
  } else {
    routingResult = fallbackRoute(userMessage);
  }

  // Resolve the full skill object
  const skill = routingResult.chosen_skill !== "no_skill"
    ? getSkill(routingResult.chosen_skill)
    : null;

  // Resolve secondary skills
  const secondarySkills = (routingResult.secondary_skills || [])
    .map((id) => getSkill(id))
    .filter(Boolean);

  return {
    ...routingResult,
    skill,
    secondarySkills
  };
}
