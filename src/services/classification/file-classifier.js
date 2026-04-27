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

import fs from "fs/promises";
import path from "path";
import {
  writeNote, readNote, getWorkspacePhysicalPath,
  writeRootNote, readRootNote, getGlobalPhysicalPath,
} from "../vault/vault-service.js";
import { prisma } from "../../prisma.js";
import { getProviderForUser } from "../../ai-providers/index.js";
import { indexDocument } from "../memory/vector-service.js";

// ── Text extraction helpers ────────────────────────────────────────

/**
 * Extrait le texte brut d'un fichier uploadé (Buffer multer).
 * @param {object} file — multer file object { buffer, mimetype, originalname }
 * @returns {string} texte extrait (max 8000 chars)
 */
async function extractText(file, provider = null) {
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
        const text = (data.text || "").trim();
        // Image-based PDF: fallback to OCR if provider supports vision
        if (text.length < 50 && provider?.hasCapability("vision")) {
          const base64 = buffer.toString("base64");
          const ocrText = await provider.vision({
            base64, mediaType: "application/pdf",
            prompt: "Extrais tout le texte visible dans ce document PDF (OCR complet)."
          });
          return (ocrText || "").slice(0, MAX_CHARS);
        }
        return text.slice(0, MAX_CHARS);
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

    // PPTX / OpenDocument
    if (
      mimetype.includes("presentationml") || mimetype.includes("ms-powerpoint") ||
      mimetype.includes("opendocument") ||
      originalname.match(/\.(pptx?|odp|odt|ods)$/i)
    ) {
      try {
        const { parseOffice } = await import("officeparser");
        const text = await parseOffice(buffer);
        return (text || "").slice(0, MAX_CHARS);
      } catch {
        return `[Office file: ${originalname}] (text extraction unavailable)`;
      }
    }

    // JSON
    if (mimetype === "application/json" || originalname.endsWith(".json")) {
      try {
        const raw = buffer.toString("utf-8");
        const parsed = JSON.parse(raw);
        return JSON.stringify(parsed, null, 2).slice(0, MAX_CHARS);
      } catch {
        return buffer.toString("utf-8").slice(0, MAX_CHARS);
      }
    }

    // Images — use vision model if available
    if (mimetype.startsWith("image/") && provider?.hasCapability("vision")) {
      const base64 = buffer.toString("base64");
      const result = await provider.vision({
        base64, mediaType: mimetype,
        prompt: "Décris cette image en détail et extrais tout le texte visible (OCR complet)."
      });
      return (result || "").slice(0, MAX_CHARS);
    }

    // Audio — use audio transcription if available
    if (mimetype.startsWith("audio/") && provider?.hasCapability("audio")) {
      const transcription = await provider.audio({ buffer, mimeType: mimetype });
      return (transcription || "").slice(0, MAX_CHARS);
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
    const result = await provider.chat({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.1,
      maxTokens: 600
    });
    const rawResponse = result?.content || "";
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

// ── Raw File Persistence ──────────────────────────────────────────

async function saveRawFile(workspaceId, userId, file) {
  const destPath = getWorkspacePhysicalPath(workspaceId, String(userId), "Uploads", file.originalname);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, file.buffer);
}

async function saveAdminRawFile(userId, file) {
  const destPath = getGlobalPhysicalPath("Admins", String(userId), "Uploads", file.originalname);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, file.buffer);
}

// ── Manifest helpers ──────────────────────────────────────────────

function buildManifestLine(notePath, originalName, category, sizeBytes, uploadedAt) {
  const dateLabel = (uploadedAt || new Date().toISOString()).split("T")[0];
  const sizeKo = Math.round(sizeBytes / 1024);
  const noteLink = `[[${notePath.replace(/\.md$/, "")}|${originalName}]]`;
  return `- ${noteLink} — ${category || "autre"} — ${sizeKo} Ko — ${dateLabel}`;
}

// Workspace manifest — uses writeNote/readNote (scoped to workspaceId)
async function updateUploadsManifest(workspaceId, userId, { originalName, sizeBytes, category, notePath, uploadedAt }) {
  const manifestPath = `${userId}/Uploads/manifest.md`;
  const now = uploadedAt || new Date().toISOString();

  let existing = null;
  try {
    existing = (await readNote(workspaceId, manifestPath))?.content || null;
  } catch { existing = null; }

  if (!existing) existing = `---\nlastUpdated: ${now}\n---\n\n# Manifest des Fichiers Uploadés\n\n`;

  const updated = existing
    .replace(/lastUpdated: .*/, `lastUpdated: ${now}`)
    .trimEnd() + "\n" + buildManifestLine(notePath, originalName, category, sizeBytes, uploadedAt) + "\n";

  await writeNote(workspaceId, manifestPath, updated);
}

// Admin manifest — uses writeRootNote/readRootNote (Global scope)
async function updateAdminUploadsManifest(userId, { originalName, sizeBytes, category, notePath, uploadedAt }) {
  const manifestPath = `Global/Admins/${userId}/Uploads/manifest.md`;
  const now = uploadedAt || new Date().toISOString();

  let existing = null;
  try {
    existing = (await readRootNote(manifestPath))?.content || null;
  } catch { existing = null; }

  if (!existing) existing = `---\nlastUpdated: ${now}\n---\n\n# Manifest des Fichiers Admin Uploadés\n\n`;

  const updated = existing
    .replace(/lastUpdated: .*/, `lastUpdated: ${now}`)
    .trimEnd() + "\n" + buildManifestLine(notePath, originalName, category, sizeBytes, uploadedAt) + "\n";

  await writeRootNote(manifestPath, updated);
}

// ── Shared classification core ────────────────────────────────────

async function runClassification(file, userId, conversationId, agentId, uploadedByName, scope = "workspace") {
  const uploadedAt = new Date().toISOString();
  const provider = await getProviderForUser(userId);
  // Reuse pre-extracted text if provided (avoids duplicate vision/audio API calls)
  const text = file._preExtractedText || await extractText(file, provider);

  let classification = null;
  if (provider && text && !text.startsWith("[File:")) {
    classification = await classifyWithAI(provider, file.originalname, text);
  }

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
        scope,
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

    // Index in MemorySemantic for vector search (best-effort, fire-and-forget)
    getProviderForUser(userId).then((provider) => {
      if (provider) {
        indexDocument({
          content: text.slice(0, 10000),
          summary: classification?.summary ?? null,
          workspaceId: workspaceId ?? null,
          userId,
          agentId: agentId ?? null,
          conversationId: conversationId ?? null,
        }, provider).catch(() => {});
      }
    }).catch(() => {});
  }

  const noteContent = buildMarkdownNote({ file, classification, uploadedByName, conversationId, knowledgeDocId });
  return { classification, knowledgeDocId, noteContent, uploadedAt, extractedText: text };
}

// ── Main Entry Point ──────────────────────────────────────────────

/**
 * Classifie et indexe un fichier uploadé en chat.
 * Appeler en fire-and-forget après le stream SSE.
 *
 * @param {object} options.file          — multer file object
 * @param {number} options.userId        — ID utilisateur
 * @param {string|null} options.workspaceId — null pour les admins
 * @param {string} options.conversationId
 * @param {string} options.agentId
 * @param {object} options.user          — { id, email, name }
 */
export async function classifyUploadedFile({
  file, userId, workspaceId, conversationId, agentId, user
}) {
  try {
    if (!file) return;

    const uploadedByName = user?.name || user?.email || `User ${userId}`;
    const sizeBytes = file.size || file.buffer?.length || 0;
    const isAdmin = !workspaceId;

    if (isAdmin) {
      // ── Admin mode: Global/Admins/<userId>/Uploads/ ──
      const now = new Date();
      const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const slug = toSlug(file.originalname);
      const vaultPath = `Global/Admins/${userId}/Uploads/${month}/${slug}.md`;

      // 0. Persist raw file
      await saveAdminRawFile(userId, file);

      // 1–5. Extract + classify + build note
      const { classification, knowledgeDocId, noteContent, uploadedAt, extractedText } = await runClassification(
        file, userId, conversationId, agentId, uploadedByName, "admin"
      );

      // 6. Write metadata note
      await writeRootNote(vaultPath, noteContent);

      // 7. Update manifest
      await updateAdminUploadsManifest(userId, {
        originalName: file.originalname,
        sizeBytes,
        category: classification?.category || null,
        notePath: vaultPath,
        uploadedAt
      });

      console.log(`[FileClassifier:admin] "${file.originalname}" → vault:${vaultPath} knowledgeDoc:${knowledgeDocId}`);
      return { vaultPath, classification, knowledgeDocId, extractedText, isAdmin: true };
    } else {
      // ── Workspace mode: Workspaces/<wsId>/<userId>/Uploads/ ──
      const vaultPath = getUploadVaultPath(userId, file.originalname);

      // 0. Persist raw file
      await saveRawFile(workspaceId, userId, file);

      // 1–5. Extract + classify + build note
      const { classification, knowledgeDocId, noteContent, uploadedAt, extractedText } = await runClassification(
        file, userId, conversationId, agentId, uploadedByName
      );

      // 6. Write metadata note
      await writeNote(workspaceId, vaultPath, noteContent);

      // 7. Update manifest
      await updateUploadsManifest(workspaceId, userId, {
        originalName: file.originalname,
        sizeBytes,
        category: classification?.category || null,
        notePath: vaultPath,
        uploadedAt
      });

      // 8. Persist UploadedFileRef (workspace only — no nullable workspaceId in schema)
      await prisma.uploadedFileRef.create({
        data: {
          workspaceId,
          uploadedById: userId,
          originalName: file.originalname,
          mimeType: file.mimetype,
          sizeBytes,
          classificationJson: classification ? JSON.stringify(classification) : null,
          vaultPath,
          knowledgeDocId,
          conversationId: conversationId || null
        }
      });

      console.log(`[FileClassifier:ws] "${file.originalname}" → vault:${vaultPath} knowledgeDoc:${knowledgeDocId}`);
      return { vaultPath, classification, knowledgeDocId, extractedText, isAdmin: false };
    }
  } catch (err) {
    console.warn("[FileClassifier] Non-critical error:", err.message);
    return null;
  }
}
