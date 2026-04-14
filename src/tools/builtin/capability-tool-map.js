/**
 * Capability → Tool Map
 *
 * Maps every BUILTIN_CAPABILITY key (defined in /routes/sub-agents.js) to the
 * actual tool objects from the MCP tool registry (/mcp/tools.js).
 *
 * This is the ONLY file to update when:
 *   - A new capability key is added to BUILTIN_CAPABILITIES
 *   - A new tool is implemented in tools.js
 *
 * Convention:
 *   - Read capabilities get read-only tools
 *   - Write capabilities get write tools (+ their read counterparts for verification)
 *   - `ask_user` is injected into every sub-agent automatically (universal interaction tool)
 */

import { ALL_TOOLS } from "../mcp/tools.js";

// Build a name → tool object index for fine-grained resolution
const TOOL_BY_NAME = Object.fromEntries(ALL_TOOLS.map((t) => [t.name, t]));
const tool = (name) => TOOL_BY_NAME[name] ?? null;
const tools = (...names) => names.map(tool).filter(Boolean);

// ─────────────────────────────────────────────────────────────────────────────
// CAPABILITY → TOOL MAPPING
// ─────────────────────────────────────────────────────────────────────────────

export const CAPABILITY_TOOLS = {

  // ── CRM Sellsy ───────────────────────────────────────────────────────────────
  // Read: full Sellsy catalog minus write tools
  crm_sellsy_read: tools(
    "sellsy_get_company",
    "sellsy_get_contact",
    "sellsy_get_opportunity",
    "sellsy_search_companies",
    "sellsy_get_pipeline",
    "sellsy_get_activities",
    "sellsy_get_invoices",
    "sellsy_get_quote",
    "sellsy_get_opportunities",
    "ask_user",           // can ask user for a company name when not identified
    "navigate_to",        // can navigate to an entity
  ),

  // Write: modification tools + reads for pre-flight validation
  crm_sellsy_write: tools(
    "sellsy_update_opportunity",
    "sellsy_update_company",
    "sellsy_create_note",
    // reads for validation before writing
    "sellsy_get_company",
    "sellsy_get_contact",
    "sellsy_get_opportunity",
    "sellsy_search_companies",
    "ask_user",           // CRITICAL: must confirm before destructive write
  ),

  // ── CRM Salesforce ────────────────────────────────────────────────────────────
  // Placeholder: Salesforce tools not yet implemented in tools.js
  // Add salesforce_get_*, salesforce_update_* here when available.
  crm_salesforce_read: [],
  crm_salesforce_write: [],

  // ── Pipeline analysis ─────────────────────────────────────────────────────────
  pipeline_analyze: tools(
    "sellsy_get_pipeline",
    "sellsy_get_opportunities",
    "sellsy_get_activities",
    "sellsy_get_company",
  ),

  // ── Web ───────────────────────────────────────────────────────────────────────
  web_search: tools("web_search"),
  web_scrape: tools("web_scrape"),

  // ── Files ─────────────────────────────────────────────────────────────────────
  file_office_read: tools("parse_excel", "parse_word", "parse_csv"),
  file_office_write: tools("generate_report"),          // Office generation via report tool
  file_pdf_read: tools("parse_pdf"),
  file_pdf_write: tools("generate_report"),             // PDF generation via report tool
  image_ocr: [],                                        // Vision: implement parse_image when available

  // ── Knowledge ─────────────────────────────────────────────────────────────────
  // These capabilities are internal (Prisma queries, no external tool).
  // The sub-agent's system prompt drives the behavior; tools are not needed.
  knowledge_cache: [],
  knowledge_sort: [],

  // ── Communication ─────────────────────────────────────────────────────────────
  email_read: [],                   // Implement email_read tool when mail integration ready
  email_send: tools("send_email", "ask_user"),  // ask_user: confirm before send
  calendar_read: [],                // Implement calendar_read tool when calendar integration ready
  calendar_write: tools("create_calendar_event", "ask_user"),

  // ── Admin ─────────────────────────────────────────────────────────────────────
  // Admin sub-agent uses internal Prisma access — no external tools needed.
  admin_platform: [],
};

// ── Universal tools always injected ──────────────────────────────────────────
// These are available to every dynamic sub-agent regardless of capabilities.
export const UNIVERSAL_TOOLS = [
  // ask_user: lets the sub-agent surface a dilemma/ambiguity to the user
  // with suggested answers before proceeding — critical for write operations.
  tool("ask_user"),
].filter(Boolean);

/**
 * Resolve a list of capability keys to a deduplicated, ordered tool array.
 *
 * @param {string[]} capabilityKeys - e.g. ["crm_sellsy_read", "pipeline_analyze"]
 * @returns {Object[]} - Array of tool objects ready for BaseSubAgent
 */
export function resolveTools(capabilityKeys = []) {
  const seen = new Set();
  const result = [];

  // Always start with universal tools
  for (const t of UNIVERSAL_TOOLS) {
    if (!seen.has(t.name)) {
      seen.add(t.name);
      result.push(t);
    }
  }

  // Then add tools mapped from capabilities
  for (const key of capabilityKeys) {
    const mapped = CAPABILITY_TOOLS[key] ?? [];
    for (const t of mapped) {
      if (!seen.has(t.name)) {
        seen.add(t.name);
        result.push(t);
      }
    }
  }

  return result;
}
