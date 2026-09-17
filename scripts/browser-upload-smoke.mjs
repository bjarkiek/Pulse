import { chromium } from "playwright";
import assert from "node:assert/strict";

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const base = "http://127.0.0.1:3107";
  await page.request.post(base + "/api/v1/tours/hide");
  await page.request.patch(base + "/api/v1/me", { data: { locale: "en" } });
  await page.request.delete(base + "/api/v1/requests/draft");
  let failed = false;
  let creations = 0;
  let reservations = 0;
  page.on("request", (request) => {
    if (request.method() !== "POST") return;
    if (request.url() === base + "/api/v1/requests") creations++;
    if (/\/requests\/[^/]+\/attachments$/.test(request.url())) reservations++;
  });
  await page.route("**/api/v1/attachments/*/content", async (route) => {
    if (!failed && route.request().method() === "PUT") {
      failed = true;
      await route.fulfill({ status: 503, body: "Synthetic upload failure" });
    } else await route.continue();
  });
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page
    .getByRole("button", { name: "Submit a request", exact: true })
    .first()
    .click();
  await page.waitForFunction(
    () => !document.querySelector(".composer fieldset")?.disabled,
  );
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox")
    .first()
    .fill("Upload retry browser fixture");
  await dialog
    .locator("textarea")
    .first()
    .fill("Retain the request and quota reservation after a failed upload.");
  await dialog
    .locator('input[type="file"]')
    .setInputFiles({
      name: "fixture.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("synthetic data"),
    });
  await dialog
    .getByRole("button", { name: "Submit request", exact: true })
    .click();
  const retry = dialog.getByRole("button", {
    name: "Retry attachments",
    exact: true,
  });
  await retry.waitFor();
  assert.equal(
    await dialog.getByRole("textbox").first().inputValue(),
    "Upload retry browser fixture",
  );
  await retry.click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(failed, true);
  assert.equal(creations, 1);
  assert.equal(reservations, 1);
  console.log(
    "PASS: failed upload preserves input; retry creates neither a duplicate request nor a second attachment reservation",
  );
} finally {
  await browser.close();
}
