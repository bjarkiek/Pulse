// Captures the /help manual screenshots by driving the REAL Driver.js tours in
// a browser: for every tour step it calls window.tourEngine.start(key, step),
// waits for the spotlight + popover, and screenshots the page — so the manual
// shows exactly what users see, highlight included.
//
// Prereqs:
//   npm i -D playwright && npx playwright install chromium
//   dev server running in memory mode (npm run dev) — fresh start recommended
//   so every tour shows as "not started" in the help-menu screenshot.
// Run:
//   node scripts/capture-help-screenshots.mjs [baseUrl]
//
// Notes: progress POSTs are blocked at the network layer, so capturing never
// writes tour progress to the server (the glue swallows the failures by design).

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.argv[2] || process.env.HELP_BASE_URL || "http://localhost:3000";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "help");
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
// keep capture side-effect free — no tour progress lands on the server
// (route interception AND a client-side fetch patch: one stray write otherwise
// slips through during the very first hydration)
await context.route("**/api/v1/tours/progress", (route) => route.abort());
await context.addInitScript(() => {
  const original = window.fetch;
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.includes("/api/v1/tours/progress"))
      return Promise.reject(new TypeError("blocked during help capture"));
    return original(input, init);
  };
  // hide the Next dev-overlay badge (it sits over the help button and would
  // pollute every screenshot) and the resume chip (state noise)
  addEventListener("DOMContentLoaded", () => {
    const style = document.createElement("style");
    style.textContent =
      "nextjs-portal{display:none !important}.tour-resume-chip{display:none !important}";
    document.head.appendChild(style);
  });
});
const page = await context.newPage();

async function freshPage() {
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-tour='tour-help']", { timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.tourEngine));
  await page.evaluate(() => window.tourEngine.stop()); // kill any auto-started tour
  await page.waitForTimeout(300);
}

await freshPage();

const state = await page.evaluate(() =>
  fetch("/api/v1/tours/state").then((response) => response.json()),
);
const tours = state.item.tours;
if (!tours.length) {
  console.error("No tours in state — is the master switch off or the user ineligible?");
  process.exit(1);
}
console.log(`Capturing ${tours.reduce((n, t) => n + t.steps.length, 0)} steps across ${tours.length} tours…`);

for (const tour of tours) {
  await freshPage(); // reset view/modals between tours (e.g. the composer)
  for (let index = 0; index < tour.steps.length; index++) {
    await page.evaluate(
      ([key, at]) => {
        window.tourEngine.stop();
        window.tourEngine.start(key, at);
      },
      [tour.key, index],
    );
    await page.waitForSelector(".driver-popover", { state: "visible", timeout: 15_000 });
    await page.waitForTimeout(900); // spotlight animation + view/modal settle
    const file = join(OUT, `${tour.key}-step-${index + 1}.png`);
    await page.screenshot({ path: file });
    console.log(`  ${tour.key} step ${index + 1}/${tour.steps.length}`);
  }
  await page.evaluate(() => window.tourEngine.stop());
}

// The help menu itself, open, with every tour listed.
await freshPage();
await page.click("[data-tour='tour-help']");
await page.waitForSelector(".tour-menu", { state: "visible" });
await page.waitForTimeout(300);
await page.screenshot({ path: join(OUT, "help-menu.png") });
console.log("  help-menu");

await browser.close();
console.log(`Done → ${OUT}`);
