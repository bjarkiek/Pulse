import { chromium } from "playwright";
import assert from "node:assert/strict";
const b = await chromium.launch({ headless: true });
try {
  const p = await b.newPage();
  const base = "http://127.0.0.1:3107";
  await p.request.post(base + "/api/v1/tours/hide");
  await p.request.patch(base + "/api/v1/me", { data: { locale: "en" } });
  const created = await p.request.post(base + "/api/v1/requests", {
    headers: { "idempotency-key": crypto.randomUUID() },
    data: {
      title: "Concurrency browser fixture",
      problem: "A disposable local browser test",
      area: "Distribution",
      impact: "High",
      visibility: "Organization",
    },
  });
  assert.equal(created.status(), 201, await created.text());
  const { item } = await created.json();
  assert.ok(item.version);
  await p.goto(base + "/?page=requests&request=" + item.id, {
    waitUntil: "domcontentloaded",
  });
  const dialog = p.getByRole("dialog");
  await dialog
    .getByRole("button", { name: "Edit request", exact: true })
    .waitFor();
  await dialog
    .getByRole("button", { name: "Edit request", exact: true })
    .click();
  const editor = dialog.locator("form");
  await editor.locator("input").fill("My preserved edit");
  const changed = await p.request.patch(base + "/api/v1/requests/" + item.id, {
    headers: { "if-match": item.version },
    data: {
      title: "Another editor changed this",
      problem: "Newer server text",
    },
  });
  assert.equal(changed.status(), 200, await changed.text());
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await editor.getByRole("alert").waitFor();
  assert.match(
    await editor.getByRole("alert").innerText(),
    /This item changed.*Support ID/,
  );
  assert.equal(await editor.locator("input").inputValue(), "My preserved edit");
  await editor
    .getByRole("button", { name: "Reload latest version", exact: true })
    .click();
  await editor.getByRole("alert").waitFor({ state: "hidden" });
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click();
  await editor.waitFor({ state: "hidden" });
  assert.equal(
    (await (await p.request.get(base + "/api/v1/requests/" + item.id)).json())
      .item.title,
    "My preserved edit",
  );
  console.log(
    "PASS: browser create returns version; concurrent edit returns 412 + support ID; input preserved; explicit reread and retry succeed",
  );
} finally {
  await b.close();
}
