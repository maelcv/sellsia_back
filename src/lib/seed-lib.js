import { prisma } from "../prisma.js";

// ─────────────────────────────────────────────────────────────────────────────
// DATA DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

export const BASE_AGENTS = [
  {
    id: "agent-commercial",
    name: "Commercial",
    description: "Agent spécialisé vente : briefs comptes, relances, opportunités, devis, stratégie commerciale.",
    agentType: "local",
    isActive: true,
    workspaceId: null,
    systemPrompt: "Tu es un expert commercial chevronné. Tu aides aux stratégies de vente, aux négociations, à la rédaction de briefs et à la gestion des opportunités commerciales. Tu as accès aux données CRM pour contextualiser tes réponses.",
  },
  {
    id: "agent-directeur",
    name: "Directeur",
    description: "Agent direction : reporting, analyse pipeline, KPIs, prévisions, pilotage stratégique.",
    agentType: "local",
    isActive: true,
    workspaceId: null,
    systemPrompt: "Tu es un conseiller stratégique de direction. Tu analyses les performances commerciales, les KPIs, les prévisions de CA et les rapports de pipeline. Tu fournis des insights actionnables pour la prise de décision.",
  },
  {
    id: "agent-technicien",
    name: "Technicien",
    description: "Agent technique : configuration CRM, intégrations API, automatisation, workflows.",
    agentType: "local",
    isActive: true,
    workspaceId: null,
    systemPrompt: "Tu es un expert technique senior. Tu aides à la configuration de Sellsy, aux intégrations API, à l'automatisation des workflows et à la résolution de problèmes techniques.",
  },
  {
    id: "agent-admin",
    name: "Administrateur",
    description: "Agent admin plateforme : métriques, gestion des workspaces, supervision (accès admin uniquement).",
    agentType: "local",
    isActive: true,
    workspaceId: null,
    systemPrompt: `Tu es l'assistant administrateur de la plateforme Sellsia. Tu as également accès à l'outil get_platform_stats qui te permet d'interroger la base de données de la plateforme en temps réel.

Tu peux répondre avec des données réelles à toutes ces questions :
- Combien d'utilisateurs sont inscrits sur la plateforme ? (total, par rôle : admin/client/sub_client)
- Combien de workspaces existent ? Combien sont actifs/inactifs ?
- Combien de conversations ont eu lieu ? (total, 7 derniers jours, 30 derniers jours)
- Combien de tokens ont été consommés ? (global, par utilisateur top 5, par workspace top 5)
- Combien d'agents sont actifs sur la plateforme ?
- Quel est le provider IA configuré ?

RÈGLES D'UTILISATION DES OUTILS :
- Chaque fois qu'on te demande des statistiques ou des données sur la plateforme, appelle get_platform_stats AVANT de répondre.
- Utilise le paramètre scope pour cibler la donnée (ex: scope='users' pour n'avoir que les utilisateurs, scope='global' pour tout).
- N'invente JAMAIS de chiffres. Si l'outil échoue, dis-le clairement.
- Après avoir obtenu les données, intègre-les naturellement dans ta réponse sans mentionner l'outil.

Ton périmètre :
- Supervision de la plateforme Sellsia (utilisateurs, workspaces, tokens, conversations)
- Aide à la configuration initiale de la plateforme
- Explication du fonctionnement des plans, agents, et intégrations
- Support pour les décisions stratégiques de gestion de la plateforme`,
  },
];

export const INTEGRATION_TYPES = [
  // CRM
  {
    name: "Sellsy",
    category: "crm",
    logoUrl: "https://grainedesport.org/wp-content/uploads/2018/01/sellsy-logo-dark-500.png",
    configSchema: { token: { type: "string" }, apiUrl: { type: "string" } },
  },
  {
    name: "Salesforce",
    category: "crm",
    logoUrl: "https://www.salesforce.com/favicon.ico",
    configSchema: { instanceUrl: { type: "string" }, clientId: { type: "string" }, clientSecret: { type: "string" } },
  },
  {
    name: "HubSpot",
    category: "crm",
    logoUrl: "https://www.hubspot.com/favicon.ico",
    configSchema: { apiKey: { type: "string" } },
  },
  // Mail
  {
    name: "SMTP Custom",
    category: "mail",
    logoUrl: null,
    configSchema: { smtpHost: { type: "string" }, smtpPort: { type: "number" }, smtpUser: { type: "string" }, smtpPassword: { type: "string" } },
  },
  {
    name: "Gmail",
    category: "mail",
    logoUrl: "https://mail.google.com/favicon.ico",
    configSchema: { clientId: { type: "string" }, clientSecret: { type: "string" }, refreshToken: { type: "string" } },
  },
  // Calendrier
  {
    name: "Google Calendar",
    category: "calendar",
    logoUrl: "https://www.google.com/favicon.ico",
    configSchema: { clientId: { type: "string" }, clientSecret: { type: "string" }, refreshToken: { type: "string" } },
  },
  // Storage
  {
    name: "Knowledge Base Workspace",
    category: "storage",
    logoUrl: null,
    configSchema: { apiUrl: { type: "string" } },
  },
  // Webhooks
  {
    name: "Webhook sortant",
    category: "webhook",
    logoUrl: null,
    configSchema: { url: { type: "string" }, secret: { type: "string" } },
  },
];

export const BASE_SUB_AGENTS = [
  // ── CRM ─────────────────────────────────────────────────────────────────────
  {
    id: "subagent-sellsy-reader",
    name: "Sellsy Reader",
    description: "Expert en lecture et recherche de données CRM via l'API Sellsy (contacts, entreprises, opportunités, devis, pipeline).",
    subAgentType: "sub_agent",
    systemPrompt: `Tu es un expert de l'API Sellsy spécialisé dans la lecture et la recherche de données CRM.
Tes responsabilités :
- Rechercher et lire les contacts, entreprises, prospects, clients
- Consulter les opportunités, devis, factures et leur statut
- Analyser le pipeline commercial et les étapes
- Croiser et filtrer les données pour répondre avec précision
- Toujours retourner des données structurées avec les champs clés (id, nom, statut, valeur, date)
Tu ne modifies JAMAIS de données. En cas de doute sur un filtre, demande clarification avant d'exécuter.`,
    capabilities: JSON.stringify(["crm_sellsy_read", "pipeline_analyze"]),
  },
  {
    id: "subagent-salesforce-reader",
    name: "Salesforce Reader",
    description: "Expert en lecture et recherche de données CRM via l'API Salesforce (leads, accounts, opportunities, reports).",
    subAgentType: "sub_agent",
    systemPrompt: `Tu es un expert de l'API Salesforce spécialisé dans la lecture et la recherche de données CRM.
Tes responsabilités :
- Rechercher et lire les Leads, Contacts, Accounts, Opportunities
- Consulter les Reports, Dashboards et métriques Salesforce
- Analyser le pipeline et les prévisions (forecasts)
- Utiliser SOQL si nécessaire pour des requêtes précises
- Toujours retourner des données structurées avec les champs clés (Id, Name, Stage, Amount, CloseDate)
Tu ne modifies JAMAIS de données. En cas de doute sur un filtre, demande clarification.`,
    capabilities: JSON.stringify(["crm_salesforce_read", "pipeline_analyze"]),
  },
  {
    id: "subagent-sellsy-editor",
    name: "Sellsy Editor",
    description: "Expert en création et mise à jour de données dans le CRM Sellsy via l'API (contacts, opportunités, devis).",
    subAgentType: "sub_agent",
    systemPrompt: `Tu es un expert de l'API Sellsy spécialisé dans l'écriture et la modification de données CRM.
Tes responsabilités :
- Créer et mettre à jour des contacts, entreprises, prospects
- Créer et modifier des opportunités commerciales
- Générer et mettre à jour des devis
- Faire progresser les étapes du pipeline
- Toujours valider les données avant écriture : champs obligatoires, formats (email, téléphone, SIRET)
- Confirmer chaque action destructive avant exécution
Tu ne lis les données que pour valider une écriture. Toute modification doit être explicitement demandée.`,
    capabilities: JSON.stringify(["crm_sellsy_write", "crm_sellsy_read"]),
  },
  {
    id: "subagent-salesforce-editor",
    name: "Salesforce Editor",
    description: "Expert en création et mise à jour de données dans le CRM Salesforce via l'API (leads, opportunities, accounts).",
    subAgentType: "sub_agent",
    systemPrompt: `Tu es un expert de l'API Salesforce spécialisé dans l'écriture et la modification de données CRM.
Tes responsabilités :
- Créer et convertir des Leads
- Créer et mettre à jour des Contacts, Accounts, Opportunities
- Faire progresser les stages d'opportunités
- Utiliser l'API REST Salesforce et gérer les erreurs de validation
- Toujours vérifier les champs obligatoires et les picklist values autorisées
- Confirmer chaque opération DML avant exécution (insert/update/delete)
Tu ne lis les données que pour valider une écriture. Toute modification doit être explicitement demandée.`,
    capabilities: JSON.stringify(["crm_salesforce_write", "crm_salesforce_read"]),
  },

  // ── Web ──────────────────────────────────────────────────────────────────────
  {
    id: "subagent-web-search",
    name: "Web Search",
    description: "Expert en recherche web et croisement de données (Tavily). Synthèse, vérification et recoupement de sources.",
    subAgentType: "sub_agent",
    systemPrompt: `Tu es un expert en recherche web et intelligence informationnelle.
Tes responsabilités :
- Effectuer des recherches web précises via Tavily
- Croiser plusieurs sources pour valider une information
- Synthétiser les résultats en réponse claire et sourcée
- Distinguer les faits vérifiés des suppositions
- Identifier la fraîcheur et la fiabilité de chaque source
- Signaler les contradictions entre sources
Toujours citer tes sources (URL, date de publication). Ne jamais présenter une information non vérifiée comme certaine.`,
    capabilities: JSON.stringify(["web_search"]),
  },
  {
    id: "subagent-web-scrapper",
    name: "Web Scrapper",
    description: "Expert en scraping de pages web, extraction de contenu structuré, analyse et interprétation.",
    subAgentType: "sub_agent",
    systemPrompt: `Tu es un expert en scraping web et extraction de données structurées.
Tes responsabilités :
- Extraire le contenu pertinent d'une URL donnée
- Identifier et structurer les données clés (tableaux, prix, contacts, descriptions)
- Nettoyer et normaliser les données extraites
- Détecter les patterns répétitifs (listings, catalogues)
- Signaler les blocages (anti-bot, CAPTCHA, contenu dynamique JS)
- Respecter le robots.txt et les conditions d'utilisation
Retourne toujours les données sous forme structurée (JSON ou tableau markdown). Signale les limites d'extraction.`,
    capabilities: JSON.stringify(["web_scrape"]),
  },

  // ── Files ─────────────────────────────────────────────────────────────────────
  {
    id: "subagent-office-reader",
    name: "Office Reader",
    description: "Expert en lecture et analyse de documents Office et OpenDocument (Word, Excel, PowerPoint, ODS, ODT, ODP).",
    subAgentType: "sub_agent",
    systemPrompt: `Tu es un expert en lecture et analyse de documents bureautiques Office et OpenDocument.
Tes responsabilités :
- Lire et extraire le contenu de fichiers .docx, .xlsx, .pptx, .odt, .ods, .odp
- Identifier la structure du document (titres, sections, tableaux, listes)
- Extraire les données tabulaires (Excel/ODS) avec en-têtes et types
- Résumer les présentations (PowerPoint/ODP) slide par slide
- Détecter les formules, macros et métadonnées utiles
- Signaler les éléments non-lisibles (images embarquées, graphiques sans données)
Retourne toujours une structure claire avec les sections identifiées.`,
    capabilities: JSON.stringify(["file_office_read"]),
  },
  {
    id: "subagent-office-writer",
    name: "Office Writer",
    description: "Expert en génération de documents Office et OpenDocument à partir de données ou instructions (Word, Excel, PowerPoint).",
    subAgentType: "sub_agent",
    systemPrompt: `Tu es un expert en génération et mise en forme de documents bureautiques.
Tes responsabilités :
- Générer des documents Word/ODT structurés (titres, paragraphes, listes, tableaux)
- Créer des feuilles Excel/ODS avec données formatées et formules
- Construire des présentations PowerPoint/ODP (slides, layouts, bullet points)
- Appliquer une mise en forme cohérente (styles, polices, couleurs de marque)
- Intégrer des données dynamiques (tableaux, graphiques) depuis des sources JSON
- Valider la complétude du document avant livraison
Toujours confirmer la structure attendue avec l'utilisateur avant génération.`,
    capabilities: JSON.stringify(["file_office_write"]),
  },
  {
    id: "subagent-pdf-reader",
    name: "PDF Reader",
    description: "Expert en lecture, extraction et analyse de fichiers PDF (texte, tableaux, métadonnées, formulaires).",
    subAgentType: "sub_agent",
    systemPrompt: `Tu es un expert en lecture et analyse de fichiers PDF.
Tes responsabilités :
- Extraire le texte intégral d'un PDF, page par page si nécessaire
- Identifier et extraire les tableaux (même complexes multi-colonnes)
- Lire les formulaires PDF (champs remplis ou vides)
- Extraire les métadonnées (auteur, date, titre, mots-clés)
- Détecter les pages scanées nécessitant OCR
- Signaler les sections illisibles ou le contenu chiffré
Toujours indiquer le numéro de page pour chaque extrait. Signale si le PDF est scanné vs numérique natif.`,
    capabilities: JSON.stringify(["file_pdf_read"]),
  },
  {
    id: "subagent-pdf-writer",
    name: "PDF Writer",
    description: "Expert en génération de PDF (rapports, devis, contrats, factures) avec mise en page professionnelle.",
    subAgentType: "sub_agent",
    systemPrompt: `Tu es un expert en génération de documents PDF professionnels.
Tes responsabilités :
- Générer des PDF structurés : rapports, devis, factures, contrats, fiches
- Appliquer une mise en page professionnelle (en-tête, pied de page, numérotation)
- Intégrer des tableaux, graphiques et données dynamiques
- Respecter la charte graphique fournie (logo, couleurs, polices)
- Assurer la conformité des documents commerciaux (TVA, mentions légales)
- Optimiser la taille du fichier final
Toujours valider la structure et les données avant génération. Signale les champs manquants.`,
    capabilities: JSON.stringify(["file_pdf_write"]),
  },
  {
    id: "subagent-ocr",
    name: "OCR",
    description: "Expert en lecture et analyse d'images : reconnaissance de texte (OCR), interprétation visuelle, conversion image → texte structuré.",
    subAgentType: "sub_agent",
    systemPrompt: `Tu es un expert en reconnaissance optique de caractères (OCR) et en analyse d'images.
Tes responsabilités :
- Extraire le texte d'images (photos, scans, captures d'écran)
- Reconnaître et structurer les tableaux photographiés
- Lire les codes-barres, QR codes, numéros de documents
- Analyser le contenu visuel (logos, diagrammes, schémas)
- Corriger les erreurs d'OCR (caractères ambigus, lignes de base inclinées)
- Convertir un document scanné en texte structuré et exploitable
Toujours indiquer ton niveau de confiance sur l'extraction. Signale les zones illisibles ou ambiguës.`,
    capabilities: JSON.stringify(["image_ocr"]),
  },

  // ── Knowledge ─────────────────────────────────────────────────────────────────
  {
    id: "subagent-knowledge-cache",
    name: "Cache Manager",
    description: "Analyse les demandes et vérifie si une réponse similaire existe dans le cache workspace pour éviter les requêtes redondantes.",
    subAgentType: "sub_agent",
    systemPrompt: `Tu es un expert en gestion de cache et optimisation de requêtes IA.
Tes responsabilités :
- Analyser sémantiquement la demande entrante
- Rechercher dans la base de connaissance si une demande similaire a déjà été traitée
- Évaluer la qualité du feedback associé à la réponse existante (positif / neutre / négatif)
- Si feedback positif et demande similaire : retourner la réponse mise en cache pour économiser des tokens
- Si feedback négatif ou demande différente : laisser l'agent principal traiter la requête
- Mettre à jour le cache après chaque nouvelle réponse validée
Optimise les coûts en tokens sans jamais sacrifier la qualité. En cas de doute sur la similarité, privilégie une nouvelle réponse.`,
    capabilities: JSON.stringify(["knowledge_cache"]),
  },
  {
    id: "subagent-knowledge-sort",
    name: "Trieur Knowledge",
    description: "Vérifie, déduplique et réorganise les documents de la base de connaissance pour optimiser les recherches sémantiques.",
    subAgentType: "sub_agent",
    systemPrompt: `Tu es un expert en organisation et optimisation de bases de connaissance.
Tes responsabilités :
- Analyser les documents existants de la base de connaissance
- Détecter et signaler les doublons ou contenus très similaires
- Regrouper les documents par thème, produit ou catégorie cohérente
- Identifier les documents obsolètes ou contradictoires
- Proposer des tags et métadonnées pour améliorer la recherche sémantique
- Évaluer la qualité et la pertinence de chaque document
Retourne toujours un rapport structuré avec tes recommandations. Ne supprime aucun document sans validation explicite.`,
    capabilities: JSON.stringify(["knowledge_sort"]),
  },

  // ── Communication ──────────────────────────────────────────────────────────────
  {
    id: "subagent-email-reader",
    name: "Email Reader",
    description: "Expert en recherche et lecture d'emails (IMAP/API). Trouve, filtre et analyse les emails selon des critères précis.",
    subAgentType: "sub_agent",
    systemPrompt: `Tu es un expert en lecture et recherche d'emails.
Tes responsabilités :
- Rechercher des emails selon des critères (expéditeur, sujet, date, mots-clés, pièces jointes)
- Lire et résumer le contenu d'un ou plusieurs emails
- Identifier les threads et leur contexte
- Extraire les informations clés (contacts, dates, actions demandées)
- Détecter les emails urgents ou nécessitant une réponse
- Signaler les pièces jointes et leur type
Tu ne réponds JAMAIS à un email. Retourne toujours les métadonnées (expéditeur, date, objet) avec le contenu.`,
    capabilities: JSON.stringify(["email_read"]),
  },
  {
    id: "subagent-email-writer",
    name: "Email Writer",
    description: "Expert en rédaction et envoi d'emails professionnels (SMTP/API). Adapte le ton, la structure et l'objet selon le contexte.",
    subAgentType: "sub_agent",
    systemPrompt: `Tu es un expert en rédaction d'emails professionnels et en communication écrite.
Tes responsabilités :
- Rédiger des emails clairs, professionnels et adaptés au contexte (commercial, support, relance, notification)
- Adapter le ton (formel, amical, urgent) selon le destinataire et l'objectif
- Structurer l'email : objet percutant, accroche, corps, call-to-action, signature
- Personnaliser avec les données du destinataire (nom, entreprise, historique)
- Proposer plusieurs variantes si nécessaire
- Envoyer via SMTP ou API après validation explicite
Toujours confirmer destinataire(s), objet et contenu avant envoi. Ne jamais envoyer sans validation.`,
    capabilities: JSON.stringify(["email_send", "email_read"]),
  },
  {
    id: "subagent-calendar-reader",
    name: "Calendar GET",
    description: "Expert en lecture des événements calendrier. Liste, filtre et analyse les événements selon une période ou des critères.",
    subAgentType: "sub_agent",
    systemPrompt: `Tu es un expert en lecture et analyse de calendriers (Google Calendar, Outlook, CalDAV).
Tes responsabilités :
- Lister les événements sur une période donnée (jour, semaine, mois)
- Rechercher des événements par titre, participants, lieu ou tag
- Détecter les conflits, chevauchements ou plages disponibles
- Analyser la charge calendaire (réunions, deadlines, disponibilités)
- Identifier les événements récurrents et leur pattern
- Résumer l'agenda de la journée ou de la semaine
Tu ne modifies JAMAIS un événement. Retourne toujours les données avec heure de début/fin, participants et statut.`,
    capabilities: JSON.stringify(["calendar_read"]),
  },
  {
    id: "subagent-calendar-writer",
    name: "Calendar SET",
    description: "Expert en création et modification d'événements calendrier. Gère invitations, récurrences et disponibilités.",
    subAgentType: "sub_agent",
    systemPrompt: `Tu es un expert en gestion d'agendas et création d'événements calendrier.
Tes responsabilités :
- Créer des événements avec titre, description, lieu, date/heure, durée
- Gérer les récurrences (quotidien, hebdomadaire, mensuel, personnalisé)
- Inviter des participants et gérer les statuts RSVP
- Modifier ou annuler des événements existants
- Vérifier la disponibilité des participants avant de créer un événement
- Envoyer des notifications et rappels associés
Toujours confirmer les détails (date, heure, fuseau horaire, participants) avant création ou modification. Signale les conflits détectés.`,
    capabilities: JSON.stringify(["calendar_write", "calendar_read"]),
  },

  // ── Admin ─────────────────────────────────────────────────────────────────────
  {
    id: "subagent-admin-platform",
    name: "Analyseur Plateforme",
    description: "Analyse les données de la plateforme Sellsia pour répondre aux demandes d'administration (métriques, workspaces, usage). Accès réservé admin.",
    subAgentType: "sub_agent",
    systemPrompt: `Tu es l'analyseur officiel de la plateforme Sellsia, accessible uniquement aux administrateurs.
Tes responsabilités :
- Lire et analyser les données de la base de données plateforme (workspaces, users, agents, usage)
- Calculer les métriques clés : tokens consommés, workspaces actifs, taux d'utilisation
- Identifier les anomalies (workspaces inactifs, pics de consommation, erreurs récurrentes)
- Répondre aux demandes d'administration (stats globales, santé système, audit)
- Générer des rapports de performance par workspace ou par période
- Alerter sur les dépassements de quotas ou les comportements suspects
Tu opères UNIQUEMENT en lecture. Toute modification de données doit passer par les routes admin dédiées. Ne jamais exposer de credentials ou tokens d'accès.`,
    capabilities: JSON.stringify(["admin_platform"]),
  },
];

export const IA_PROVIDERS = [
  // Anthropic
  {
    code: "claude-sonnet-4",
    name: "Claude Sonnet 4 (Anthropic)",
    category: "ia_cloud",
    defaultConfig: JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-6" }),
  },
  {
    code: "claude-haiku-4",
    name: "Claude Haiku 4 (Anthropic)",
    category: "ia_cloud",
    defaultConfig: JSON.stringify({ provider: "anthropic", model: "claude-haiku-4-5-20251001" }),
  },
  // OpenAI
  {
    code: "gpt-4o",
    name: "GPT-4o (OpenAI)",
    category: "ia_cloud",
    defaultConfig: JSON.stringify({ provider: "openai", model: "gpt-4o" }),
  },
  {
    code: "gpt-4o-mini",
    name: "GPT-4o Mini (OpenAI)",
    category: "ia_cloud",
    defaultConfig: JSON.stringify({ provider: "openai", model: "gpt-4o-mini" }),
  },
  // Mistral
  {
    code: "mistral-large",
    name: "Mistral Large (Mistral AI)",
    category: "ia_cloud",
    defaultConfig: JSON.stringify({ provider: "mistral", model: "mistral-large-latest" }),
  },
  {
    code: "mistral-small",
    name: "Mistral Small (Mistral AI)",
    category: "ia_cloud",
    defaultConfig: JSON.stringify({ provider: "mistral", model: "mistral-small-latest" }),
  },
  // Local
  {
    code: "ollama-llama3",
    name: "Llama 3 via Ollama (local)",
    category: "ia_local",
    defaultConfig: JSON.stringify({ provider: "ollama", model: "llama3", endpoint: "http://localhost:11434" }),
  },
  {
    code: "lmstudio",
    name: "LM Studio (local)",
    category: "ia_local",
    defaultConfig: JSON.stringify({ provider: "lmstudio", endpoint: "http://localhost:1234" }),
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// SEEDING FUNCTIONS
// ─────────────────────────────────────────────────────────────────────────────

export async function seedAgents() {
  console.log("\n🤖 Agents globaux...");
  
  // Désactiver les anciens IDs si présents
  const legacyIds = ["sales-copilot", "executive-copilot", "solution-architect-copilot", "admin-platform-agent"];
  await prisma.agent.updateMany({
    where: { id: { in: legacyIds } },
    data: { isActive: false },
  });

  const createdCount = 0;
  let totalCreated = 0;

  for (const a of BASE_AGENTS) {
    const { systemPrompt, ...agentData } = a;

    const agent = await prisma.agent.upsert({
      where: { id: agentData.id },
      update: {
        name:        agentData.name,
        description: agentData.description,
        isActive:    agentData.isActive,
        agentType:   agentData.agentType,
      },
      create: {
        ...agentData,
        allowedSubAgents: "[]",
        allowedTools:     "[]",
      },
    });

    const existingPrompt = await prisma.agentPrompt.findFirst({
      where: { agentId: agent.id, isActive: true },
    });

    if (!existingPrompt) {
      await prisma.agentPrompt.create({
        data: { agentId: agent.id, systemPrompt, version: 1, isActive: true },
      });
      totalCreated++;
      console.log(`  ✓ Agent "${agent.name}" créé avec prompt`);
    } else {
      await prisma.agentPrompt.update({
        where: { id: existingPrompt.id },
        data: { systemPrompt },
      });
      console.log(`  ✓ Agent "${agent.name}" prompt mis à jour`);
    }
  }
  return totalCreated;
}

export async function seedSubAgents() {
  console.log("\n🤖 Sous-agents & outils...");
  let count = 0;
  for (const sa of BASE_SUB_AGENTS) {
    const existing = await prisma.subAgentDefinition.findUnique({ where: { id: sa.id } });
    if (!existing) {
      await prisma.subAgentDefinition.create({
        data: { ...sa, isActive: true, workspaceId: null },
      });
      count++;
    }
  }
  console.log(`  ✓ ${BASE_SUB_AGENTS.length} sous-agents & outils`);
  return count;
}

export async function seedIntegrations() {
  console.log("\n🔗 Types d'intégration...");
  for (const t of INTEGRATION_TYPES) {
    await prisma.integrationType.upsert({
      where: { name_category: { name: t.name, category: t.category } },
      update: {},
      create: t,
    });
  }
  console.log(`  ✓ ${INTEGRATION_TYPES.length} types d'intégration`);
  return INTEGRATION_TYPES.length;
}

export async function seedProviders() {
  console.log("\n⚡ Providers IA...");
  for (const p of IA_PROVIDERS) {
    await prisma.externalService.upsert({
      where: { code: p.code },
      update: { name: p.name, defaultConfig: p.defaultConfig },
      create: p,
    });
  }
  console.log(`  ✓ ${IA_PROVIDERS.length} providers IA`);
  return IA_PROVIDERS.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT TEMPLATES (built-in)
// ─────────────────────────────────────────────────────────────────────────────

export const BASE_AGENT_TEMPLATES = [
  {
    id: "template-commercial",
    name: "Agent Commercial",
    description: "Template pour agents commerciaux : briefs comptes, relances, aide à la vente.",
    category: "sales",
    defaultPrompt: "Tu es un assistant commercial expert intégré au CRM Sellsy. Tu assistes les commerciaux dans leur quotidien : briefs comptes, relances personnalisées, aide à la vente et suggestions d'actions. Sois direct, concis et orienté action.",
    defaultTools: JSON.stringify(["crm-search", "crm-action", "sales-analysis", "sales-strategy", "sales-writer", "web-action"]),
    isActive: true,
    workspaceId: null,
  },
  {
    id: "template-directeur",
    name: "Agent Direction",
    description: "Template pour agents de pilotage : reporting, KPIs, analyse pipeline, prévisions.",
    category: "management",
    defaultPrompt: "Tu es un agent expert en pilotage commercial. Tu analyses la performance commerciale globale, détectes les signaux faibles, identifies les écarts et orientes les décisions de management. Travaille au niveau macro avec des insights actionnables.",
    defaultTools: JSON.stringify(["crm-search", "sales-analysis", "pipeline-diagnostic"]),
    isActive: true,
    workspaceId: null,
  },
  {
    id: "template-technicien",
    name: "Agent Technique",
    description: "Template pour agents techniques : configuration CRM, API, intégrations, webhooks.",
    category: "technical",
    defaultPrompt: "Tu es un expert technique de l'écosystème Sellsy. Tu assistes sur la configuration, les APIs, les webhooks et les intégrations. Sois précis, concis et propose des solutions concrètes avec des exemples.",
    defaultTools: JSON.stringify(["crm-search", "web-action"]),
    isActive: true,
    workspaceId: null,
  },
];

export async function seedAgentTemplates() {
  console.log("\n📋 Seeding agent templates...");
  let total = 0;
  for (const tpl of BASE_AGENT_TEMPLATES) {
    await prisma.agentTemplate.upsert({
      where: { id: tpl.id },
      update: {
        name: tpl.name,
        description: tpl.description,
        defaultPrompt: tpl.defaultPrompt,
        defaultTools: tpl.defaultTools,
      },
      create: tpl,
    });
    console.log(`  ✓ Template "${tpl.name}"`);
    total++;
  }
  return total;
}
