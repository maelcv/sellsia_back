/**
 * reminder-events.js
 *
 * EventEmitter global pour diffuser les rappels échus aux clients SSE connectés.
 *
 * Pourquoi un EventEmitter ?
 *   Le cron worker et le serveur Express tournent dans le même process Node.js.
 *   Plutôt que d'utiliser Redis ou une file de messages externe, on utilise
 *   un simple EventEmitter en mémoire — zéro dépendance supplémentaire.
 *
 * Cycle de vie d'un événement :
 *   1. Le cron worker exécute un rappel
 *   2. Il appelle reminderEmitter.emit('reminder', { userId, reminder })
 *   3. La route SSE (/api/reminders/events) écoute cet émetteur
 *   4. Elle filtre par userId et pousse l'événement au client connecté
 *
 * Limite connue : si le serveur redémarre, les clients SSE se déconnectent.
 * EventSource (côté frontend) gère la reconnexion automatique.
 */

import { EventEmitter } from "node:events";

// Instance unique partagée dans tout le process
export const reminderEmitter = new EventEmitter();

// Augmenter la limite de listeners pour éviter les warnings Node.js
// (un listener par client SSE connecté)
reminderEmitter.setMaxListeners(200);
