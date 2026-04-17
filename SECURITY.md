# Boatswain — Règles de Sécurité Multi-Tenant

## Principes fondamentaux

1. **L'isolation tenant est appliquée au niveau base de données**, jamais au niveau des agents IA.
2. **Tout accès à une ressource doit être filtré par `tenantId`** pour les utilisateurs clients (`role=client`).
3. **L'admin (`role=admin`) est un super-admin** sans tenant — il voit toutes les données (`tenantId = null` sur `req`).
4. **Toute erreur d'accès cross-tenant retourne 404** (pas 403), afin de ne pas révéler l'existence d'une ressource.

---

## Middleware Chain

Toutes les routes privées doivent suivre cette chaîne :

```
requireAuth → requireTenantContext → handler
```

- `requireAuth` : vérifie le JWT, peuple `req.user`
- `requireTenantContext` : résout `req.tenantId` depuis le JWT (ou DB en fallback), bypass pour `role=admin`

Les routes publiques (ex: `GET /webhook` Meta) n'ont pas de middleware auth.

---

## Règles par rôle

| Rôle    | tenantId sur req | Accès données             |
|---------|------------------|---------------------------|
| `admin` | `null`           | Toutes les données        |
| `client`| `<uuid tenant>`  | Uniquement son tenant     |

---

## Tables avec isolation tenant

Les tables suivantes ont un champ `tenantId` et **doivent être filtrées** :

- `users`
- `conversations`
- `messages`
- `agent_prompts`
- `client_service_links`
- `orchestration_logs`
- `reasoning_steps`
- `audit_logs`
- `reminders`

Les tables **sans** `tenantId` (globales ou user-scoped par `clientId`) :

- `agents` — global, partagé entre tous les tenants
- `knowledge_documents` — filtré par `clientId`
- `whatsapp_accounts` — filtré par `userId`
- `whatsapp_messages` — filtré par `conversationId`

---

## Création de ressources

Toute création de ressource pour un utilisateur client **doit inclure** `tenantId: req.tenantId`.

```javascript
// ✅ Correct
await prisma.conversation.create({ data: { userId, tenantId: req.tenantId, ... } });

// ❌ Incorrect — manque tenantId
await prisma.conversation.create({ data: { userId, ... } });
```

---

## Validation d'appartenance

Utiliser `validateTenantOwnership` pour vérifier qu'une ressource appartient au tenant courant :

```javascript
import { validateTenantOwnership } from "../middleware/tenant.js";

const conversation = await prisma.conversation.findUnique({ where: { id } });
validateTenantOwnership(conversation, req); // throws 404 si cross-tenant
```

---

## JWT

Le payload JWT inclut `tenantId` depuis la v2 (login post-migration multi-tenant).
Les anciens tokens sans `tenantId` sont supportés via fallback DB dans `requireTenantContext`.

---

## Agents IA

Les agents (commercial, directeur, technicien) sont **globaux** — pas de `tenantId` sur le modèle `Agent`.
Le `tenantId` est injecté dans le `toolContext` via le dispatcher pour que les tools (ex: `schedule_reminder`) puissent l'utiliser lors de la création de ressources.
