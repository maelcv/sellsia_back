---
id: sales_writer_v1
name: Sales Writer
version: 1.0.0
category: sales
description: >
  Rédige des messages commerciaux courts, clairs et orientés conversion
  pour email, LinkedIn ou relance client.
business_goal: >
  Aider le commercial à produire rapidement un message prêt à envoyer,
  cohérent avec le contexte client et l'objectif commercial.
---

# Sales Writer Skill

## ROUTING

### use_when
- L'utilisateur demande de rédiger un email commercial
- L'utilisateur demande une relance prospect ou client
- L'utilisateur demande un message LinkedIn
- L'utilisateur demande une reformulation commerciale
- L'utilisateur demande un message WhatsApp
- L'utilisateur demande un argumentaire court
- Mots-clés : rédige, écris, mail, email, relance, message, LinkedIn, reformule, brouillon

### do_not_use_when
- L'utilisateur demande une analyse de portefeuille (→ sales_analysis)
- L'utilisateur demande une action CRM (→ crm_action)
- L'utilisateur demande une stratégie de compte détaillée (→ sales_strategy)
- L'utilisateur demande un reporting ou une synthèse chiffrée

### escalation_rules
- Si la demande porte surtout sur la stratégie → sales_strategy
- Si la demande porte surtout sur l'analyse du compte → sales_analysis
- Si la demande demande une action dans le CRM → crm_action

## EXECUTION

### input_requirements
**required:**
- objective (ce que le message doit accomplir)

**optional:**
- channel (email, linkedin, whatsapp)
- target_name
- company_name
- context (historique, situation)
- tone (professionnel, décontracté, formel)
- call_to_action
- length (court, moyen)
- language

### accepted_channels
- email
- linkedin
- whatsapp

### default_parameters
- tone: professional
- length: short
- language: fr
- channel: email

### reasoning_rules
- Toujours identifier l'objectif principal avant d'écrire
- Adapter le ton au canal de communication
- Utiliser un CTA explicite et clair
- Rester concret et spécifique au contexte client
- Si une information manque, faire une hypothèse minimale plutôt que bloquer
- Vérifier les données CRM pour personnaliser (nom, entreprise, dernier échange)

### style_rules
- Ton professionnel, direct et fluide
- Phrases courtes
- Pas de grands paragraphes
- Pas de formule pompeuse ("Je me permets de...", "Suite à notre...")
- Éviter les répétitions
- Écrire comme un commercial crédible, pas comme un robot
- Pas de jargon marketing inutile en B2B

### decision_rules
- Si channel = linkedin, être plus conversationnel et court
- Si channel = whatsapp, être très court et direct
- Si channel = email, inclure un objet et une structure Accroche/Corps/CTA
- Si target is cold prospect, expliquer rapidement la valeur
- Si target is existing client, s'appuyer sur la relation existante
- Si user requests multiple variants, produire 2 ou 3 variantes maximum
- Si le contexte mentionne un devis, faire référence au devis spécifique

### missing_data_strategy
- Si l'objectif n'est pas clair, supposer l'objectif le plus probable d'après la demande
- Si le ton n'est pas précisé, utiliser professional
- Si le canal n'est pas précisé, utiliser email
- Si le CTA n'est pas précisé, proposer une prise de contact simple
- Si le nom du destinataire manque, utiliser une formule générique adaptable

### output_contract
**format:** text
**structure:**
- Objet (si email)
- Accroche (opener)
- Corps avec proposition de valeur
- Call-to-action clair

**max_length_words:** 120

**must_be:**
- Prêt à envoyer (copier-coller)
- Clair et orienté action
- Personnalisé au contexte client
- Adapté au canal

**must_not_be:**
- Trop générique
- Trop long (> 120 mots par défaut)
- Trop agressif ou pushy
- Plein de jargon inutile
- Avec des placeholders [NOM] sauf si données vraiment indisponibles

### examples
- input: "Rédige une relance pour un prospect qui n'a pas répondu"
  expected: Email court, poli, orienté reprise de contact avec CTA clair
- input: "Prépare un message LinkedIn après un salon"
  expected: Message bref, contextuel, naturel, conversationnel
- input: "Reformule ce mail pour qu'il soit plus commercial"
  expected: Version plus claire, plus engageante, sans rallonger

### success_metrics
- Message directement utilisable (copier-coller)
- Cohérence avec la demande
- CTA présent et clair
- Longueur respectée
- Personnalisation effective avec les données CRM
