/**
 * FastMCP Server — Exposes Sellsia tools via MCP protocol for external consumption.
 *
 * This server wraps the same tools from tools.js in a proper MCP server,
 * allowing external MCP clients (Claude Desktop, Cursor, etc.) to connect.
 *
 * Usage:
 *   node ia_models/mcp/server.js
 *
 * Or programmatically:
 *   const { createMCPServer } = await import('./server.js');
 *   const server = await createMCPServer(context);
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ALL_TOOLS, executeTool } from "./tools.js";

// Resolve packages from dashboard/node_modules (where they're installed)
const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardDir = resolve(__dirname, "../../dashboard");
const require = createRequire(resolve(dashboardDir, "index.js"));

/**
 * Create an MCP server instance with all Sellsia tools.
 * @param {Object} context - Per-request context { sellsyClient, tavilyApiKey, uploadedFiles }
 * @returns {Promise<FastMCP>}
 */
export async function createMCPServer(context = {}) {
  const { FastMCP } = require("fastmcp");
  const { z } = require("zod");

  const server = new FastMCP({
    name: "sellsia-mcp",
    version: "1.0.0"
  });

  // Convert JSON Schema to Zod schemas for FastMCP
  for (const tool of ALL_TOOLS) {
    const zodShape = {};
    const props = tool.parameters.properties || {};
    const requiredFields = new Set(tool.parameters.required || []);

    for (const [key, schema] of Object.entries(props)) {
      let zodType;

      if (schema.enum) {
        zodType = z.enum(schema.enum);
      } else if (schema.type === "number") {
        zodType = z.number();
      } else {
        zodType = z.string();
      }

      if (schema.description) {
        zodType = zodType.describe(schema.description);
      }

      if (!requiredFields.has(key)) {
        zodType = zodType.optional();
      }

      zodShape[key] = zodType;
    }

    server.addTool({
      name: tool.name,
      description: tool.description,
      parameters: z.object(zodShape),
      execute: async (params) => {
        const result = await executeTool(tool.name, params, context);
        return typeof result === "string" ? result : JSON.stringify(result, null, 2);
      }
    });
  }

  return server;
}

// ── Standalone mode: run as MCP server via stdio ──

const isMainModule = process.argv[1]?.includes("mcp/server");

if (isMainModule) {
  (async () => {
    console.error("[MCP Server] Starting Sellsia MCP Server...");

    const context = {};

    if (process.env.TAVILY_API_KEY) {
      context.tavilyApiKey = process.env.TAVILY_API_KEY;
    }

    const server = await createMCPServer(context);

    server.start({
      transportType: "stdio"
    });

    console.error("[MCP Server] Sellsia MCP Server running on stdio");
  })();
}
