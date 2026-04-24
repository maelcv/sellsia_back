import { z } from "../types.js";

const PRIVATE_PREFIX = "[PRIVATE]";

function applyVisibilityPrefix(description, visibility) {
  const clean = String(description || "").replace(/^\[PRIVATE\]\s*/i, "").trim();
  if (visibility === "private") {
    return clean ? `${PRIVATE_PREFIX} ${clean}` : PRIVATE_PREFIX;
  }
  return clean || null;
}

export const createCalendarEventAction = {
  id: "action:create_calendar_event",
  category: "action",
  name: "Creer un evenement calendrier",
  description: "Ajoute un evenement au calendrier local du workspace.",
  icon: "CalendarPlus",
  color: "#16a34a",

  inputSchema: z.object({
    title: z.string().describe("Titre de l'evenement"),
    description: z.string().optional().describe("Description libre"),
    startAt: z.string().describe("Date de debut ISO 8601"),
    endAt: z.string().describe("Date de fin ISO 8601"),
    timezone: z.string().optional().describe("Fuseau horaire, defaut Europe/Paris"),
    location: z.string().optional().describe("Lieu de l'evenement"),
    visibility: z.string().optional().describe("public | private"),
  }),

  outputSchema: z.object({
    eventId: z.string(),
    title: z.string(),
    startAt: z.string(),
    endAt: z.string(),
    visibility: z.string(),
  }),

  async execute(inputs, context) {
    if (!context.userId) {
      throw new Error("userId manquant dans le contexte");
    }

    const title = String(inputs.title || "").trim();
    if (!title) throw new Error("title est requis");

    const startAt = new Date(inputs.startAt);
    const endAt = new Date(inputs.endAt);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      throw new Error("startAt/endAt doivent etre des dates ISO valides");
    }
    if (endAt <= startAt) {
      throw new Error("endAt doit etre posterieur a startAt");
    }

    const visibility = String(inputs.visibility || "public").toLowerCase() === "private"
      ? "private"
      : "public";

    const { prisma } = await import("../../prisma.js");
    const event = await prisma.calendarEvent.create({
      data: {
        userId: context.userId,
        workspaceId: context.workspaceId || null,
        title,
        description: applyVisibilityPrefix(inputs.description || "", visibility),
        startAt,
        endAt,
        timezone: String(inputs.timezone || "Europe/Paris"),
        location: inputs.location ? String(inputs.location) : null,
      },
    });

    return {
      eventId: String(event.id),
      title: event.title,
      startAt: event.startAt.toISOString(),
      endAt: event.endAt.toISOString(),
      visibility,
    };
  },
};
