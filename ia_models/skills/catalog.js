/**
 * Skills Catalog — Charge et indexe tous les skills depuis /skills/
 *
 * Chaque skill est un dossier contenant un SKILL.md avec :
 * - Frontmatter YAML (id, name, version, category, description, business_goal)
 * - Corps Markdown (routing, execution rules)
 *
 * Le catalogue expose :
 * - loadAllSkills()    → charge tous les skills au démarrage
 * - getSkill(id)       → récupère un skill par ID
 * - getSkillCatalog()  → retourne le catalogue de routage (id, name, use_when, do_not_use_when)
 * - formatSkillForInjection(skill) → génère le bloc [ACTIVE SKILL] pour le system prompt
 */

import { readFileSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── In-memory skill store ──
const skills = new Map();

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Simple parser — no external dependency needed.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const yamlBlock = match[1];
  const body = match[2];
  const meta = {};

  let currentKey = null;
  let currentValue = "";

  for (const line of yamlBlock.split("\n")) {
    // Multi-line value continuation (indented)
    if (currentKey && /^\s{2,}/.test(line)) {
      currentValue += " " + line.trim();
      continue;
    }

    // Save previous key if exists
    if (currentKey) {
      meta[currentKey] = currentValue.trim();
      currentKey = null;
      currentValue = "";
    }

    // New key: value pair
    const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      const val = kvMatch[2].trim();
      // YAML multi-line indicator (> or |)
      if (val === ">" || val === "|") {
        currentValue = "";
      } else {
        currentValue = val;
      }
    }
  }

  // Flush last key
  if (currentKey) {
    meta[currentKey] = currentValue.trim();
  }

  return { meta, body };
}

/**
 * Extract a markdown section's list items.
 * Looks for "### sectionName" and collects "- item" lines until next ### or ##.
 */
function extractListSection(body, sectionName) {
  const regex = new RegExp(
    `###\\s+${sectionName}\\s*\\n([\\s\\S]*?)(?=\\n###|\\n##[^#]|$)`,
    "i"
  );
  const match = body.match(regex);
  if (!match) return [];

  return match[1]
    .split("\n")
    .filter((line) => line.trim().startsWith("-"))
    .map((line) => line.replace(/^[\s]*-\s*/, "").trim())
    .filter(Boolean);
}

/**
 * Extract full text of a section (everything between ### heading and next heading).
 */
function extractSection(body, sectionName) {
  const regex = new RegExp(
    `###\\s+${sectionName}\\s*\\n([\\s\\S]*?)(?=\\n###|\\n##[^#]|$)`,
    "i"
  );
  const match = body.match(regex);
  return match ? match[1].trim() : "";
}

/**
 * Parse a single SKILL.md file into a structured skill object.
 */
function parseSkillFile(filePath) {
  const raw = readFileSync(filePath, "utf-8");
  const { meta, body } = parseFrontmatter(raw);

  return {
    // Identity
    id: meta.id || "unknown",
    name: meta.name || "Unknown Skill",
    version: meta.version || "1.0.0",
    category: meta.category || "general",
    description: meta.description || "",
    business_goal: meta.business_goal || "",

    // Routing
    use_when: extractListSection(body, "use_when"),
    do_not_use_when: extractListSection(body, "do_not_use_when"),
    escalation_rules: extractListSection(body, "escalation_rules"),

    // Execution (raw sections for injection)
    reasoning_rules: extractListSection(body, "reasoning_rules"),
    style_rules: extractListSection(body, "style_rules"),
    decision_rules: extractListSection(body, "decision_rules"),
    missing_data_strategy: extractListSection(body, "missing_data_strategy"),
    output_contract: extractSection(body, "output_contract"),
    examples: extractSection(body, "examples"),

    // Raw body for full injection if needed
    _rawBody: body,
    _filePath: filePath
  };
}

/**
 * Load all skills from the /skills directory.
 */
export function loadAllSkills() {
  skills.clear();

  const skillDirs = readdirSync(__dirname).filter((entry) => {
    const fullPath = join(__dirname, entry);
    return statSync(fullPath).isDirectory() && entry !== "node_modules";
  });

  for (const dir of skillDirs) {
    const skillFile = join(__dirname, dir, "SKILL.md");
    try {
      statSync(skillFile);
    } catch {
      continue; // No SKILL.md in this directory
    }

    try {
      const skill = parseSkillFile(skillFile);
      skills.set(skill.id, skill);
      console.log(`[SkillCatalog] Loaded: ${skill.id} (${skill.name} v${skill.version})`);
    } catch (err) {
      console.warn(`[SkillCatalog] Failed to load ${dir}/SKILL.md:`, err.message);
    }
  }

  console.log(`[SkillCatalog] ${skills.size} skills loaded.`);
  return skills;
}

/**
 * Get a skill by ID.
 */
export function getSkill(skillId) {
  return skills.get(skillId) || null;
}

/**
 * Get all loaded skills.
 */
export function getAllSkills() {
  return [...skills.values()];
}

/**
 * Get the routing catalog for the skill router.
 * Lightweight format: only what the router needs to decide.
 */
export function getSkillCatalog() {
  return [...skills.values()].map((skill) => ({
    id: skill.id,
    name: skill.name,
    category: skill.category,
    description: skill.description,
    use_when: skill.use_when,
    do_not_use_when: skill.do_not_use_when
  }));
}

/**
 * Format a skill for injection into an agent's system prompt.
 * Generates the [ACTIVE SKILL] block.
 */
export function formatSkillForInjection(skill) {
  if (!skill) return "";

  let block = `\n\n--- ACTIVE SKILL ---
ID: ${skill.id}
NAME: ${skill.name}
VERSION: ${skill.version}

PURPOSE:
${skill.description}`;

  if (skill.business_goal) {
    block += `\n\nBUSINESS GOAL:
${skill.business_goal}`;
  }

  if (skill.reasoning_rules.length > 0) {
    block += `\n\nREASONING RULES:
${skill.reasoning_rules.map((r) => `- ${r}`).join("\n")}`;
  }

  if (skill.style_rules.length > 0) {
    block += `\n\nSTYLE RULES:
${skill.style_rules.map((r) => `- ${r}`).join("\n")}`;
  }

  if (skill.decision_rules.length > 0) {
    block += `\n\nDECISION RULES:
${skill.decision_rules.map((r) => `- ${r}`).join("\n")}`;
  }

  if (skill.missing_data_strategy.length > 0) {
    block += `\n\nMISSING DATA STRATEGY:
${skill.missing_data_strategy.map((r) => `- ${r}`).join("\n")}`;
  }

  if (skill.output_contract) {
    block += `\n\nOUTPUT CONTRACT:
${skill.output_contract}`;
  }

  if (skill.escalation_rules.length > 0) {
    block += `\n\nESCALATION:
${skill.escalation_rules.map((r) => `- ${r}`).join("\n")}`;
  }

  block += `\n--- FIN SKILL ---`;

  return block;
}

// ── Auto-load on import ──
loadAllSkills();
