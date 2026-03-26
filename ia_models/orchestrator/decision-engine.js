/**
 * Decision Engine — Intelligent sub-agent selection
 *
 * Uses a meta-prompt to decide which sub-agents are needed for a user's request.
 * Avoids running all sub-agents systematically.
 */

const DECISION_PROMPT = `You are an intelligent request analyzer for a multi-agent system.
Analyze the user's request and determine which specialized sub-agents should be consulted.

User request: "{userMessage}"
Conversation history summary: {historyContext}

Available sub-agents:
- file: Read and analyze uploaded documents (PDF, Word, CSV, Excel, images, etc.) - PRIORITY if files are uploaded
- knowledge: Search internal knowledge base and conversation cache for company information
- crm_search: Look up contacts, companies, opportunities, activities in CRM (read-only)
- crm_action: Create/update/delete CRM records (requires user confirmation)
- web_search: Search the internet for information
- web_scrape: Analyze content from a specific URL
- task_list: List and analyze user's tasks, events, reminders
- task_creator: Create tasks, events, or reminders (requires user confirmation)
- image_reader: Analyze images and extract visual information (vision model)
- admin_platform: Query platform-wide analytics (admin only)

Decision criteria:
1. **Files:** If user uploaded files, ALWAYS include file sub-agent (highest priority)
2. **CRM:** Use crm_search for questions about contacts/companies/deals
3. **CRM write:** Use crm_action ONLY if user explicitly wants to create/modify/delete CRM objects
4. **Knowledge:** Use knowledge sub-agent for company-internal information, policies, procedures
5. **Web:** Use web_search/web_scrape only if information cannot be found internally
6. **Tasks:** Use task_list if user mentions calendar/tasks/reminders
7. **Tasks create:** Use task_creator if user wants to create/schedule tasks
8. **Images:** Use image_reader if user provided images to analyze
9. **Admin:** Use admin_platform only for platform metrics (admin users only)

Respond in valid JSON format only:
{
  "agents": ["agent1", "agent2"],
  "reasoning": "Brief explanation of why these agents were selected",
  "confidence": 0.0 to 1.0,
  "requiresConfirmation": false
}

Example responses:
- User: "Show me my contacts" → {"agents": ["crm_search"], ...}
- User: "Create a contact John Smith" → {"agents": ["crm_action"], "requiresConfirmation": true, ...}
- User: "What are my tasks this week?" → {"agents": ["task_list"], ...}
- User: "Search Google for AI news" → {"agents": ["web_search"], ...}
- User: "Analyze this PDF I uploaded" → {"agents": ["file"], ...}`;

/**
 * Decide which sub-agents are needed based on user's message
 * @param {string} userMessage - The user's request
 * @param {Array} conversationHistory - Previous messages for context
 * @param {Object} provider - LLM provider instance
 * @param {Object} toolContext - { uploadedFiles, isAdmin, ... }
 * @returns {Promise<{ agents: string[], reasoning: string, confidence: number, requiresConfirmation: boolean }>}
 */
export async function decideSubAgents(userMessage, conversationHistory = [], provider, toolContext = {}) {
  try {
    // Build conversation history summary
    const historyContext = buildHistorySummary(conversationHistory);

    // Fill in the prompt template
    const systemPrompt = DECISION_PROMPT.replace("{userMessage}", userMessage).replace(
      "{historyContext}",
      historyContext
    );

    // Call LLM with low thinking mode for speed
    const result = await provider.chat({
      systemPrompt:
        "You are a JSON-only response engine. ONLY output valid JSON, nothing else. Do not add markdown backticks or explanations.",
      messages: [{ role: "user", content: systemPrompt }],
      temperature: 0.3, // Lower temperature for deterministic decisions
      maxTokens: 512,
    });

    // Parse the JSON response
    let decision = parseJSONResponse(result.content);

    // Validate and filter agents based on context
    decision.agents = filterAgentsByContext(decision.agents || [], toolContext);

    // Ensure confidence is a number
    decision.confidence = typeof decision.confidence === "number" ? decision.confidence : 0.7;

    return decision;
  } catch (err) {
    console.error("[DecisionEngine] Error:", err);
    // Fallback: return a safe default
    return {
      agents: ["knowledge"],
      reasoning: "Fallback: using knowledge search",
      confidence: 0.3,
      requiresConfirmation: false,
    };
  }
}

/**
 * Build a summary of conversation history for context
 */
function buildHistorySummary(history) {
  if (!Array.isArray(history) || history.length === 0) {
    return "No prior conversation history.";
  }

  const recentMessages = history.slice(-4); // Last 4 messages
  const summary = recentMessages
    .map((msg) => {
      const content = msg.content || "";
      const preview = content.length > 100 ? content.substring(0, 100) + "..." : content;
      return `${msg.role}: ${preview}`;
    })
    .join("\n");

  return summary || "No prior conversation history.";
}

/**
 * Parse JSON from LLM response (handles various formats)
 */
function parseJSONResponse(content) {
  try {
    // Try direct JSON parse
    return JSON.parse(content);
  } catch {
    // Try extracting JSON from markdown
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1]);
      } catch {
        /* continue */
      }
    }

    // Try extracting any JSON object
    const objectMatch = content.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      try {
        return JSON.parse(objectMatch[0]);
      } catch {
        /* continue */
      }
    }

    // Fallback
    return {
      agents: ["knowledge"],
      reasoning: "Could not parse decision response",
      confidence: 0.1,
      requiresConfirmation: false,
    };
  }
}

/**
 * Filter agents based on context (e.g., admin-only agents)
 */
function filterAgentsByContext(agents, toolContext) {
  const { isAdmin = false, uploadedFiles = [] } = toolContext;

  // If files uploaded, ensure file agent is first
  const hasFiles = uploadedFiles && uploadedFiles.length > 0;
  if (hasFiles && !agents.includes("file")) {
    agents.unshift("file");
  }

  // Remove admin_platform if not admin
  if (!isAdmin && agents.includes("admin_platform")) {
    agents = agents.filter((a) => a !== "admin_platform");
  }

  // Remove duplicates
  return [...new Set(agents)];
}

/**
 * Convert decision to pipeline plan
 * @param {Object} decision - Result from decideSubAgents
 * @param {string} userMessage - Original user message
 * @returns {Array} Pipeline plan for executePipeline
 */
export function convertDecisionToPlan(decision, userMessage) {
  if (!decision.agents || decision.agents.length === 0) {
    return [];
  }

  // Map agent types to plan format
  const agentTypeMap = {
    file: "file",
    knowledge: "knowledge",
    crm_search: "crm-search",
    crm_action: "crm-action",
    web_search: "web",
    web_scrape: "web",
    task_list: "task-list",
    task_creator: "task-creator",
    image_reader: "image-reader",
    admin_platform: "admin-platform",
  };

  return decision.agents.map((agentType, index) => ({
    type: agentTypeMap[agentType] || agentType,
    instruction: userMessage,
    agentId: `${agentType}-${index}`,
  }));
}
