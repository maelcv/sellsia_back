import express from "express";
import { z } from "zod";
import { prisma, logAudit } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";

const router = express.Router();

const requestSchema = z.object({
  agentId: z.string().min(3).max(64),
  reason: z.string().min(10).max(500)
});

const reviewSchema = z.object({
  status: z.enum(["approved", "rejected"]),
  reviewerNote: z.string().max(500).optional().default("")
});

const grantSchema = z.object({
  userId: z.number().int().positive(),
  agentId: z.string().min(3).max(64),
  status: z.enum(["granted", "revoked"])
});

router.post("/requests", requireAuth, requireRole("GESTIONNAIRE"), async (req, res) => {
  const parse = requestSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request payload" });
  }

  const { agentId, reason } = parse.data;
  const userId = req.user.sub;

  // Verify the user exists in the database
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    return res.status(401).json({ error: "User not found. Please log out and log in again." });
  }

  const agent = await prisma.agent.findFirst({ where: { id: agentId, isActive: true } });
  if (!agent) {
    return res.status(404).json({ error: "Agent not found" });
  }

  const existingPending = await prisma.accessRequest.findFirst({
    where: { userId, agentId, status: "pending" },
    orderBy: { id: "desc" }
  });

  if (existingPending) {
    return res.status(409).json({ error: "A pending request already exists for this agent" });
  }

  try {
    await prisma.accessRequest.create({
      data: { userId, agentId, reason }
    });
  } catch (err) {
    console.error("Failed to create access request:", err);
    if (err.code === "P2003") {
      return res.status(400).json({ error: "Invalid user or agent reference. Please log out and log in again." });
    }
    return res.status(500).json({ error: "Failed to create access request" });
  }

  await logAudit(userId, "ACCESS_REQUEST_CREATED", { agentId, reasonLength: reason.length });
  return res.status(201).json({ message: "Access request created" });
});

router.get("/requests/mine", requireAuth, requireRole("GESTIONNAIRE"), async (req, res) => {
  const requests = await prisma.$queryRaw`
    SELECT ar.id, ar.agent_id AS "agentId", a.name AS "agentName", ar.reason, ar.status::text,
           ar.reviewer_note AS "reviewerNote", ar.created_at AS "createdAt", ar.updated_at AS "updatedAt"
    FROM access_requests ar
    JOIN agents a ON a.id = ar.agent_id
    WHERE ar.user_id = ${req.user.sub}
    ORDER BY ar.created_at DESC
  `;

  return res.json({ requests });
});

router.get("/requests", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  try {
    const requests = await prisma.$queryRaw`
      SELECT ar.id, ar.user_id AS "userId", u.email AS "userEmail", u.company_name AS "companyName",
             ar.agent_id AS "agentId", a.name AS "agentName", ar.reason, ar.status::text,
             ar.reviewer_note AS "reviewerNote", ar.created_at AS "createdAt", ar.updated_at AS "updatedAt"
      FROM access_requests ar
      LEFT JOIN users u ON u.id = ar.user_id
      LEFT JOIN agents a ON a.id = ar.agent_id
      ORDER BY (ar.status = 'pending') DESC, ar.created_at DESC
    `;

    return res.json({ requests });
  } catch (err) {
    console.error("Failed to fetch access requests:", err);
    return res.status(500).json({ error: "Failed to fetch access requests" });
  }
});

router.patch("/requests/:id", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const requestId = Number(req.params.id);
  if (!Number.isInteger(requestId) || requestId <= 0) {
    return res.status(400).json({ error: "Invalid request id" });
  }

  const parse = reviewSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request payload" });
  }

  const { status, reviewerNote } = parse.data;
  const accessRequest = await prisma.accessRequest.findUnique({
    where: { id: requestId },
    select: { id: true, userId: true, agentId: true, status: true }
  });

  if (!accessRequest) {
    return res.status(404).json({ error: "Request not found" });
  }

  if (accessRequest.status !== "pending") {
    return res.status(409).json({ error: "Only pending requests can be reviewed" });
  }

  await prisma.$transaction(async (tx) => {
    await tx.accessRequest.update({
      where: { id: requestId },
      data: {
        status,
        reviewerNote,
        reviewedBy: req.user.sub,
        updatedAt: new Date()
      }
    });

    if (status === "approved") {
      await tx.userAgentAccess.upsert({
        where: {
          userId_agentId: {
            userId: accessRequest.userId,
            agentId: accessRequest.agentId
          }
        },
        update: { status: "granted", updatedAt: new Date() },
        create: {
          userId: accessRequest.userId,
          agentId: accessRequest.agentId,
          status: "granted"
        }
      });
    }
  });

  await logAudit(req.user.sub, "ACCESS_REQUEST_REVIEWED", { requestId, status });
  return res.json({ message: `Request ${status}` });
});

router.get("/users-with-access", requireAuth, requireRole("ADMIN"), async (_req, res) => {
  const users = await prisma.user.findMany({
    where: { role: "GESTIONNAIRE" },
    select: { id: true, email: true, role: true, companyName: true },
    orderBy: { email: "asc" }
  });

  const rows = await prisma.$queryRaw`
    SELECT uaa.user_id AS "userId", uaa.agent_id AS "agentId", uaa.status::text, a.name AS "agentName"
    FROM user_agent_access uaa
    JOIN agents a ON a.id = uaa.agent_id
  `;

  const accessByUser = rows.reduce((acc, row) => {
    if (!acc[row.userId]) acc[row.userId] = [];
    acc[row.userId].push(row);
    return acc;
  }, {});

  return res.json({
    users: users.map((user) => ({
      ...user,
      access: accessByUser[user.id] || []
    }))
  });
});

router.put("/grant", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const parse = grantSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request payload" });
  }

  const { userId, agentId, status } = parse.data;
  const client = await prisma.user.findFirst({ where: { id: userId, role: "GESTIONNAIRE" } });
  if (!client) {
    return res.status(404).json({ error: "Client user not found" });
  }

  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) {
    return res.status(404).json({ error: "Agent not found" });
  }

  await prisma.userAgentAccess.upsert({
    where: {
      userId_agentId: { userId, agentId }
    },
    update: { status, updatedAt: new Date() },
    create: { userId, agentId, status }
  });

  await logAudit(req.user.sub, "AGENT_ACCESS_UPDATED", { userId, agentId, status });
  return res.json({ message: "Access updated" });
});

export default router;
