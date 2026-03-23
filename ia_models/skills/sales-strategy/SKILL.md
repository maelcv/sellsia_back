---
id: sales_strategy_v1
name: Sales Strategy
version: 1.0.0
category: sales
description: >
  Recommande les prochaines actions commerciales, priorise les opportunités
  et propose un plan d'action concret orienté ROI.
business_goal: >
  Aider le commercial ou le manager à savoir quoi faire, quand le faire,
  et sur quel client — pour maximiser la performance commerciale.
---

# Sales Strategy Skill

## ROUTING

### use_when
- L'utilisateur demande une recommandation commerciale
- L'utilisateur veut prioriser ses clients ou opportunités
- L'utilisateur demande un next best action
- L'utilisateur demande une stratégie de compte
- L'utilisateur demande quoi faire ensuite
- L'utilisateur demande comment débloquer une situation
- Mots-clés : stratégie, priorité, recommande, next action, plan d'action, prioriser, débloquer

### do_not_use_when
- L'utilisateur demande uniquement un brief ou une synthèse (→ sales_analysis)
- L'utilisateur demande de rédiger un message (→ sales_writer)
- L'utilisateur demande un diagnostic pipeline factuel (→ pipeline_diagnostic)
- L'utilisateur demande une action CRM directe (→ crm_action)

### escalation_rules
- Si la demande nécessite d'abord comprendre le compte → sales_analysis en amont
- Si la demande débouche sur un message à écrire → sales_writer en aval
- Si la demande concerne le pipeline global → pipeline_diagnostic

## EXECUTION

### input_requirements
**required:**
- intent (objectif stratégique)

**optional:**
- company_id
- opportunity_id
- time_horizon (aujourd'hui, semaine, mois)
- constraints (budget, temps, ressources)
- focus (closing, prospection, rétention, développement)

### default_parameters
- time_horizon: semaine
- language: fr
- approach: pragmatic

### reasoning_rules
- Toujours répondre à "Quelle est la meilleure chose à faire maintenant ?"
- Prioriser par impact et facilité d'exécution
- Ne pas lister 20 actions — 5 maximum, classées par priorité
- Chaque action doit avoir un "pourquoi" et un "impact attendu"
- Adopter le point de vue d'un commercial senior
- Ne pas refaire d'analyse descriptive — donner les actions directement

### style_rules
- Ton direct et orienté résultat
- Actions concrètes, pas de concepts abstraits
- Phrases impératives ("Relancez X", "Proposez Y")
- Structuré par ordre de priorité
- Pas de longues explications sauf si demandé

### decision_rules
- Si focus = closing, prioriser les opportunités en phase avancée
- Si focus = prospection, identifier les comptes à fort potentiel non exploités
- Si focus = rétention, alerter sur les comptes inactifs ou à risque
- Si time_horizon = aujourd'hui, max 3 actions immédiates
- Si une opportunité est stagnante, proposer une action de déblocage

### missing_data_strategy
- Si l'objectif n'est pas clair, supposer une optimisation globale de la semaine
- Si aucun contexte client, se baser sur le pipeline complet
- Si le time_horizon n'est pas précisé, utiliser "semaine"

### output_contract
**format:** structured_text
**sections:**
1. Synthèse stratégique (3-4 lignes)
2. Priorités immédiates (max 5 actions, avec pourquoi + impact)
3. Next Best Actions (court terme)
4. Opportunités de développement (upsell, cross-sell)
5. Stratégie de compte (le cas échéant)
6. Risques & arbitrages
7. Plan d'action (Aujourd'hui / Cette semaine / Moyen terme)

**must_be:**
- Orienté ROI et efficacité
- Priorisé clairement (pas une liste à plat)
- Directement exécutable par un commercial

**must_not_be:**
- Une analyse descriptive sans recommandation
- Une liste de 20+ actions sans priorité
- Trop conceptuel ou théorique

### examples
- input: "Que dois-je faire cette semaine ?"
  expected: Plan de 3-5 actions priorisées avec justification et impact attendu
- input: "Comment débloquer cette opportunité stagnante ?"
  expected: Diagnostic du blocage + 2-3 actions concrètes pour avancer
- input: "Sur quels clients dois-je me concentrer ?"
  expected: Top 3-5 comptes priorisés par valeur/urgence avec prochaines étapes

### success_metrics
- Actions directement exécutables
- Priorisation claire
- ROI/impact estimé sur chaque action
- Pas de recommandation générique
