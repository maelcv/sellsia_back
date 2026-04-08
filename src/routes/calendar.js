/**
 * routes/calendar.js
 *
 * CRUD événements calendrier + flux iCal public.
 * Feature flag : calendar
 */

import { Router } from "express";
import { z } from "zod";
import jwt from "jsonwebtoken";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspaceContext } from "../middleware/tenant.js";
import { requireFeature } from "../middleware/auth.js";
import { config } from "../config.js";
import { prisma } from "../prisma.js";

const router = Router();

const PRIVATE_VISIBILITY_MARKER = "[PRIVATE]";

function isPrivateDescription(description) {
  return String(description || "").trim().toUpperCase().startsWith(PRIVATE_VISIBILITY_MARKER);
}

function stripVisibilityPrefix(description) {
  return String(description || "").replace(/^\[PRIVATE\]\s*/i, "").trim() || null;
}

function applyVisibilityPrefix(description, visibility) {
  const clean = stripVisibilityPrefix(description);
  if (visibility === "private") {
    return clean ? `[PRIVATE] ${clean}` : "[PRIVATE]";
  }
  return clean;
}

// ── Schémas ──────────────────────────────────────────────────

const eventSchema = z.object({
  title:       z.string().min(1).max(200),
  description: z.string().optional(),
  startAt:     z.string().datetime(),
  endAt:       z.string().datetime(),
  timezone:    z.string().default("Europe/Paris"),
  location:    z.string().optional(),
  visibility:  z.enum(["public", "private"]).optional().default("public"),
});

// ── Routes authentifiées ──────────────────────────────────────
router.use(requireAuth, requireWorkspaceContext, requireFeature("calendar"));

// GET /api/calendar/events?from=&to=
router.get("/events", async (req, res) => {
  const from = req.query.from ? new Date(req.query.from) : new Date(new Date().setDate(1));
  const to   = req.query.to   ? new Date(req.query.to)   : new Date(new Date().setMonth(new Date().getMonth() + 2));

  const isSubClient = req.user.role === "sub_client";
  const scopeFilter = isSubClient
    ? { userId: req.user.sub }
    : req.workspaceId
      ? { workspaceId: req.workspaceId }
      : {};

  let events = await prisma.calendarEvent.findMany({
    where: {
      ...scopeFilter,
      startAt: { gte: from, lte: to },
    },
    orderBy: { startAt: "asc" },
  });

  if (req.user.role !== "admin" && req.user.role !== "client") {
    events = events.filter((event) => !isPrivateDescription(event.description) || event.userId === req.user.sub);
  }

  res.json({
    events: events.map((event) => ({
      ...event,
      visibility: isPrivateDescription(event.description) ? "private" : "public",
      description: stripVisibilityPrefix(event.description),
    })),
  });
});

// POST /api/calendar/events
router.post("/events", async (req, res) => {
  const body = eventSchema.parse(req.body);
  const description = applyVisibilityPrefix(body.description ?? "", body.visibility || "public");
  const event = await prisma.calendarEvent.create({
    data: {
      user:        { connect: { id: req.user.sub } },
      workspace:   req.workspaceId ? { connect: { id: req.workspaceId } } : undefined,
      title:       body.title,
      description: description || null,
      startAt:     new Date(body.startAt),
      endAt:       new Date(body.endAt),
      timezone:    body.timezone,
      location:    body.location ?? null,
    },
  });
  res.status(201).json({
    event: {
      ...event,
      visibility: isPrivateDescription(event.description) ? "private" : "public",
      description: stripVisibilityPrefix(event.description),
    },
  });
});

// PATCH /api/calendar/events/:id
router.patch("/events/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = await prisma.calendarEvent.findFirst({ where: { id, userId: req.user.sub } });
  if (!existing) return res.status(404).json({ error: "Événement introuvable" });

  const body = eventSchema.partial().parse(req.body);
  const event = await prisma.calendarEvent.update({
    where: { id },
    data: {
      ...(body.title       !== undefined && { title: body.title }),
      ...((body.description !== undefined || body.visibility !== undefined) && {
        description: applyVisibilityPrefix(
          body.description !== undefined ? body.description : existing.description,
          body.visibility || (isPrivateDescription(existing.description) ? "private" : "public")
        )
      }),
      ...(body.startAt     !== undefined && { startAt: new Date(body.startAt) }),
      ...(body.endAt       !== undefined && { endAt: new Date(body.endAt) }),
      ...(body.timezone    !== undefined && { timezone: body.timezone }),
      ...(body.location    !== undefined && { location: body.location }),
    },
  });
  res.json({
    event: {
      ...event,
      visibility: isPrivateDescription(event.description) ? "private" : "public",
      description: stripVisibilityPrefix(event.description),
    },
  });
});

// DELETE /api/calendar/events/:id
router.delete("/events/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = await prisma.calendarEvent.findFirst({ where: { id, userId: req.user.sub } });
  if (!existing) return res.status(404).json({ error: "Événement introuvable" });

  await prisma.calendarEvent.delete({ where: { id } });
  res.json({ success: true });
});

// ── GET /api/calendar/feed-token ─────────────────────────────
// Génère un token JWT de longue durée pour le flux iCal
router.get("/feed-token", async (req, res) => {
  const token = jwt.sign(
    { sub: req.user.sub, purpose: "ical" },
    config.jwtSecret,
    { expiresIn: "1y" }
  );
  res.json({ token });
});

// ── GET /api/calendar/feed/:token (public) ───────────────────
// Flux iCal exportable dans Google Calendar, Outlook, etc.
router.get("/feed/:token", async (req, res) => {
  let payload;
  try {
    payload = jwt.verify(req.params.token, config.jwtSecret);
  } catch {
    return res.status(401).send("Token invalide");
  }

  if (payload.purpose !== "ical") {
    return res.status(403).send("Token non autorisé");
  }

  const events = await prisma.calendarEvent.findMany({
    where: { userId: payload.sub },
    orderBy: { startAt: "asc" },
  });

  const ical = buildIcal(events);
  res.setHeader("Content-Type", "text/calendar; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="sellsia-calendar.ics"');
  res.send(ical);
});

// ── iCal builder ─────────────────────────────────────────────

function escapeIcal(str) {
  return (str || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function toIcalDate(date) {
  return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
}

function buildIcal(events) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Sellsia//Calendar//FR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  for (const ev of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:sellsia-event-${ev.id}@sellsia.io`,
      `DTSTAMP:${toIcalDate(ev.createdAt)}`,
      `DTSTART:${toIcalDate(ev.startAt)}`,
      `DTEND:${toIcalDate(ev.endAt)}`,
      `SUMMARY:${escapeIcal(ev.title)}`,
      ...(ev.description ? [`DESCRIPTION:${escapeIcal(ev.description)}`] : []),
      ...(ev.location    ? [`LOCATION:${escapeIcal(ev.location)}`] : []),
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

export default router;
