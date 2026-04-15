-- Migration: add_workflow_definition_json
-- Ajoute le champ definition_json (nullable) au modèle Automation
-- Format: { nodes: WorkflowNode[], edges: WorkflowEdge[] } (Visual Builder)
-- Null = automation legacy utilisant l'ancien champ steps[]

ALTER TABLE "automations" ADD COLUMN "definition_json" TEXT;
