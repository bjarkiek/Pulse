import { chromium } from "playwright";
import assert from "node:assert/strict";
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.request.patch("http://127.0.0.1:3107/api/v1/me", {
    data: { locale: "en" },
  });
  await page.request.post("http://127.0.0.1:3107/api/v1/tours/hide");
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:3107", { waitUntil: "domcontentloaded" });
  const tourClose = page.getByRole("button", { name: /skip tour|close tour/i });
  if (await tourClose.count()) await tourClose.first().click();
  await page
    .getByRole("button", { name: "Submit a request", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  const title = dialog.getByRole("textbox").first();
  await title.waitFor();
  await page.waitForFunction(
    () => !document.querySelector(".composer fieldset")?.disabled,
  );
  await title.fill("Browser draft fixture");
  await dialog
    .locator("textarea")
    .first()
    .fill("Preserve this draft across closing and reopening.");
  await page.waitForFunction(() =>
    Object.keys(localStorage).some((k) => k.startsWith("pulse-draft-v2:")),
  );
  assert.equal(
    await page.evaluate(() =>
      document.querySelector("[role=dialog]").contains(document.activeElement),
    ),
    true,
  );
  await page.screenshot({
    path: process.env.TEMP + "/pulse-composer.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Submit a request", exact: true })
    .first()
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector(".composer input")?.value ===
      "Browser draft fixture",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Browse ideas", exact: true }).click();
  assert.match(page.url(), /page=ideas/);
  await page.getByRole("button", { name: "My requests", exact: true }).click();
  assert.match(page.url(), /page=requests/);
  await page.goBack();
  await page.waitForFunction(
    () => document.querySelector(".topbar h1")?.textContent === "Browse ideas",
  );
  await page.getByRole("button", { name: "Skipta yfir í íslensku" }).click();
  await page
    .getByRole("button", { name: "Senda inn beiðni", exact: true })
    .first()
    .click();
  await page.waitForFunction(
    () => !document.querySelector(".composer fieldset")?.disabled,
  );
  const select = page.locator(".composer select").last();
  assert.equal(
    await select.locator("option").first().getAttribute("value"),
    "Organization",
  );
  assert.equal(
    await select.locator("option").last().getAttribute("value"),
    "Private",
  );
  await page.screenshot({
    path: process.env.TEMP + "/pulse-composer-is.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: draft scope/restore, dialog focus/Escape, URL history, Icelandic enum values, no browser exceptions",
  );
} finally {
  await browser.close();
}
