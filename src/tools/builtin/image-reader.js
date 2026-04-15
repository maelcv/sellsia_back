/**
 * ImageReaderSubAgent — Analyze images using vision models
 *
 * Features:
 * - Support for providers with vision capabilities (GPT-4o, Claude)
 * - Extract text, objects, and insights from images
 * - Graceful fallback if provider doesn't support vision
 */

import { BaseSubAgent } from "./base-sub-agent.js";

export class ImageReaderSubAgent extends BaseSubAgent {
  constructor(provider) {
    const systemPrompt = `Tu es un sous-agent specialise dans l'analyse d'images.

ROLE : Analyser une image fournie par l'utilisateur et repondre a sa question a ce sujet.

PROCESSUS :
1. Examine l'image avec attention
2. Identifie les elements pertinents pour repondre a la demande
3. Extrait le texte visible, les objets, les personnes, les scenes
4. Fournit une analyse structuree et claire

CAPACITES :
- Reconnaissance de texte (OCR)
- Identification d'objets et d'elements
- Analyse de scenes et contexte
- Description de diagrammes et schemas
- Extraction de donnees visuelles`;

    super({
      type: "image_reader",
      provider,
      tools: [], // No tools — direct vision capability
      systemPrompt,
    });
  }

  /**
   * Override execute to handle image analysis
   */
  async execute({ demande, contexte = "", toolContext = {}, thinkingMode = "low", onEvent = null }) {
    try {
      const { uploadedFiles = [] } = toolContext;

      // Find image files
      const imageFiles = uploadedFiles.filter((f) => f.type && f.type.startsWith("image/"));

      if (imageFiles.length === 0) {
        return {
          demande,
          contexte,
          think: "No images provided",
          output: "Aucune image fournie. Veuillez uploader une image pour l'analyser.",
          sources: [],
          tokensInput: 0,
          tokensOutput: 0,
        };
      }

      // Check if provider supports vision
      if (!this.provider.vision) {
        return {
          demande,
          contexte,
          think: "",
          output: `${this.provider.providerName} ne supporte pas l'analyse d'images. Veuillez utiliser un provider avec vision (GPT-4o, Claude, etc.).`,
          sources: [],
          tokensInput: 0,
          tokensOutput: 0,
        };
      }

      // Analyze each image
      const results = [];
      let totalTokensInput = 0;
      let totalTokensOutput = 0;

      for (const imageFile of imageFiles) {
        try {
          const visionResult = await this.provider.vision({
            systemPrompt: this.systemPrompt,
            message: demande,
            imageBase64: imageFile.content,
            imageMediaType: imageFile.type || "image/jpeg",
          });

          results.push({
            filename: imageFile.filename,
            analysis: visionResult.content || "",
          });

          totalTokensInput += visionResult.tokensInput || 0;
          totalTokensOutput += visionResult.tokensOutput || 0;
        } catch (err) {
          console.error(`[ImageReaderSubAgent] Error analyzing ${imageFile.filename}:`, err);
          results.push({
            filename: imageFile.filename,
            analysis: `Erreur lors de l'analyse: ${err.message}`,
          });
        }
      }

      // Format output
      const output = results
        .map((r) => `**${r.filename}**\n${r.analysis}`)
        .join("\n\n");

      return {
        demande,
        contexte,
        think: `Analysé ${imageFiles.length} image(s)`,
        output: output || "Aucune analyse disponible",
        sources: imageFiles.map((f) => `image:${f.filename}`),
        tokensInput: totalTokensInput,
        tokensOutput: totalTokensOutput,
      };
    } catch (err) {
      console.error("[ImageReaderSubAgent] Error:", err);
      return {
        demande,
        contexte,
        think: "",
        output: `Error: ${err.message}`,
        sources: [],
        tokensInput: 0,
        tokensOutput: 0,
      };
    }
  }
}
