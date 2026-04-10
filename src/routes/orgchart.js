import { Router } from "express";
import { z } from "zod";
import { prisma } from "../prisma.js";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { decryptSecret } from "../security/secrets.js";
import { MistralProvider } from "../../ia_models/providers/mistral.js";

const router = Router();

const EXTRACT_PROMPT = `Analysez cette image d'organigramme et extrayez les informations hiérarchiques.

Retournez UNIQUEMENT un objet JSON valide (pas de texte avant ou après) qui suit cette structure:
{
  "organisation": {
    "nom": "Nom de l'organisation ou département racine",
    "pdg": {
      "nom": "Nom du responsable principal",
      "titre": "Titre/Poste",
      "subordonnés": [
        {
          "nom": "Nom du subordonné",
          "titre": "Titre/Poste",
          "subordonnés": []
        }
      ]
    }
  }
}

Instructions:
- Extrayez uniquement les noms et titres visibles
- Respectez la hiérarchie: responsable principal -> subordonnés directs
- Si aucune hiérarchie claire, créez une structure simple avec un responsable
- Les champs "subordonnés" doivent toujours être un tableau (vide si pas de subordonnés)
- Retournez UNIQUEMENT le JSON, rien d'autre`;

/**
 * POST /api/onboarding/orgchart/extract
 * Extract org chart from image using Mistral vision
 */
router.post("/extract", requireAuth, requireRole("admin"), async (req, res) => {
  try {
    const { imageBase64, mimeType } = z
      .object({
        imageBase64: z.string().min(10),
        mimeType: z.string().default("image/jpeg"),
      })
      .parse(req.body);

    // Get default AI provider config
    const defaultProviderSetting = await prisma.systemSetting.findUnique({
      where: { key: "default_ai_provider" },
    });

    if (!defaultProviderSetting) {
      return res.status(400).json({
        error: "Aucun provider IA configuré. Veuillez définir un provider par défaut dans les paramètres.",
      });
    }

    let providerConfig;
    try {
      providerConfig = JSON.parse(defaultProviderSetting.value);
    } catch {
      return res.status(400).json({
        error: "Configuration provider invalide",
      });
    }

    // Decrypt API key
    let apiKey = null;
    if (providerConfig.apiKeyEncrypted) {
      try {
        apiKey = decryptSecret(providerConfig.apiKeyEncrypted);
      } catch (err) {
        console.error("[orgchart] Failed to decrypt API key:", err.message);
        return res.status(400).json({
          error: "Impossible de décrypter la clé API du provider",
        });
      }
    } else {
    }

    if (!apiKey) {
      return res.status(400).json({
        error: "Clé API du provider non configurée",
      });
    }

    // Determine the model to use
    // Priority: 1) provider's specified model, 2) default model, 3) fallback
    const modelToUse = providerConfig.model ||
                       providerConfig.defaultModel ||
                       "mistral-large-latest"; // fallback for Mistral

    // Note: OCR extraction requires a provider with vision capabilities (Mistral, Claude, etc.)
    // Currently configured to use Mistral. The provider code should support vision models.
    const provider = new MistralProvider({
      apiKey,
      defaultModel: modelToUse,
    });

    // Call the provider's chat API with vision support
    console.log("[orgchart] Calling Mistral vision API...");
    const response = await provider.chat({
      model: modelToUse,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: EXTRACT_PROMPT },
            {
              type: "image_url",
              image_url: { url: `data:${mimeType};base64,${imageBase64}` },
            },
          ],
        },
      ],
      systemPrompt: "Vous êtes un expert en extraction de données d'images. Vous devez extraire les informations d'un organigramme et retourner un JSON valide.",
      temperature: 0.2,
      maxTokens: 2048,
    });

    // Parse the response JSON
    console.log("[orgchart] Mistral response received, length:", response.content.length);
    console.log("[orgchart] Response content (first 500 chars):", response.content.substring(0, 500));

    let orgChartData;
    try {
      // Try to extract JSON from the response (in case there's extra text)
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in response");
      }
      orgChartData = JSON.parse(jsonMatch[0]);
      console.log("[orgchart] Successfully parsed org chart data");
    } catch (parseErr) {
      console.error("[orgchart] Failed to parse Mistral response:", response.content);
      return res.status(400).json({
        error: "Impossible de parser la réponse. Assurez-vous que l'image contient un organigramme lisible.",
      });
    }

    console.log("[orgchart] Sending success response");
    return res.json({
      success: true,
      orgChart: orgChartData,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.error("[orgchart] Validation error:", err.errors[0].message);
      return res.status(400).json({ error: err.errors[0].message });
    }
    console.error("[orgchart] Extract error:", err.message || err);
    console.error("[orgchart] Full error:", err);
    return res.status(500).json({ error: err.message || "Erreur lors de l'extraction de l'organigramme" });
  }
});

export default router;
