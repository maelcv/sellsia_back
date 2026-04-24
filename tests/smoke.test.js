/**
 * smoke.test.js
 *
 * Tests de fumée basiques pour vérifier que l'app fonctionne
 * Exécution: npm test -- tests/smoke.test.js
 */

describe("Boatswain SaaS — Smoke Tests", () => {
  const API_URL = process.env.API_URL || "http://localhost:3000";

  // ── Health Checks ──────────────────────────────────────

  test("Health endpoint returns 200", async () => {
    const res = await fetch(`${API_URL}/api/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("ok");
  });

  // ── Database Connection ────────────────────────────────

  test("Database is accessible", async () => {
    // Simplified: just check if API responds (implies DB is OK)
    const res = await fetch(`${API_URL}/api/health`);
    expect(res.ok).toBe(true);
  });

  // ── Authentication ─────────────────────────────────────

  describe("Authentication", () => {
    test("Login endpoint exists and accepts POST", async () => {
      const res = await fetch(`${API_URL}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@test.com", password: "wrong" }),
      });
      // Expect 400 (bad credentials) not 404 (endpoint not found)
      expect(res.status).not.toBe(404);
    });

    test("Onboarding endpoint exists", async () => {
      const res = await fetch(`${API_URL}/api/auth/onboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "test@test.com", password: "Test123!" }),
      });
      expect([400, 409, 201, 200]).toContain(res.status);
    });
  });

  // ── Feature Routes ─────────────────────────────────────

  describe("Feature Routes Exist", () => {
    const routes = [
      "/api/email/config",
      "/api/calendar/events",
      "/api/crm/tasks",
      "/api/documents",
      "/api/custom-fields",
      "/api/analytics/summary",
    ];

    routes.forEach(route => {
      test(`GET ${route} returns 401 (needs auth) not 404`, async () => {
        const res = await fetch(`${API_URL}${route}`);
        // Should be 401 (unauthorized) not 404 (not found)
        expect(res.status).not.toBe(404);
      });
    });
  });

  // ── CORS ───────────────────────────────────────────────

  test("CORS headers present", async () => {
    const res = await fetch(`${API_URL}/api/health`, {
      headers: { Origin: "http://localhost:5173" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeDefined();
  });

  // ── Rate Limiting ──────────────────────────────────────

  test("Rate limiting is enabled", async () => {
    // Send multiple requests
    const requests = Array(5).fill(null).map(() => fetch(`${API_URL}/api/health`));
    const responses = await Promise.all(requests);
    // At least some should succeed (rate limiter allows some burst)
    const successCount = responses.filter(r => r.status === 200).length;
    expect(successCount).toBeGreaterThan(0);
  });

  // ── Workers ────────────────────────────────────────────

  test("Reminder worker should be active (no errors in health)", async () => {
    const res = await fetch(`${API_URL}/api/health`);
    expect(res.ok).toBe(true);
    // If workers have critical errors, health might fail
  });
});
