/**
 * PDF Generator — Genere un PDF professionnel a partir de contenu markdown.
 * Utilise pdfkit pour la generation.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardDir = resolve(__dirname, "../../dashboard");
const require = createRequire(resolve(dashboardDir, "index.js"));

const REPORTS_DIR = resolve(dashboardDir, "data/reports");

// Ensure reports directory exists
if (!existsSync(REPORTS_DIR)) {
  mkdirSync(REPORTS_DIR, { recursive: true });
}

/**
 * Generate a PDF from markdown content.
 *
 * @param {Object} opts
 * @param {string} opts.content - Markdown content to render
 * @param {string} [opts.title] - Document title
 * @param {string} [opts.subtitle] - Document subtitle
 * @param {string} [opts.author] - Author name
 * @returns {Promise<{ fileId: string, filePath: string, filename: string }>}
 */
export async function generatePDF({ content, title = "Rapport Sellsia", subtitle = "", author = "Sellsia AI" }) {
  const PDFDocument = require("pdfkit");

  return new Promise((resolvePromise, reject) => {
    try {
      const fileId = randomUUID();
      const filename = `rapport-${fileId.slice(0, 8)}.pdf`;
      const filePath = join(REPORTS_DIR, filename);

      const doc = new PDFDocument({
        size: "A4",
        margins: { top: 60, bottom: 60, left: 50, right: 50 },
        info: {
          Title: title,
          Author: author,
          Creator: "Sellsia AI Platform"
        }
      });

      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => {
        const buffer = Buffer.concat(chunks);
        writeFileSync(filePath, buffer);
        resolvePromise({ fileId, filePath, filename });
      });
      doc.on("error", reject);

      // Header
      doc.fontSize(22).font("Helvetica-Bold").text(title, { align: "center" });
      if (subtitle) {
        doc.moveDown(0.3);
        doc.fontSize(12).font("Helvetica").fillColor("#666666").text(subtitle, { align: "center" });
      }
      doc.moveDown(0.3);
      doc.fontSize(9).fillColor("#999999").text(`Genere par ${author} — ${new Date().toLocaleDateString("fr-FR")}`, { align: "center" });
      doc.fillColor("#000000");

      // Separator
      doc.moveDown(1);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke("#CCCCCC");
      doc.moveDown(1);

      // Render markdown content
      _renderMarkdown(doc, content);

      // Footer on each page
      const pageCount = doc.bufferedPageRange();
      doc.fontSize(8).fillColor("#999999");

      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Simple markdown-to-PDF renderer.
 * Supports: headers (#, ##, ###), bold (**), lists (-, *), code blocks (```), paragraphs.
 */
function _renderMarkdown(doc, markdown) {
  if (!markdown) return;

  const lines = markdown.split("\n");
  let inCodeBlock = false;
  let codeBuffer = [];

  for (const line of lines) {
    // Code blocks
    if (line.trim().startsWith("```")) {
      if (inCodeBlock) {
        // End code block
        _renderCodeBlock(doc, codeBuffer.join("\n"));
        codeBuffer = [];
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    const trimmed = line.trim();

    // Empty line = paragraph break
    if (!trimmed) {
      doc.moveDown(0.5);
      continue;
    }

    // Headers
    if (trimmed.startsWith("### ")) {
      doc.moveDown(0.5);
      doc.fontSize(13).font("Helvetica-Bold").text(trimmed.slice(4));
      doc.moveDown(0.3);
      continue;
    }
    if (trimmed.startsWith("## ")) {
      doc.moveDown(0.7);
      doc.fontSize(15).font("Helvetica-Bold").text(trimmed.slice(3));
      doc.moveDown(0.3);
      continue;
    }
    if (trimmed.startsWith("# ")) {
      doc.moveDown(0.8);
      doc.fontSize(18).font("Helvetica-Bold").text(trimmed.slice(2));
      doc.moveDown(0.4);
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(trimmed)) {
      doc.moveDown(0.5);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke("#DDDDDD");
      doc.moveDown(0.5);
      continue;
    }

    // List items
    if (/^[-*]\s/.test(trimmed)) {
      const text = trimmed.slice(2);
      _renderTextWithBold(doc, `  •  ${text}`, 10);
      continue;
    }

    // Numbered list
    if (/^\d+\.\s/.test(trimmed)) {
      _renderTextWithBold(doc, `  ${trimmed}`, 10);
      continue;
    }

    // Regular paragraph
    _renderTextWithBold(doc, trimmed, 10);
  }

  // Flush remaining code block
  if (inCodeBlock && codeBuffer.length > 0) {
    _renderCodeBlock(doc, codeBuffer.join("\n"));
  }
}

/**
 * Render text with **bold** support.
 */
function _renderTextWithBold(doc, text, fontSize = 10) {
  doc.fontSize(fontSize);

  // Split on bold markers
  const parts = text.split(/(\*\*[^*]+\*\*)/);
  let x = doc.x;
  const y = doc.y;

  // Simple approach: just render with font switching
  // For complex cases, fall back to plain rendering
  if (parts.length === 1) {
    doc.font("Helvetica").text(text, { continued: false });
    return;
  }

  // Multi-part with bold
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) continue;

    if (part.startsWith("**") && part.endsWith("**")) {
      doc.font("Helvetica-Bold").text(part.slice(2, -2), { continued: i < parts.length - 1 });
    } else {
      doc.font("Helvetica").text(part, { continued: i < parts.length - 1 });
    }
  }
}

/**
 * Render a code block with background.
 */
function _renderCodeBlock(doc, code) {
  if (!code.trim()) return;

  doc.moveDown(0.3);

  const startY = doc.y;
  doc.fontSize(8).font("Courier").fillColor("#333333");

  // Render code with slight indentation
  const lines = code.split("\n");
  for (const line of lines) {
    doc.text(`  ${line}`);
  }

  doc.fillColor("#000000").font("Helvetica");
  doc.moveDown(0.3);
}
