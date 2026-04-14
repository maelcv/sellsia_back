/**
 * PDF Generator — Wraps the market PDF service for the generate_pdf tool.
 * Converts { content, title, subtitle } → PDF file saved in data/reports/.
 * Returns { fileId, filename } consumed by GET /api/chat/download/:fileId.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { generatePDF as renderPDF } from "../../services/market/services/pdf.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = path.resolve(__dirname, "../../../data/reports");

/**
 * Build a simple HTML document from markdown-like content.
 * Converts newlines to <br>, **bold**, and `code` spans.
 */
function contentToHtml(content, title, subtitle) {
  const escapeHtml = (str) =>
    str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

  const renderLine = (line) => {
    let html = escapeHtml(line);
    // Bold: **text**
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    // Inline code: `text`
    html = html.replace(/`(.+?)`/g, "<code>$1</code>");
    return html;
  };

  const lines = content.split("\n");
  let body = "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      body += "<br/>";
    } else if (trimmed.startsWith("### ")) {
      body += `<h3>${renderLine(trimmed.slice(4))}</h3>`;
    } else if (trimmed.startsWith("## ")) {
      body += `<h2>${renderLine(trimmed.slice(3))}</h2>`;
    } else if (trimmed.startsWith("# ")) {
      body += `<h1>${renderLine(trimmed.slice(2))}</h1>`;
    } else if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      body += `<li>${renderLine(trimmed.slice(2))}</li>`;
    } else {
      body += `<p>${renderLine(trimmed)}</p>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8"/>
  <style>
    body { font-family: Arial, sans-serif; font-size: 13px; color: #1a1a1a; padding: 40px; }
    h1 { font-size: 22px; color: #1d4ed8; margin-bottom: 4px; }
    h2 { font-size: 17px; color: #1d4ed8; margin-top: 24px; }
    h3 { font-size: 14px; margin-top: 16px; }
    .subtitle { color: #6b7280; font-size: 13px; margin-bottom: 28px; }
    p { margin: 6px 0; line-height: 1.6; }
    li { margin: 4px 0 4px 20px; line-height: 1.6; }
    code { background: #f3f4f6; padding: 1px 4px; border-radius: 3px; font-size: 12px; }
    strong { font-weight: 600; }
  </style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  ${subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : ""}
  ${body}
</body>
</html>`;
}

/**
 * Generate a PDF from structured content.
 * @param {{ content: string, title: string, subtitle?: string }} params
 * @returns {Promise<{ fileId: string, filename: string }>}
 */
export async function generatePDF({ content, title, subtitle = "" }) {
  // Ensure output directory exists
  await fs.promises.mkdir(REPORTS_DIR, { recursive: true });

  const fileId = randomUUID();
  const filename = `rapport-${fileId.slice(0, 8)}.pdf`;
  const outputPath = path.join(REPORTS_DIR, filename);

  const html = contentToHtml(content, title, subtitle);
  const pdfBuffer = await renderPDF(html);

  await fs.promises.writeFile(outputPath, pdfBuffer);

  return { fileId, filename };
}
