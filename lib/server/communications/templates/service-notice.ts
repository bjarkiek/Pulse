import { serviceNoticeBodySchema } from "@/lib/contracts";
import type { z } from "zod";
import type { EmailLocale } from "../types";
import { renderInline, renderParagraphs } from "../html";
import type { EmailTemplate, RenderContext } from "./index";
import { callout, chrome, COLORS, eyebrow, FONT_BODY, heading1, heading2, linkRow, signOff } from "./layout";

type Body = z.infer<typeof serviceNoticeBodySchema>;

const formatWindow = (when: NonNullable<Body["window"]>) => `${when.startsAt} – ${when.endsAt} (${when.timezone})`;

function renderHtml(body: Body, locale: EmailLocale, ctx: RenderContext) {
  const c = chrome(locale);
  const parts = [eyebrow(c.serviceNotice), heading1(body.title), renderParagraphs(body.summary)];
  if (body.window) parts.push(callout("warning", c.window, formatWindow(body.window)));
  if (body.impact) parts.push(heading2(c.impact), renderParagraphs(body.impact));
  if (body.actions.length)
    parts.push(
      heading2(c.actions),
      `<ol style="margin:0 0 14px 0;padding:0 0 0 22px;font-family:${FONT_BODY};font-size:15px;line-height:24px;color:${COLORS.text};">${body.actions
        .map((action) => `<li style="margin:0 0 6px 0;">${renderInline(action)}</li>`)
        .join("")}</ol>`,
    );
  if (body.link) parts.push(linkRow(body.link.label, body.link.url));
  if (body.contact) parts.push(renderParagraphs(body.contact));
  parts.push(signOff(body.signOff || ctx.boilerplate.signOff));
  return parts.join("");
}

function renderText(body: Body, locale: EmailLocale, ctx: RenderContext) {
  const c = chrome(locale);
  const lines = [c.serviceNotice, body.title.toUpperCase(), "", body.summary];
  if (body.window) lines.push("", `${c.window}: ${formatWindow(body.window)}`);
  if (body.impact) lines.push("", `== ${c.impact} ==`, body.impact);
  if (body.actions.length) {
    lines.push("", `== ${c.actions} ==`);
    body.actions.forEach((action, index) => lines.push(`${index + 1}. ${action}`));
  }
  if (body.link) lines.push("", `${body.link.label}: ${body.link.url}`);
  if (body.contact) lines.push("", body.contact);
  lines.push("", body.signOff || ctx.boilerplate.signOff);
  return lines;
}

export const serviceNoticeTemplate: EmailTemplate = {
  key: "service-notice",
  name: { en: "Service notice", is: "Þjónustutilkynning" },
  bodySchema: serviceNoticeBodySchema,
  render(raw, locale, ctx) {
    const body = serviceNoticeBodySchema.parse(raw);
    return { html: renderHtml(body, locale, ctx), text: renderText(body, locale, ctx).join("\n") };
  },
};
