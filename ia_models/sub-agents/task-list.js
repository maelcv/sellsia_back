/**
 * TaskListSubAgent — List and analyze user tasks, events, and reminders
 *
 * Features:
 * - List calendar events and reminders
 * - Filter by date range and status
 * - Provide summary and upcoming items
 */

import { BaseSubAgent } from "./base-sub-agent.js";
import { prisma } from "../../src/prisma.js";

export class TaskListSubAgent extends BaseSubAgent {
  constructor(provider) {
    const systemPrompt = `Tu es un sous-agent specialise dans l'acces aux taches, evenements et rappels utilisateur.

ROLE : Lister et analyser les taches, evenements et rappels de l'utilisateur pour repondre a ses demandes.

PROCESSUS :
1. Identifie les types d'elements demandes (taches, evenements, rappels)
2. Filtre par date si specifie (aujourd'hui, cette semaine, ce mois)
3. Presente les elements de maniere structuree et actionnable
4. Fournit un resume avec les elements prioritaires

INFORMATIONS DISPONIBLES :
- Evenements calendrier (date, titre, duree)
- Rappels (date, heure, titre, statut)
- Priorite et statut de chaque element`;

    super({
      type: "task_list",
      provider,
      tools: [], // No tools — direct DB access
      systemPrompt,
    });
  }

  /**
   * Override execute to query tasks directly
   */
  async execute({ demande, contexte = "", toolContext = {}, thinkingMode = "low", onEvent = null }) {
    try {
      const { userId } = toolContext;
      if (!userId) {
        throw new Error("userId required in toolContext");
      }

      // Query calendar events and reminders
      const [events, reminders] = await Promise.all([
        prisma.calendarEvent.findMany({
          where: { userId },
          orderBy: { startDate: "asc" },
          select: {
            id: true,
            title: true,
            description: true,
            startDate: true,
            endDate: true,
            isAllDay: true,
          },
        }),
        prisma.reminder.findMany({
          where: { userId },
          orderBy: { reminderDate: "asc" },
          select: {
            id: true,
            title: true,
            reminderDate: true,
            status: true,
          },
        }),
      ]);

      // Parse demande with LLM to filter/summarize
      const summaryResult = await this.provider.chat({
        systemPrompt: this.systemPrompt,
        messages: [
          {
            role: "user",
            content: `${contexte ? `Contexte:\n${contexte}\n\n` : ""}
Voici les taches, evenements et rappels de l'utilisateur :

EVENEMENTS (${events.length}) :
${
  events.length === 0
    ? "Aucun"
    : events
        .map(
          (e) =>
            `- ${e.title} (${e.startDate.toLocaleDateString("fr-FR")}) ${e.description ? `- ${e.description}` : ""}`
        )
        .join("\n")
}

RAPPELS (${reminders.length}) :
${
  reminders.length === 0
    ? "Aucun"
    : reminders
        .map((r) => `- ${r.title} (${r.reminderDate.toLocaleDateString("fr-FR")}) - ${r.status}`)
        .join("\n")
}

Demande utilisateur : ${demande}

Analyse et reponds a la demande. Fournir un resume clair et actionnable.`,
          },
        ],
        temperature: 0.5,
        maxTokens: 2048,
      });

      return {
        demande,
        contexte,
        think: `Trouve ${events.length} evenements et ${reminders.length} rappels`,
        output: summaryResult.content || "",
        sources: ["calendar_events", "reminders"],
        tokensInput: summaryResult.tokensInput || 0,
        tokensOutput: summaryResult.tokensOutput || 0,
      };
    } catch (err) {
      console.error("[TaskListSubAgent] Error:", err);
      return {
        demande,
        contexte,
        think: "",
        output: `Error: ${err.message}`,
        sources: [],
        tokensInput: 0,
        tokensOutput: 0,
      };
    }
  }
}
