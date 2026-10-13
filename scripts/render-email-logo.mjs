// Rasterises the black-text wordmark for email clients that cannot render SVG.
// Usage: node scripts/render-email-logo.mjs  → public/email/datacentral-logo.png (340px wide, 2x)
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";
const svg = readFileSync("public/brand/datacentral-blacktext.svg", "utf8");
mkdirSync("public/email", { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 340, height: 120 }, deviceScaleFactor: 1 });
await page.setContent(`<html><body style="margin:0;background:#fff"><div id="logo" style="width:340px">${svg.replace(/<svg /, '<svg style="width:340px;height:auto" ')}</div></body></html>`);
const box = await page.locator("#logo svg").boundingBox();
await page.locator("#logo svg").screenshot({ path: "public/email/datacentral-logo.png", omitBackground: false });
console.log(`rendered ${Math.round(box.width)}x${Math.round(box.height)}`);
await browser.close();
