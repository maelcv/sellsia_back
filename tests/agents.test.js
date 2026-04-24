/**
 * agents.test.js
 *
 * Tests unitaires et fonctionnels pour :
 *   - CRUD des agents (global et workspace-scoped)
 *   - CRUD des sous-agents / outils
 *   - Isolation workspace (pas de fuite de données entre workspaces)
 *   - Sécurité : endpoints sans auth → 401
 */

const API_URL = process.env.API_URL || "http://localhost:3000";

// ── Test helpers ─────────────────────────────────────────────────────────────

async function post(path, body, token) {
  return fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function get(path, token) {
  return fetch(`${API_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function patch(path, body, token) {
  return fetch(`${API_URL}${path}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function del(path, token) {
  return fetch(`${API_URL}${path}`, {
    method: "DELETE",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

// Login helper — returns token or null
async function loginAs(email, password) {
  const res = await post("/api/auth/login", { email, password });
  if (!res.ok) return null;
  const data = await res.json();
  return data.token || null;
}

// ── Security: Unauthenticated access ─────────────────────────────────────────

describe("Security — Unauthenticated access", () => {
  test("GET /api/sub-agents without auth → 401", async () => {
    const res = await get("/api/sub-agents");
    expect(res.status).toBe(401);
  });

  test("POST /api/sub-agents without auth → 401", async () => {
    const res = await post("/api/sub-agents", { name: "test", description: "test test test" });
    expect(res.status).toBe(401);
  });

  test("GET /api/agents/catalog without auth → 401", async () => {
    const res = await get("/api/agents/catalog");
    expect(res.status).toBe(401);
  });

  test("POST /api/agents-management without auth → 401", async () => {
    const res = await post("/api/agents-management", {
      name: "Test",
      description: "Test agent description",
    });
    expect(res.status).toBe(401);
  });

  test("DELETE /api/agents-management/any-id without auth → 401", async () => {
    const res = await del("/api/agents-management/agent-commercial");
    expect(res.status).toBe(401);
  });
});

// ── Sub-agents API: route existence ──────────────────────────────────────────

describe("Sub-agents routes — existence", () => {
  test("GET /api/sub-agents/capabilities exists (returns 401 without auth)", async () => {
    const res = await get("/api/sub-agents/capabilities");
    // capabilities is open to authenticated users; without token → 401
    expect(res.status).not.toBe(404);
  });
});

// ── Validation: input sanitization ───────────────────────────────────────────

describe("Input Validation", () => {
  // These tests need a valid auth token from a test admin account
  // In CI, set TEST_ADMIN_EMAIL / TEST_ADMIN_PASSWORD env vars
  const adminEmail = process.env.TEST_ADMIN_EMAIL;
  const adminPassword = process.env.TEST_ADMIN_PASSWORD;

  // Skip if no credentials provided
  const conditionalTest = adminEmail && adminPassword ? test : test.skip;

  let adminToken = null;

  beforeAll(async () => {
    if (adminEmail && adminPassword) {
      adminToken = await loginAs(adminEmail, adminPassword);
    }
  });

  conditionalTest("POST /api/agents-management with too-short name → 400", async () => {
    const res = await post(
      "/api/agents-management",
      { name: "X", description: "short desc but ok" },
      adminToken
    );
    expect(res.status).toBe(400);
  });

  conditionalTest("POST /api/agents-management with too-short description → 400", async () => {
    const res = await post(
      "/api/agents-management",
      { name: "Valid Name", description: "short" },
      adminToken
    );
    expect(res.status).toBe(400);
  });

  conditionalTest("POST /api/sub-agents with invalid capability key → silently filtered", async () => {
    const res = await post(
      "/api/sub-agents",
      {
        name: "Test Sub Agent",
        description: "A test sub-agent for validation",
        subAgentType: "sub_agent",
        capabilities: ["crm_read", "__proto__", "eval_injection"],
      },
      adminToken
    );
    if (res.status === 201 || res.status === 200) {
      const data = await res.json();
      // Injected capability keys should be stripped
      expect(data.subAgent?.capabilities ?? []).not.toContain("__proto__");
      expect(data.subAgent?.capabilities ?? []).not.toContain("eval_injection");
      // Valid capability should survive
      expect(data.subAgent?.capabilities ?? []).toContain("crm_read");
      // Cleanup
      if (data.subAgent?.id) {
        await del(`/api/sub-agents/${data.subAgent.id}`, adminToken);
      }
    } else {
      // If creation failed for other reasons, just check it's not a 500
      expect(res.status).not.toBe(500);
    }
  });

  conditionalTest("POST /api/agents-management with valid data → 201", async () => {
    const res = await post(
      "/api/agents-management",
      {
        name: "Test Agent Automated",
        description: "Agent créé automatiquement pour les tests",
        systemPrompt: "Tu es un agent de test.",
        allowedTools: ["web_search"],
      },
      adminToken
    );
    expect([200, 201]).toContain(res.status);
    const data = await res.json();
    expect(data.agent?.id).toBeDefined();

    // Cleanup
    if (data.agent?.id) {
      const delRes = await del(`/api/agents-management/${data.agent.id}`, adminToken);
      expect([200, 204]).toContain(delRes.status);
    }
  });
});

// ── Workspace isolation ───────────────────────────────────────────────────────

describe("Workspace isolation", () => {
  const clientAEmail = process.env.TEST_CLIENT_A_EMAIL;
  const clientAPassword = process.env.TEST_CLIENT_A_PASSWORD;
  const clientBEmail = process.env.TEST_CLIENT_B_EMAIL;
  const clientBPassword = process.env.TEST_CLIENT_B_PASSWORD;

  const conditionalTest =
    clientAEmail && clientAPassword && clientBEmail && clientBPassword
      ? test
      : test.skip;

  let tokenA = null;
  let tokenB = null;
  let agentIdA = null;

  beforeAll(async () => {
    if (clientAEmail) tokenA = await loginAs(clientAEmail, clientAPassword);
    if (clientBEmail) tokenB = await loginAs(clientBEmail, clientBPassword);
  });

  conditionalTest("Client A can create a workspace agent", async () => {
    const res = await post(
      "/api/agents/workspace",
      { name: "Agent A Test", description: "Agent exclusif au workspace A" },
      tokenA
    );
    expect([200, 201]).toContain(res.status);
    const data = await res.json();
    agentIdA = data.agent?.id;
    expect(agentIdA).toBeDefined();
  });

  conditionalTest("Client B cannot read Client A's workspace agent via catalog", async () => {
    if (!agentIdA) return;
    const res = await get("/api/agents/catalog", tokenB);
    expect(res.ok).toBe(true);
    const data = await res.json();
    const ids = (data.agents || []).map((a) => a.id);
    // Agent A should NOT appear in Client B's catalog
    expect(ids).not.toContain(agentIdA);
  });

  afterAll(async () => {
    // Cleanup agent A
    if (agentIdA && tokenA) {
      await del(`/api/agents/workspace/${agentIdA}`, tokenA);
    }
  });
});

// ── Sub-agents: capabilities endpoint ────────────────────────────────────────

describe("Sub-agents capabilities", () => {
  const adminEmail = process.env.TEST_ADMIN_EMAIL;
  const adminPassword = process.env.TEST_ADMIN_PASSWORD;
  const conditionalTest = adminEmail && adminPassword ? test : test.skip;
  let token = null;

  beforeAll(async () => {
    if (adminEmail && adminPassword) {
      token = await loginAs(adminEmail, adminPassword);
    }
  });

  conditionalTest("GET /api/sub-agents/capabilities returns array with category/key/label", async () => {
    const res = await get("/api/sub-agents/capabilities", token);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.capabilities)).toBe(true);
    expect(data.capabilities.length).toBeGreaterThan(0);

    const cap = data.capabilities[0];
    expect(cap).toHaveProperty("key");
    expect(cap).toHaveProperty("label");
    expect(cap).toHaveProperty("category");
  });

  conditionalTest("GET /api/sub-agents returns array (may be empty)", async () => {
    const res = await get("/api/sub-agents", token);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(Array.isArray(data.subAgents)).toBe(true);
  });
});

// ── Admin-only endpoints ──────────────────────────────────────────────────────

describe("Role enforcement", () => {
  const clientEmail = process.env.TEST_CLIENT_A_EMAIL;
  const clientPassword = process.env.TEST_CLIENT_A_PASSWORD;
  const conditionalTest = clientEmail && clientPassword ? test : test.skip;
  let clientToken = null;

  beforeAll(async () => {
    if (clientEmail && clientPassword) {
      clientToken = await loginAs(clientEmail, clientPassword);
    }
  });

  conditionalTest("Non-admin cannot POST /api/agents-management (seed or create global)", async () => {
    const res = await post(
      "/api/agents-management",
      { name: "Fake Admin Agent", description: "Should be blocked for non-admins" },
      clientToken
    );
    expect([401, 403]).toContain(res.status);
  });

  conditionalTest("Non-admin cannot DELETE /api/agents-management/:id", async () => {
    const res = await del("/api/agents-management/agent-commercial", clientToken);
    expect([401, 403]).toContain(res.status);
  });
});
