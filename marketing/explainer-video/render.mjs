// Renders player.html to MP4, one frame at a time, so no frame is ever dropped.
//   node marketing/explainer-video/render.mjs            all three cuts
//   node marketing/explainer-video/render.mjs customers  one cut
//   node marketing/explainer-video/render.mjs --stills   only the check frames (out/stills)
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "out");
const FPS = 30;
const args = process.argv.slice(2);
const stillsOnly = args.includes("--stills");
const names = args.filter((a) => !a.startsWith("--"));
const cuts = names.length ? names : ["overview", "customers", "team"];
mkdirSync(join(out, "stills"), { recursive: true });

const browser = await chromium.launch();
for (const cut of cuts) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(pathToFileURL(join(here, "player.html")).href + `?v=${cut}&capture`);
  await page.evaluate(() => document.fonts.ready);
  const duration = await page.evaluate(() => window.DURATION);
  const starts = await page.evaluate(() => scenes.map((s) => [s.start, s.dur]));

  // One still per scene, taken late in the scene when everything is on screen.
  for (const [i, [start, dur]] of starts.entries()) {
    await page.evaluate((t) => window.renderAt(t), start + dur - 0.6);
    await page.screenshot({ path: join(out, "stills", `${cut}-${i + 1}.png`) });
  }
  await page.evaluate((t) => window.renderAt(t), 3.5);
  await page.screenshot({ path: join(out, `pulse-${cut}-poster.jpg`), type: "jpeg", quality: 90 });
  if (stillsOnly) { await page.close(); continue; }

  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
    "-vf", "scale=in_range=full:out_range=tv,format=yuv420p", "-color_range", "tv", "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-movflags", "+faststart", "-an",
    join(out, `pulse-${cut}.mp4`)], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((res, rej) => ff.on("close", (c) => (c === 0 ? res() : rej(new Error("ffmpeg exit " + c)))));
  const frames = Math.round(duration * FPS);
  for (let f = 0; f < frames; f++) {
    await page.evaluate((t) => window.renderAt(t), f / FPS);
    const buf = await page.screenshot({ type: "jpeg", quality: 97 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  }
  ff.stdin.end();
  await done;
  console.log(`${cut}: ${duration.toFixed(1)}s, ${frames} frames`);
  await page.close();
}
await browser.close();
