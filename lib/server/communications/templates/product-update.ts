import { productUpdateBodySchema } from "@/lib/contracts";
import type { z } from "zod";
import type { EmailLocale } from "../types";
import { escapeHtml, renderParagraphs } from "../html";
import type { EmailTemplate, RenderContext } from "./index";
import { callout, chrome, COLORS, ctaButton, divider, eyebrow, FONT_BODY, heading1, heading2, linkRow, signOff, subtitle } from "./layout";

type Body = z.infer<typeof productUpdateBodySchema>;

function renderHtml(body: Body, locale: EmailLocale, ctx: RenderContext) {
  const c = chrome(locale);
  const parts = [
    eyebrow(body.eyebrow || c.productUpdate),
    heading1(body.title),
    body.subtitle ? subtitle(body.subtitle) : "",
    renderParagraphs(body.intro),
    `<p style="margin:20px 0 4px 0;font-family:${FONT_BODY};font-size:15px;font-weight:700;color:${COLORS.text};">${escapeHtml(body.highlightsLabel || c.highlights)}</p>`,
  ];
  body.sections.forEach((section, index) => {
    parts.push(heading2(section.heading), renderParagraphs(section.body));
    if (section.callout) parts.push(callout(section.callout.tone, section.callout.label, section.callout.text));
    if (section.link) parts.push(linkRow(section.link.label, section.link.url));
    if (index < body.sections.length - 1) parts.push(divider());
  });
  if (body.note) parts.push(callout("info", undefined, body.note));
  if (body.cta) parts.push(ctaButton(body.cta.label, body.cta.url));
  parts.push(signOff(body.signOff || ctx.boilerplate.signOff));
  return parts.join("");
}

function renderText(body: Body, locale: EmailLocale, ctx: RenderContext) {
  const c = chrome(locale);
  const lines = [body.eyebrow || c.productUpdate, body.title.toUpperCase()];
  if (body.subtitle) lines.push(body.subtitle);
  lines.push("", body.intro, "", body.highlightsLabel || c.highlights);
  for (const section of body.sections) {
    lines.push("", `== ${section.heading} ==`, section.body);
    if (section.callout) lines.push("", `${section.callout.label ? `${section.callout.label}: ` : ""}${section.callout.text}`);
    if (section.link) lines.push(`${section.link.label}: ${section.link.url}`);
  }
  if (body.note) lines.push("", body.note);
  if (body.cta) lines.push("", `${body.cta.label}: ${body.cta.url}`);
  lines.push("", body.signOff || ctx.boilerplate.signOff);
  return lines;
}

export const productUpdateTemplate: EmailTemplate = {
  key: "product-update",
  name: { en: "Product update", is: "Vöruuppfærsla" },
  bodySchema: productUpdateBodySchema,
  render(raw, locale, ctx) {
    const body = productUpdateBodySchema.parse(raw);
    return { html: renderHtml(body, locale, ctx), text: renderText(body, locale, ctx).join("\n") };
  },
};
