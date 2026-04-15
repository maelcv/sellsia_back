/**
 * Platform Event Emitter — EventEmitter global pour les événements plateforme.
 *
 * Événements supportés :
 *   "conversation.ended"       { workspaceId, userId, conversationId, agentId }
 *   "reminder.triggered"       { workspaceId, userId, reminderId }
 *   "vault.note.created"       { workspaceId, path }
 *   "crm.company.created"      { workspaceId, companyId }
 *   "crm.opportunity.created"  { workspaceId, opportunityId }
 */

import { EventEmitter } from "node:events";

export const platformEmitter = new EventEmitter();
platformEmitter.setMaxListeners(50);
