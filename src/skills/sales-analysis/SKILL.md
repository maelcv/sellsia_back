---
id: sales_analysis_v1
name: Sales Analysis
version: 1.0.0
category: sales
description: >
  Analyse un compte client, synthétise les interactions CRM et prépare
  un brief commercial structuré avec opportunités et risques.
business_goal: >
  Permettre au commercial de comprendre rapidement un client et de préparer
  efficacement un rendez-vous ou une action commerciale.
---

# Sales Analysis Skill

## ROUTING

### use_when
- L'utilisateur demande un brief ou une synthèse de compte client
- L'utilisateur prépare un rendez-vous commercial
- L'utilisateur demande d'analyser le potentiel d'un client
- L'utilisateur veut comprendre la situation d'un compte
- L'utilisateur demande les informations clés d'une société
- L'utilisateur demande une analyse de risque (churn, inactivité)
- Mots-clés : brief, synthèse, analyse client, potentiel, préparer rdv, résumé compte

### do_not_use_when
- L'utilisateur demande de rédiger un message (→ sales_writer)
- L'utilisateur demande une stratégie ou un plan d'action (→ sales_strategy)
- L'utilisateur demande un diagnostic pipeline global (→ pipeline_diagnostic)
- L'utilisateur demande une action CRM directe (→ crm_action)
- L'utilisateur demande un reporting chiffré global

### escalation_rules
- Si la demande porte surtout sur les prochaines actions → sales_strategy
- Si la demande porte sur la rédaction d'un message → sales_writer
- Si la demande porte sur le pipeline global → pipeline_diagnostic

## EXECUTION

### input_requirements
**required:**
- intent (ce que l'utilisateur veut savoir sur le compte)

**optional:**
- company_id
- contact_id
- opportunity_id
- meeting_date
- specific_focus (upsell, churn, historique, potentiel)

### default_parameters
- depth: standard
- language: fr
- focus: general

### reasoning_rules
- Toujours commencer par les données CRM disponibles avant toute recherche externe
- Transformer les données brutes en insights actionnables
- Distinguer les faits des hypothèses
- Prioriser l'information utile au commercial
- Ne jamais inventer de données — indiquer explicitement ce qui manque

### style_rules
- Synthèse rapide en 3-4 lignes max en intro
- Structuration claire avec sections numérotées
- Pas de jargon inutile
- Phrases courtes, orientées action
- Lisible sur mobile

### decision_rules
- Si meeting_date est fourni, inclure une section "Préparation du rendez-vous"
- Si le compte a des opportunités actives, analyser leur état
- Si le compte est inactif depuis > 30 jours, signaler le risque de churn
- Si des devis sont en attente, les mentionner en priorité
- Si les données CRM sont insuffisantes, proposer une recherche web

### missing_data_strategy
- Si l'intent n'est pas clair, supposer un brief général du compte
- Si aucun ID n'est fourni, utiliser le contexte de la page Sellsy
- Si les données CRM sont vides, proposer les données manquantes à récupérer

### output_contract
**format:** structured_text
**sections:**
1. Synthèse rapide (3-4 lignes max)
2. Informations clés (CA, opportunités, devis, contacts, interactions récentes)
3. Analyse commerciale (potentiel, maturité, position dans le cycle)
4. Opportunités identifiées (upsell, cross-sell)
5. Risques (inactivité, churn, dépendance, manque de suivi)
6. Implications commerciales (actions concrètes, priorités)
7. Préparation du rendez-vous (si pertinent)
8. Données manquantes ou faibles

**must_be:**
- Factuel et basé sur les données CRM
- Actionnable pour un commercial
- Lisible en moins de 2 minutes

**must_not_be:**
- Trop long ou exhaustif sans demande explicite
- Rempli de données brutes non interprétées
- Générique ou déconnecté du contexte client

### examples
- input: "Fais-moi un brief du compte ACME"
  expected: Brief structuré avec synthèse, KPIs, opportunités et risques basés sur les données CRM
- input: "Je vois ce client demain, prépare-moi"
  expected: Brief + section préparation rdv avec objectifs, messages clés et questions
- input: "Quel est le potentiel de ce client ?"
  expected: Analyse du potentiel avec opportunités upsell/cross-sell identifiées

### success_metrics
- Brief directement exploitable sans retouche
- Tous les insights basés sur des données réelles
- Risques identifiés si présents
- Temps de lecture < 2 minutes
