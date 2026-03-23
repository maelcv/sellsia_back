---
id: pipeline_diagnostic_v1
name: Pipeline Diagnostic
version: 1.0.0
category: sales
description: >
  Analyse le pipeline commercial, détecte les opportunités à risque,
  stagnantes ou oubliées, et identifie les devis non relancés.
business_goal: >
  Donner au commercial ou au manager une vision claire et factuelle
  de l'état du pipeline pour identifier les problèmes avant qu'ils ne deviennent critiques.
---

# Pipeline Diagnostic Skill

## ROUTING

### use_when
- L'utilisateur demande un état du pipeline
- L'utilisateur veut identifier les opportunités à risque
- L'utilisateur demande quelles opportunités sont stagnantes ou oubliées
- L'utilisateur demande un audit des devis non relancés
- L'utilisateur veut comprendre la dynamique du pipeline
- Mots-clés : pipeline, stagnant, à risque, oublié, devis non relancé, audit, diagnostic, état des lieux

### do_not_use_when
- L'utilisateur demande une stratégie ou un plan d'action (→ sales_strategy)
- L'utilisateur demande un brief sur un compte spécifique (→ sales_analysis)
- L'utilisateur demande de rédiger un message (→ sales_writer)
- L'utilisateur demande une action CRM directe (→ crm_action)

### escalation_rules
- Si la demande évolue vers "que faire ?" après le diagnostic → sales_strategy
- Si la demande cible un compte spécifique en profondeur → sales_analysis
- Si le diagnostic révèle un besoin de relance → sales_writer

## EXECUTION

### input_requirements
**required:**
- intent (ce que l'utilisateur veut diagnostiquer)

**optional:**
- pipeline_id
- time_range (derniers 7j, 30j, 90j)
- focus (stagnant, à risque, oublié, devis, closing)
- company_id (pour filtrer sur un compte)

### default_parameters
- time_range: 30j
- language: fr
- scope: global

### reasoning_rules
- Agent de DIAGNOSTIC uniquement — ne pas définir de stratégie globale
- Rester factuel et basé sur les données CRM
- Identifier les patterns (stagnation, inactivité, blocage)
- Signaler les anomalies (devis vieux sans relance, opps sans activité récente)
- Ne jamais inventer de données — indiquer ce qui manque
- Micro-actions évidentes autorisées ("devis non relancé → relance nécessaire")

### style_rules
- Structuration claire par catégorie de problème
- Chiffres précis (montants, durées, dates)
- Pas de jugement de valeur — constats factuels
- Lisible rapidement par un manager pressé
- Format tabulaire si pertinent (opportunités listées)

### decision_rules
- Si focus = stagnant, lister les opportunités sans mouvement depuis > 15 jours
- Si focus = à risque, identifier les signaux faibles (probabilité basse, inactivité, deadline passée)
- Si focus = devis, vérifier les devis envoyés sans réponse depuis > 7 jours
- Si focus = closing, lister les opportunités en phase finale avec leur dernière activité
- Si scope = global, couvrir toutes les catégories
- Toujours trier par montant décroissant (plus gros deals en premier)

### missing_data_strategy
- Si l'intent n'est pas clair, produire un diagnostic global
- Si pas de pipeline_id, analyser tous les pipelines
- Si pas de time_range, utiliser 30 jours par défaut

### output_contract
**format:** structured_text
**sections:**
1. Synthèse du pipeline (volume, montant total, tendance)
2. Opportunités en phase avancée (proches du closing)
3. Opportunités à risque (signaux faibles)
4. Opportunités stagnantes (sans mouvement)
5. Opportunités oubliées (aucune activité récente)
6. Devis non relancés
7. Dynamique du pipeline (entrées/sorties, vélocité)
8. Points d'attention

**must_be:**
- Factuel et chiffré
- Organisé par niveau de risque/urgence
- Directement exploitable sans reformulation

**must_not_be:**
- Un plan stratégique (c'est un diagnostic)
- Une simple liste sans analyse
- Rempli de recommandations complexes

### examples
- input: "Quel est l'état de mon pipeline ?"
  expected: Diagnostic global avec synthèse, opportunités à risque, stagnantes et devis en attente
- input: "Quelles opportunités sont bloquées ?"
  expected: Liste des opportunités stagnantes avec durée de stagnation et dernière activité
- input: "Y a-t-il des devis non relancés ?"
  expected: Liste des devis envoyés sans réponse avec montant et date d'envoi

### success_metrics
- Tous les problèmes identifiés dans les données
- Chiffres précis et vérifiables
- Aucune donnée inventée
- Lisible en < 2 minutes
