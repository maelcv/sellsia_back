/**
 * file-classifier.js — Classification automatique des fichiers uploadés en chat (Boatswain V1)
 *
 * Déclenché en fire-and-forget après chaque upload de fichier dans le chat SSE.
 *
 * Flow :
 *   1. Extraire le texte du fichier (PDF → text, CSV → preview, DOCX → text, TXT → direct)
 *   2. Appeler l'IA pour classifier : catégorie, mots-clés, résumé, 3 points clés
 *   3. Créer une note markdown dans Workspaces/<wsId>/Uploads/<YYYY-MM>/<slug>.md
 *   4. Créer un KnowledgeDocument (pour la RAG) lié à l'agent de la conversation
 *   5. Persister l'enregistrement UploadedFileRef en base
 */

import { writeNote } from "../vault/vault-service.js";
import { prisma } from "../../prisma.js";
import { getProviderForUser } from "../../ai-providers/index.js";

// ── Text extraction helpers ────────────────────────────────────────

/**
 * Extrait le texte brut d'un fichier uploadé (Buffer multer).
 * @param {object} file — multer file object { buffer, mimetype, originalname }
 * @returns {string} texte extrait (max 8000 chars)
 */
async function extractText(file) {
  const { buffer, mimetype, originalname } = file;
  const MAX_CHARS = 8000;

  try {
    // Plain text / CSV
    if (mimetype === "text/plain" || mimetype === "text/csv" ||
        originalname.endsWith(".txt") || originalname.endsWith(".csv")) {
      return buffer.toString("utf-8").slice(0, MAX_CHARS);
    }

    // PDF — use pdf-parse if available, else return base64 excerpt
    if (mimetype === "application/pdf" || originalname.endsWith(".pdf")) {
      try {
        const pdfParse = (await import("pdf-parse")).default;
        const data = await pdfParse(buffer);
        return (data.text || "").slice(0, MAX_CHARS);
      } catch {
        return `[PDF file: ${originalname}] (text extraction unavailable)`;
      }
    }

    // XLSX/XLS — extract first sheet preview
    if (mimetype.includes("spreadsheet") || originalname.match(/\.xlsx?$/i)) {
      try {
        const XLSX = (await import("xlsx")).default;
        const workbook = XLSX.read(buffer, { type: "buffer" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        return csv.slice(0, MAX_CHARS);
      } catch {
        return `[Excel file: ${originalname}] (preview unavailable)`;
      }
    }

    // DOCX
    if (mimetype.includes("wordprocessingml") || originalname.match(/\.docx?$/i)) {
      try {
        const mammoth = (await import("mammoth")).default;
        const result = await mammoth.extractRawText({ buffer });
        return result.value.slice(0, MAX_CHARS);
      } catch {
        return `[Word document: ${originalname}] (text extraction unavailable)`;
      }
    }

    return `[File: ${originalname}] (unsupported format for text extraction)`;
  } catch (err) {
    console.warn("[FileClassifier] Text extraction error:", err.message);
    return `[File: ${originalname}]`;
  }
}

/**
 * Génère un slug URL-safe depuis un nom de fichier.
 */
function toSlug(filename) {
  return filename
    .toLowerCase()
    .replace(/\.[^.]+$/, "") // remove extension
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/**
 * Retourne le chemin vault du mois courant pour les uploads.
 */
function getUploadVaultPath(userId, filename) {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const slug = toSlug(filename);
  return `${userId}/Uploads/${month}/${slug}.md`;
}

// ── AI Classification ─────────────────────────────────────────────

/**
 * Appelle l'IA pour classifier le fichier.
 */
async function classifyWithAI(provider, filename, text) {
  const prompt = `You are a document classification assistant. Analyze the following file content and respond ONLY with a valid JSON object (no markdown, no explanation).

File: ${filename}
Content excerpt:
---
${text.slice(0, 4000)}
---

Required JSON format:
{
  "category": "one of: rapport-financier | contrat | présentation | données | facture | email | technique | juridique | marketing | autre",
  "subcategory": "more specific label",
  "keywords": ["keyword1", "keyword2", "keyword3", "keyword4", "keyword5"],
  "summary": "One paragraph describing what this document is about",
  "keyPoints": ["Point 1", "Point 2", "Point 3"],
  "language": "fr|en|es|de|other",
  "sensitivity": "public|internal|confidential"
}`;

  try {
    let rawResponse = "";
    for await (const chunk of provider.stream([
      { role: "user", content: prompt }
    ], { model: provider.config.defaultModel, temperature: 0.1, maxTokens: 600 })) {

      if (chunk.type === "text") rawResponse += chunk.content;
    }

    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (err) {
    console.warn("[FileClassifier] AI classification error:", err.message);
    return null;
  }
}

// ── Note Markdown Generation ──────────────────────────────────────

function buildMarkdownNote({ file, classification, uploadedByName, conversationId, knowledgeDocId }) {
  const now = new Date();
  const dateStr = now.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
  const timeStr = now.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  const slug = toSlug(file.originalname);

  const fm = [
    "---",
    `title: "${file.originalname}"`,
    `originalName: "${file.originalname}"`,
    `slug: "${slug}"`,
    `uploadedBy: "${uploadedByName}"`,
    `uploadedAt: "${now.toISOString()}"`,
    `mimeType: "${file.mimetype}"`,
    `sizeBytes: ${file.size || file.buffer?.length || 0}`,
    classification?.category ? `category: "${classification.category}"` : "",
    classification?.subcategory ? `subcategory: "${classification.subcategory}"` : "",
    classification?.keywords?.length ? `tags: [${classification.keywords.map(k => `"${k}"`).join(", ")}]` : "",
    classification?.sensitivity ? `sensitivity: "${classification.sensitivity}"` : "",
    knowledgeDocId ? `knowledgeDocId: ${knowledgeDocId}` : "",
    conversationId ? `conversationId: "${conversationId}"` : "",
    "---",
  ].filter(Boolean).join("\n");

  const body = `
# ${file.originalname}

> **Catégorie** : ${classification?.category || "Non classifié"}${classification?.subcategory ? ` › ${classification.subcategory}` : ""}  
> **Uploadé par** : ${uploadedByName} · ${dateStr} à ${timeStr}  
> **Taille** : ${Math.round((file.size || file.buffer?.length || 0) / 1024)} Ko · **Langue** : ${classification?.language || "?"}

## Résumé
${classification?.summary || "_Résumé non disponible_"}

## Points Clés
${classification?.keyPoints?.length ? classification.keyPoints.map(p => `- ${p}`).join("\n") : "_Aucun point clé détecté_"}

## Mots-clés
${classification?.keywords?.length ? classification.keywords.join(", ") : "_Aucun_"}

## Liens
${knowledgeDocId ? `- Base de connaissances : référence #${knowledgeDocId}` : ""}
${conversationId ? `- Source : conversation \`${conversationId}\`` : ""}
`;

  return fm + "\n" + body;
}

// ── Main Entry Point ──────────────────────────────────────────────

/**
 * Classifie et indexe un fichier uploadé en chat.
 * Appeler en fire-and-forget après le stream SSE.
 *
 * @param {object} options
 * @param {object} options.file          — multer file object
 * @param {number} options.userId        — ID utilisateur
 * @param {string} options.workspaceId   — ID workspace
 * @param {string} options.conversationId
 * @param {string} options.agentId       — agent actif dans la conversation
 * @param {object} options.user          — { id, email, name, companyName }
 */
export async function classifyUploadedFile({
  file, userId, workspaceId, conversationId, agentId, user
}) {
  try {
    if (!file || !workspaceId) return;

    const uploadedByName = user?.name || user?.email || `User ${userId}`;
    const vaultPath = getUploadVaultPath(userId, file.originalname);

    // 1. Extract text
    const text = await extractText(file);

    // 2. Get provider for classification
    const provider = await getProviderForUser(userId);

    // 3. Classify with AI (optional — skip if no provider)
    let classification = null;
    if (provider && text && !text.startsWith("[File:")) {
      classification = await classifyWithAI(provider, file.originalname, text);
    }

    // 4. Create KnowledgeDocument for RAG
    let knowledgeDocId = null;
    if (text && text.length > 50) {
      const docTitle = classification?.summary
        ? `${file.originalname} — ${classification.summary.slice(0, 100)}`
        : file.originalname;

      const knowledgeDoc = await prisma.knowledgeDocument.create({
        data: {
          clientId: userId,
          agentId: agentId || null,
          title: docTitle,
          content: text.slice(0, 10000),
          docType: "text",
          scope: "workspace",
          metadataJson: JSON.stringify({
            source: "chat_upload",
            originalName: file.originalname,
            mimeType: file.mimetype,
            conversationId,
            classification
          }),
          isActive: true
        }
      });
      knowledgeDocId = knowledgeDoc.id;
    }

    // 5. Write vault note
    const noteContent = buildMarkdownNote({
      file,
      classification,
      uploadedByName,
      conversationId,
      knowledgeDocId
    });

    await writeNote(workspaceId, vaultPath, noteContent);

    // 6. Persist UploadedFileRef
    await prisma.uploadedFileRef.create({
      data: {
        workspaceId,
        uploadedById: userId,
        originalName: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size || file.buffer?.length || 0,
        classificationJson: classification ? JSON.stringify(classification) : null,
        vaultPath,
        knowledgeDocId,
        conversationId: conversationId || null
      }
    });

    console.log(`[FileClassifier] Classified "${file.originalname}" → vault:${vaultPath} knowledgeDoc:${knowledgeDocId}`);
  } catch (err) {
    // Never throw — this is fire-and-forget
    console.warn("[FileClassifier] Non-critical error:", err.message);
  }
}
