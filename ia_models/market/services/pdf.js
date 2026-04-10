/**
 * HTML → PDF converter.
 * Strategy:
 *   1. wkhtmltopdf CLI (Linux server — no browser required)
 *   2. Puppeteer (local dev / Mac fallback)
 */
import fs from "fs";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
let wkhtmltopdfAvailabilityPromise = null;

/**
 * Check if wkhtmltopdf is available on this system.
 */
async function isWkhtmltopdfAvailable() {
  if (!wkhtmltopdfAvailabilityPromise) {
    wkhtmltopdfAvailabilityPromise = execFileAsync("wkhtmltopdf", ["--version"], { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
  }
  return wkhtmltopdfAvailabilityPromise;
}

/**
 * Generate PDF via wkhtmltopdf CLI (no browser, works on headless Linux).
 */
async function generatePDFviaWkhtmltopdf(htmlContent) {
  const tmpDir = os.tmpdir();
  const inputPath = path.join(tmpDir, `report-${Date.now()}.html`);
  const outputPath = path.join(tmpDir, `report-${Date.now()}.pdf`);

  try {
    await fs.promises.writeFile(inputPath, htmlContent, "utf8");
    await execFileAsync("wkhtmltopdf", [
      "--page-size", "A4",
      "--margin-top", "0mm",
      "--margin-right", "0mm",
      "--margin-bottom", "0mm",
      "--margin-left", "0mm",
      "--print-media-type",
      "--enable-local-file-access",
      "--quiet",
      inputPath,
      outputPath,
    ], { timeout: 60000 });

    const pdf = await fs.promises.readFile(outputPath);
    return pdf;
  } finally {
    fs.promises.unlink(inputPath).catch(() => {});
    fs.promises.unlink(outputPath).catch(() => {});
  }
}

/**
 * Generate PDF via Puppeteer (local dev / Mac).
 */
async function generatePDFviaPuppeteer(htmlContent) {
  const { default: puppeteer } = await import("puppeteer");
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--font-render-hinting=none",
    ],
  });
  const page = await browser.newPage();
  try {
    await page.setContent(htmlContent, { waitUntil: "networkidle0", timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    const pdf = await page.pdf({
      format: "A4",
      margin: { top: "0mm", right: "0mm", bottom: "0mm", left: "0mm" },
      printBackground: true,
      preferCSSPageSize: false,
    });
    return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/**
 * Render an HTML string to a PDF Buffer (A4).
 * Uses wkhtmltopdf on Linux servers, Puppeteer on Mac/local dev.
 */
export async function generatePDF(htmlContent) {
  if (await isWkhtmltopdfAvailable()) {
    return generatePDFviaWkhtmltopdf(htmlContent);
  }
  return generatePDFviaPuppeteer(htmlContent);
}

// No-op kept for API compatibility
export async function closeBrowser() {}
