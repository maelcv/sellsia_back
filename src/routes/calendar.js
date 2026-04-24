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
import { decryptSecret, encryptSecret } from "../security/secrets.js";

const router = Router();

const PRIVATE_VISIBILITY_MARKER = "[PRIVATE]";
const GOOGLE_SYNC_MARKER_REGEX = /\n?\[GOOGLE_SYNC_EVENT:([^\]\n]+)\]\s*$/i;

function extractGoogleSyncEventId(description) {
  const match = String(description || "").match(GOOGLE_SYNC_MARKER_REGEX);
  return match?.[1] ? String(match[1]).trim() : null;
}

function stripGoogleSyncMetadata(description) {
  const raw = String(description || "");
  const stripped = raw.replace(GOOGLE_SYNC_MARKER_REGEX, "").trim();
  return stripped || null;
}

function isPrivateDescription(description) {
  const value = stripGoogleSyncMetadata(description);
  return String(value || "").trim().toUpperCase().startsWith(PRIVATE_VISIBILITY_MARKER);
}

function stripVisibilityPrefix(description) {
  return String(description || "").replace(/^\[PRIVATE\]\s*/i, "").trim() || null;
}

function stripStoredDescription(description) {
  return stripVisibilityPrefix(stripGoogleSyncMetadata(description));
}

function applyVisibilityPrefix(description, visibility) {
  const clean = stripVisibilityPrefix(description);
  if (visibility === "private") {
    return clean ? `[PRIVATE] ${clean}` : "[PRIVATE]";
  }
  return clean;
}

function buildStoredDescription({ description, visibility, googleSyncEventId = null }) {
  const withVisibility = applyVisibilityPrefix(description ?? "", visibility || "public");
  const base = withVisibility || "";
  if (!googleSyncEventId) return base || null;
  return `${base ? `${base}\n` : ""}[GOOGLE_SYNC_EVENT:${googleSyncEventId}]`;
}

async function getGoogleCalendarIntegration(userId) {
  const integration = await prisma.userIntegration.findFirst({
    where: {
      userId,
      integrationType: {
        name: {
          equals: "Google Calendar",
          mode: "insensitive",
        },
      },
    },
    include: { integrationType: true },
    orderBy: { linkedAt: "desc" },
  });

  if (!integration) return null;

  try {
    const credentials = JSON.parse(decryptSecret(integration.encryptedCredentials));
    return { integration, credentials };
  } catch (err) {
    throw new Error(`Credentials Google Calendar invalides: ${err.message}`);
  }
}

async function ensureGoogleAccessToken(userId) {
  const result = await getGoogleCalendarIntegration(userId);
  if (!result) return null;

  const { integration, credentials } = result;
  const accessToken = credentials?.accessToken || credentials?.access_token || null;
  const refreshToken = credentials?.refreshToken || credentials?.refresh_token || null;
  const expiresAtRaw = credentials?.expiresAt || credentials?.expires_at || null;
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw) : null;
  const tokenIsFresh = accessToken && (!expiresAt || expiresAt.getTime() > Date.now() + 60_000);

  if (tokenIsFresh) {
    return { accessToken, credentials, integration };
  }

  if (!refreshToken) {
    throw new Error("Token Google expiré et refresh token manquant");
  }
  if (!config.googleOauthClientId || !config.googleOauthClientSecret) {
    throw new Error("Google OAuth non configuré sur la plateforme");
  }

  const refreshRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: config.googleOauthClientId,
      client_secret: config.googleOauthClientSecret,
    }),
  });

  if (!refreshRes.ok) {
    const txt = await refreshRes.text();
    throw new Error(`Refresh token Google échoué (${refreshRes.status}): ${txt.slice(0, 200)}`);
  }

  const refreshed = await refreshRes.json();
  const nextAccessToken = refreshed.access_token || null;
  if (!nextAccessToken) {
    throw new Error("Google n'a pas renvoyé d'access token lors du refresh");
  }

  const nextCredentials = {
    ...credentials,
    accessToken: nextAccessToken,
    tokenType: refreshed.token_type || credentials?.tokenType || "Bearer",
    scope: refreshed.scope || credentials?.scope || null,
    expiresAt: refreshed.expires_in
      ? new Date(Date.now() + Number(refreshed.expires_in) * 1000).toISOString()
      : credentials?.expiresAt || null,
    refreshToken,
  };

  await prisma.userIntegration.update({
    where: { id: integration.id },
    data: {
      encryptedCredentials: encryptSecret(JSON.stringify(nextCredentials)),
    },
  });

  return { accessToken: nextAccessToken, credentials: nextCredentials, integration };
}

async function googleCalendarRequest(userId, method, path, body) {
  const tokenData = await ensureGoogleAccessToken(userId);
  if (!tokenData?.accessToken) {
    throw new Error("Google Calendar non connecté");
  }

  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${tokenData.accessToken}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Google Calendar API error (${res.status}): ${txt.slice(0, 250)}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

function toGoogleEventPayload({ title, description, startAt, endAt, timezone, location }) {
  return {
    summary: title,
    description: description || undefined,
    location: location || undefined,
    start: {
      dateTime: new Date(startAt).toISOString(),
      timeZone: timezone || "Europe/Paris",
    },
    end: {
      dateTime: new Date(endAt).toISOString(),
      timeZone: timezone || "Europe/Paris",
    },
  };
}

function normalizeGoogleDate(dateObj, fallback) {
  if (dateObj?.dateTime) return new Date(dateObj.dateTime).toISOString();
  if (dateObj?.date) return new Date(`${dateObj.date}T00:00:00.000Z`).toISOString();
  return fallback;
}

function mapGoogleEventResponse(ev) {
  return {
    id: String(ev.id),
    title: ev.summary || "Événement Google",
    description: ev.description || null,
    location: ev.location || null,
    startAt: normalizeGoogleDate(ev.start, null),
    endAt: normalizeGoogleDate(ev.end, normalizeGoogleDate(ev.start, null)),
    timezone: ev.start?.timeZone || ev.end?.timeZone || "Europe/Paris",
    source: "google",
  };
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
  syncWithGoogle: z.boolean().optional().default(false),
});

const googleExternalEventSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  startAt: z.string().datetime(),
  endAt: z.string().datetime(),
  timezone: z.string().default("Europe/Paris"),
  location: z.string().optional(),
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
      syncWithGoogle: Boolean(extractGoogleSyncEventId(event.description)),
      visibility: isPrivateDescription(event.description) ? "private" : "public",
      description: stripStoredDescription(event.description),
    })),
  });
});

// GET /api/calendar/google/events?from=&to=
router.get("/google/events", async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : new Date(new Date().setDate(1));
    const to = req.query.to ? new Date(req.query.to) : new Date(new Date().setMonth(new Date().getMonth() + 2));

    const integration = await getGoogleCalendarIntegration(req.user.sub);
    if (!integration) {
      return res.json({ connected: false, events: [] });
    }

    const query = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
    });

    const payload = await googleCalendarRequest(req.user.sub, "GET", `/calendars/primary/events?${query.toString()}`);
    const items = Array.isArray(payload?.items) ? payload.items : [];

    return res.json({
      connected: true,
      events: items.map((ev) => mapGoogleEventResponse(ev)).filter((ev) => ev.startAt),
    });
  } catch (err) {
    console.error("[calendar/google/events] Error:", err);
    return res.status(500).json({ error: err?.message || "Erreur Google Calendar" });
  }
});

// POST /api/calendar/google/events
router.post("/google/events", async (req, res) => {
  try {
    const body = googleExternalEventSchema.parse(req.body);
    const startAt = new Date(body.startAt);
    const endAt = new Date(body.endAt);

    if (isNaN(startAt.getTime()) || isNaN(endAt.getTime()) || endAt <= startAt) {
      return res.status(400).json({ error: "startAt/endAt invalides" });
    }

    const created = await googleCalendarRequest(
      req.user.sub,
      "POST",
      "/calendars/primary/events",
      toGoogleEventPayload({
        title: body.title,
        description: body.description || null,
        startAt,
        endAt,
        timezone: body.timezone,
        location: body.location || null,
      })
    );

    return res.status(201).json({
      event: mapGoogleEventResponse(created),
    });
  } catch (err) {
    console.error("[calendar/google/events POST] Error:", err);
    return res.status(500).json({ error: err?.message || "Erreur création événement Google" });
  }
});

// PATCH /api/calendar/google/events/:eventId
router.patch("/google/events/:eventId", async (req, res) => {
  try {
    const body = googleExternalEventSchema.partial().parse(req.body);
    const eventId = String(req.params.eventId || "").trim();
    if (!eventId) {
      return res.status(400).json({ error: "eventId invalide" });
    }

    const existing = await googleCalendarRequest(
      req.user.sub,
      "GET",
      `/calendars/primary/events/${encodeURIComponent(eventId)}`
    );

    const nextTitle = body.title !== undefined ? body.title : existing?.summary || "Événement Google";
    const nextDescription = body.description !== undefined ? body.description : existing?.description || null;
    const nextTimezone = body.timezone !== undefined ? body.timezone : existing?.start?.timeZone || "Europe/Paris";
    const nextLocation = body.location !== undefined ? body.location : existing?.location || null;
    const nextStartAt = body.startAt !== undefined ? new Date(body.startAt) : new Date(existing?.start?.dateTime || existing?.start?.date);
    const nextEndAt = body.endAt !== undefined ? new Date(body.endAt) : new Date(existing?.end?.dateTime || existing?.end?.date);

    if (isNaN(nextStartAt.getTime()) || isNaN(nextEndAt.getTime()) || nextEndAt <= nextStartAt) {
      return res.status(400).json({ error: "startAt/endAt invalides" });
    }

    const updated = await googleCalendarRequest(
      req.user.sub,
      "PUT",
      `/calendars/primary/events/${encodeURIComponent(eventId)}`,
      toGoogleEventPayload({
        title: nextTitle,
        description: nextDescription,
        startAt: nextStartAt,
        endAt: nextEndAt,
        timezone: nextTimezone,
        location: nextLocation,
      })
    );

    return res.json({
      event: mapGoogleEventResponse(updated),
    });
  } catch (err) {
    console.error("[calendar/google/events PATCH] Error:", err);
    return res.status(500).json({ error: err?.message || "Erreur mise à jour événement Google" });
  }
});

// DELETE /api/calendar/google/events/:eventId
router.delete("/google/events/:eventId", async (req, res) => {
  try {
    const eventId = String(req.params.eventId || "").trim();
    if (!eventId) {
      return res.status(400).json({ error: "eventId invalide" });
    }

    await googleCalendarRequest(
      req.user.sub,
      "DELETE",
      `/calendars/primary/events/${encodeURIComponent(eventId)}`
    );

    return res.json({ success: true });
  } catch (err) {
    console.error("[calendar/google/events DELETE] Error:", err);
    return res.status(500).json({ error: err?.message || "Erreur suppression événement Google" });
  }
});

// POST /api/calendar/events
router.post("/events", async (req, res) => {
  try {
    const body = eventSchema.parse(req.body);
    const startAt = new Date(body.startAt);
    const endAt = new Date(body.endAt);

    if (isNaN(startAt.getTime()) || isNaN(endAt.getTime()) || endAt <= startAt) {
      return res.status(400).json({ error: "startAt/endAt invalides" });
    }

    let googleSyncEventId = null;
    if (body.syncWithGoogle) {
      const googlePayload = toGoogleEventPayload({
        title: body.title,
        description: body.description || null,
        startAt,
        endAt,
        timezone: body.timezone,
        location: body.location || null,
      });
      const createdGoogleEvent = await googleCalendarRequest(req.user.sub, "POST", "/calendars/primary/events", googlePayload);
      googleSyncEventId = createdGoogleEvent?.id || null;
    }

    const description = buildStoredDescription({
      description: body.description ?? "",
      visibility: body.visibility || "public",
      googleSyncEventId,
    });

    const event = await prisma.calendarEvent.create({
      data: {
        user: { connect: { id: req.user.sub } },
        workspace: req.workspaceId ? { connect: { id: req.workspaceId } } : undefined,
        title: body.title,
        description,
        startAt,
        endAt,
        timezone: body.timezone,
        location: body.location ?? null,
      },
    });

    return res.status(201).json({
      event: {
        ...event,
        syncWithGoogle: Boolean(extractGoogleSyncEventId(event.description)),
        visibility: isPrivateDescription(event.description) ? "private" : "public",
        description: stripStoredDescription(event.description),
      },
    });
  } catch (err) {
    console.error("[calendar/events POST] Error:", err);
    return res.status(500).json({ error: err?.message || "Erreur création événement" });
  }
});

// PATCH /api/calendar/events/:id
router.patch("/events/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = await prisma.calendarEvent.findFirst({ where: { id, userId: req.user.sub } });
  if (!existing) return res.status(404).json({ error: "Événement introuvable" });

  try {
    const body = eventSchema.partial().parse(req.body);

    const existingGoogleSyncEventId = extractGoogleSyncEventId(existing.description);
    const existingVisibility = isPrivateDescription(existing.description) ? "private" : "public";
    const existingDescription = stripStoredDescription(existing.description) || "";

    const nextTitle = body.title !== undefined ? body.title : existing.title;
    const nextDescription = body.description !== undefined ? body.description : existingDescription;
    const nextVisibility = body.visibility || existingVisibility;
    const nextTimezone = body.timezone !== undefined ? body.timezone : existing.timezone;
    const nextLocation = body.location !== undefined ? body.location : existing.location;
    const nextStartAt = body.startAt !== undefined ? new Date(body.startAt) : existing.startAt;
    const nextEndAt = body.endAt !== undefined ? new Date(body.endAt) : existing.endAt;

    if (isNaN(nextStartAt.getTime()) || isNaN(nextEndAt.getTime()) || nextEndAt <= nextStartAt) {
      return res.status(400).json({ error: "startAt/endAt invalides" });
    }

    const shouldSyncWithGoogle =
      body.syncWithGoogle !== undefined ? body.syncWithGoogle : Boolean(existingGoogleSyncEventId);

    let googleSyncEventId = existingGoogleSyncEventId;

    if (shouldSyncWithGoogle) {
      const googlePayload = toGoogleEventPayload({
        title: nextTitle,
        description: nextDescription,
        startAt: nextStartAt,
        endAt: nextEndAt,
        timezone: nextTimezone,
        location: nextLocation,
      });

      if (googleSyncEventId) {
        await googleCalendarRequest(
          req.user.sub,
          "PUT",
          `/calendars/primary/events/${encodeURIComponent(googleSyncEventId)}`,
          googlePayload
        );
      } else {
        const createdGoogleEvent = await googleCalendarRequest(
          req.user.sub,
          "POST",
          "/calendars/primary/events",
          googlePayload
        );
        googleSyncEventId = createdGoogleEvent?.id || null;
      }
    } else if (googleSyncEventId) {
      try {
        await googleCalendarRequest(
          req.user.sub,
          "DELETE",
          `/calendars/primary/events/${encodeURIComponent(googleSyncEventId)}`
        );
      } catch (err) {
        console.warn(`[calendar] Failed to delete synced Google event ${googleSyncEventId}:`, err.message);
      }
      googleSyncEventId = null;
    }

    const storedDescription = buildStoredDescription({
      description: nextDescription,
      visibility: nextVisibility,
      googleSyncEventId,
    });

    const event = await prisma.calendarEvent.update({
      where: { id },
      data: {
        title: nextTitle,
        description: storedDescription,
        startAt: nextStartAt,
        endAt: nextEndAt,
        timezone: nextTimezone,
        location: nextLocation,
      },
    });

    return res.json({
      event: {
        ...event,
        syncWithGoogle: Boolean(extractGoogleSyncEventId(event.description)),
        visibility: isPrivateDescription(event.description) ? "private" : "public",
        description: stripStoredDescription(event.description),
      },
    });
  } catch (err) {
    console.error("[calendar/events PATCH] Error:", err);
    return res.status(500).json({ error: err?.message || "Erreur mise à jour événement" });
  }
});

// DELETE /api/calendar/events/:id
router.delete("/events/:id", async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = await prisma.calendarEvent.findFirst({ where: { id, userId: req.user.sub } });
  if (!existing) return res.status(404).json({ error: "Événement introuvable" });

  const googleSyncEventId = extractGoogleSyncEventId(existing.description);
  if (googleSyncEventId) {
    try {
      await googleCalendarRequest(
        req.user.sub,
        "DELETE",
        `/calendars/primary/events/${encodeURIComponent(googleSyncEventId)}`
      );
    } catch (err) {
      console.warn(`[calendar] Failed to delete synced Google event ${googleSyncEventId}:`, err.message);
    }
  }

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
  res.setHeader("Content-Disposition", 'attachment; filename="boatswain-calendar.ics"');
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
    "PRODID:-//Boatswain//Calendar//FR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  for (const ev of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:boatswain-event-${ev.id}@boatswain.io`,
      `DTSTAMP:${toIcalDate(ev.createdAt)}`,
      `DTSTART:${toIcalDate(ev.startAt)}`,
      `DTEND:${toIcalDate(ev.endAt)}`,
      `SUMMARY:${escapeIcal(ev.title)}`,
      ...(stripStoredDescription(ev.description) ? [`DESCRIPTION:${escapeIcal(stripStoredDescription(ev.description))}`] : []),
      ...(ev.location    ? [`LOCATION:${escapeIcal(ev.location)}`] : []),
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

export default router;
