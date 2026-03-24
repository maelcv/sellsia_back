import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { prisma, hasAnyUsers, logAudit } from "../prisma.js";
import { config } from "../config.js";
import { authRateLimit } from "../middleware/security.js";

const router = express.Router();

const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128)
});

const onboardSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  companyName: z.string().min(1).max(200).optional()
});

router.get("/bootstrap-status", async (_req, res) => {
  const has = await hasAnyUsers();
  return res.json({ hasUsers: has, needsOnboarding: !has });
});

router.post("/onboard", authRateLimit, async (req, res) => {
  const has = await hasAnyUsers();
  if (has) {
    return res.status(403).json({ error: "Platform already initialized" });
  }

  const parse = onboardSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request payload" });
  }

  const { email, password, companyName } = parse.data;
  const passwordHash = bcrypt.hashSync(password, 12);

  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase(),
      passwordHash,
      role: "admin",
      companyName: companyName || null
    }
  });

  await logAudit(user.id, "onboard", { email: email.toLowerCase() });

  const token = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, companyName: user.companyName },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );

  return res.json({
    token,
    user: { id: user.id, email: user.email, role: user.role, companyName: user.companyName, whatsappPhone: user.whatsappPhone }
  });
});

// DUMMY_HASH for timing attack prevention
const DUMMY_HASH = "$2a$12$invalidhashfortimingXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

router.post("/login", authRateLimit, async (req, res) => {
  const parse = loginSchema.safeParse(req.body);
  if (!parse.success) {
    return res.status(400).json({ error: "Invalid request payload" });
  }

  const { email, password } = parse.data;

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase() },
    select: { id: true, email: true, passwordHash: true, role: true, companyName: true, whatsappPhone: true }
  });

  const hashToCheck = user ? user.passwordHash : DUMMY_HASH;
  const isValidPassword = bcrypt.compareSync(password, hashToCheck);

  if (!user || !isValidPassword) {
    await logAudit(null, "LOGIN_FAILED", { email: email.toLowerCase() });
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign(
    { sub: user.id, email: user.email, role: user.role, companyName: user.companyName },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn }
  );

  return res.json({
    token,
    user: { id: user.id, email: user.email, role: user.role, companyName: user.companyName, whatsappPhone: user.whatsappPhone }
  });
});

export default router;
