---
id: crm_action_v1
name: CRM Action
version: 1.0.0
category: crm
description: >
  Exécute des actions dans le CRM Sellsy : créer une note, mettre à jour
  une opportunité, modifier une fiche société, rechercher une entité.
business_goal: >
  Permettre à l'utilisateur d'agir directement dans Sellsy via le chat,
  sans quitter son contexte, avec confirmation avant toute modification.
---

# CRM Action Skill

## ROUTING

### use_when
- L'utilisateur demande de créer une tâche ou une note
- L'utilisateur demande de mettre à jour une opportunité
- L'utilisateur demande de modifier une fiche société ou contact
- L'utilisateur demande de rechercher une entité dans Sellsy
- L'utilisateur demande de naviguer vers une entité
- L'utilisateur demande d'ajouter un commentaire ou une remarque
- Mots-clés : créer, ajouter, modifier, mettre à jour, note, tâche, changer, aller sur, ouvre, montre-moi

### do_not_use_when
- L'utilisateur demande une analyse commerciale (→ sales_analysis)
- L'utilisateur demande de rédiger un message (→ sales_writer)
- L'utilisateur demande un diagnostic pipeline (→ pipeline_diagnostic)
- L'utilisateur demande une stratégie (→ sales_strategy)

### escalation_rules
- Si la demande implique d'abord analyser avant d'agir → sales_analysis en amont
- Si l'action demandée nécessite un contexte stratégique → sales_strategy
- Si l'utilisateur veut rédiger le contenu d'une note → sales_writer pour le contenu, crm_action pour la création

## EXECUTION

### input_requirements
**required:**
- action (create_note, update_opportunity, update_company, search, navigate)

**optional:**
- entity_type (company, contact, opportunity, quote)
- entity_id
- changes (object with fields to update)
- note_content
- search_query

### default_parameters
- confirmed: false (toujours preview d'abord)
- language: fr

### reasoning_rules
- TOUJOURS extraire les IDs typés du contexte avant tout appel d'outil
- NE JAMAIS confondre les types d'objets (companyId ≠ contactId ≠ opportunityId)
- Pour les entités liées, faire des appels enchaînés (société → contact)
- NE JAMAIS utiliser un nom comme ID
- Pour les modifications : TOUJOURS présenter un récapitulatif AVANT confirmation
- sellsy_create_note ne nécessite pas de confirmation

### style_rules
- Confirmation claire et explicite avant toute modification
- Récapitulatif lisible des changements proposés
- Message de succès court après exécution
- En cas d'erreur, explication claire et suggestion alternative

### decision_rules
- Si action = update_*, appeler SANS confirmed=true d'abord pour preview
- Si action = create_note, exécuter directement (pas de confirmation)
- Si action = search, retourner les résultats formatés
- Si action = navigate, utiliser l'outil navigate_to
- Si entity_id manque, chercher via le contexte page ou demander à l'utilisateur
- Si l'utilisateur dit "oui" ou "confirme" après un preview, appeler avec confirmed=true

### missing_data_strategy
- Si l'action n'est pas claire, demander via ask_user
- Si l'entity_id manque, utiliser le contexte de la page Sellsy
- Si le type d'entité n'est pas clair, inférer depuis le contexte page
- Si le contenu de la note manque, demander à l'utilisateur

### output_contract
**format:** confirmation_then_action

**flow:**
1. Récapitulatif des changements proposés (pour update)
2. Demande de confirmation utilisateur (pour update)
3. Exécution après confirmation
4. Message de succès/erreur

**must_be:**
- Sécurisé (jamais de modification sans confirmation)
- Clair sur ce qui va être modifié
- Rapide et direct

**must_not_be:**
- Exécuté sans preview pour les modifications
- Avec des IDs confondus entre types d'entités
- Bloqué si le contexte page fournit l'information manquante

### examples
- input: "Ajoute une note sur ce compte"
  expected: Demande le contenu de la note, puis création directe
- input: "Passe cette opportunité en négociation"
  expected: Preview du changement de statut, attente confirmation, puis exécution
- input: "Montre-moi la fiche du contact principal"
  expected: Récupération du contact via la société, puis navigation

### success_metrics
- Action exécutée correctement dans Sellsy
- Aucune modification non confirmée
- IDs correctement résolus
- Feedback clair à l'utilisateur
