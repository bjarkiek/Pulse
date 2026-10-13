import type { z } from "zod";
import type { CommunicationContent, EmailLocale, TemplateKey } from "../types";
import { productUpdateTemplate } from "./product-update";
import { serviceNoticeTemplate } from "./service-notice";
import { plainTemplate } from "./plain";
import { shell, textShell } from "./layout";

export type RenderContext = {
  publicUrl: string;
  boilerplate: { signOff: string; footer: string; supportEmail: string };
  unsubscribeTags: boolean;
  testPrefix?: boolean;
};
export type RenderedEmail = { subject: string; preheader: string; html: string; text: string };
export type EmailTemplate = {
  key: TemplateKey;
  name: { en: string; is: string };
  bodySchema: z.ZodType;
  render(body: Record<string, unknown>, locale: EmailLocale, ctx: RenderContext): { html: string; text: string };
};

export const TEMPLATES: Record<TemplateKey, EmailTemplate> = {
  "product-update": productUpdateTemplate,
  "service-notice": serviceNoticeTemplate,
  plain: plainTemplate,
};
export function getTemplate(key: string): EmailTemplate {
  if (!Object.hasOwn(TEMPLATES, key)) throw new Error("INVALID_TEMPLATE");
  return TEMPLATES[key as TemplateKey];
}
/** Picks the locale variant (falling back to English) and wraps it in the branded shell. */
export function renderCommunication(templateKey: TemplateKey, content: CommunicationContent, locale: EmailLocale, ctx: RenderContext): RenderedEmail {
  const template = getTemplate(templateKey);
  const body = (locale === "is" && content.body.is) || content.body.en;
  const subjectRaw = (locale === "is" && content.subject.is) || content.subject.en;
  const subject = `${ctx.testPrefix ? "[TEST] " : ""}${subjectRaw}`;
  const preheader = (locale === "is" && content.preheader?.is) || content.preheader?.en || "";
  const rendered = template.render(body, locale, ctx);
  return {
    subject,
    preheader,
    html: shell(rendered.html, locale, ctx, preheader, subjectRaw),
    text: textShell([rendered.text], locale, ctx),
  };
}
