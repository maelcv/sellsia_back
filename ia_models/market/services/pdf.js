/**
 * HTML → PDF via Puppeteer.
 * Uses a singleton browser to amortize launch cost across runs.
 */
import fs from "fs";
import { execSync } from "child_process";
import puppeteer from "puppeteer";

function findChromiumExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  const candidates = [
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/snap/bin/chromium",
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  try {
    const found = execSync("which chromium-browser 2>/dev/null || which chromium 2>/dev/null", { stdio: ["pipe", "pipe", "ignore"] }).toString().trim();
    if (found) return found;
  } catch {}
  return undefined;
}

let browserPromise = null;

async function getBrowser() {
  if (browserPromise) return browserPromise;
  browserPromise = puppeteer.launch({
    headless: true,
    executablePath: findChromiumExecutable(),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
      "--font-render-hinting=none",
    ],
  });
  browserPromise.catch(() => {
    browserPromise = null;
  });
  return browserPromise;
}

export async function closeBrowser() {
  if (!browserPromise) return;
  try {
    const b = await browserPromise;
    await b.close();
  } catch {
    // ignore
  }
  browserPromise = null;
}

/**
 * Render an HTML string to a PDF Buffer (A4, full-bleed).
 */
export async function generatePDF(htmlContent) {
  const browser = await getBrowser();
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
  }
}
