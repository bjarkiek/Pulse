import { plainBodySchema } from "@/lib/contracts";
import type { z } from "zod";
import type { EmailLocale } from "../types";
import { renderParagraphs } from "../html";
import type { EmailTemplate, RenderContext } from "./index";
import { chrome, ctaButton, eyebrow, heading1, signOff } from "./layout";

type Body = z.infer<typeof plainBodySchema>;

function renderHtml(body: Body, locale: EmailLocale, ctx: RenderContext) {
  const c = chrome(locale);
  const parts = [eyebrow(c.announcement), heading1(body.title), ...body.paragraphs.map((paragraph) => renderParagraphs(paragraph))];
  if (body.cta) parts.push(ctaButton(body.cta.label, body.cta.url));
  parts.push(signOff(body.signOff || ctx.boilerplate.signOff));
  return parts.join("");
}

function renderText(body: Body, locale: EmailLocale, ctx: RenderContext) {
  const c = chrome(locale);
  const lines = [c.announcement, body.title.toUpperCase()];
  for (const paragraph of body.paragraphs) lines.push("", paragraph);
  if (body.cta) lines.push("", `${body.cta.label}: ${body.cta.url}`);
  lines.push("", body.signOff || ctx.boilerplate.signOff);
  return lines;
}

export const plainTemplate: EmailTemplate = {
  key: "plain",
  name: { en: "Announcement", is: "Tilkynning" },
  bodySchema: plainBodySchema,
  render(raw, locale, ctx) {
    const body = plainBodySchema.parse(raw);
    return { html: renderHtml(body, locale, ctx), text: renderText(body, locale, ctx).join("\n") };
  },
};
