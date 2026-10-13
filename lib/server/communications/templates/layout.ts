import type { EmailLocale } from "../types";
import type { RenderContext } from "./index";
import { escapeHtml, inlineToText, renderInline } from "../html";

export const FONT_HEADING = "'Space Grotesk',Arial,Helvetica,sans-serif";
export const FONT_BODY = "'IBM Plex Sans','Segoe UI',Arial,Helvetica,sans-serif";
export const COLORS = {
  page: "#fafafa", card: "#ffffff", text: "#171717", muted: "#737373", border: "#e5e5e5",
  violet: "#7c3aed", violetSoft: "#faf8ff", violetBorder: "#ddd6fe",
  amberSoft: "#fffbeb", amberBorder: "#f59e0b", amberText: "#92400e",
  stripe: ["#f9c815", "#f07124", "#ed0e78", "#6640a2"],
};
export const CHROME = {
  en: {
    productUpdate: "Product update", serviceNotice: "Service notice", announcement: "Announcement",
    actionRequired: "Action required", highlights: "Key highlights", unsubscribe: "Unsubscribe",
    preferences: "Manage email preferences in Pulse", questions: "Questions? Write to",
    reason: "You receive this email because your organisation uses DataCentral.",
    window: "When", impact: "Impact", actions: "What you need to do",
  },
  is: {
    productUpdate: "Vöruuppfærsla", serviceNotice: "Þjónustutilkynning", announcement: "Tilkynning",
    actionRequired: "Aðgerðar þörf", highlights: "Helstu atriði", unsubscribe: "Afskrá",
    preferences: "Stjórna tölvupóststillingum í Pulse", questions: "Spurningar? Sendu póst á",
    reason: "Þú færð þennan póst vegna þess að fyrirtækið þitt notar DataCentral.",
    window: "Hvenær", impact: "Áhrif", actions: "Það sem þú þarft að gera",
  },
} satisfies Record<EmailLocale, Record<string, string>>;
export const chrome = (locale: EmailLocale) => CHROME[locale];

export function eyebrow(text: string) {
  return `<p style="margin:0 0 10px 0;font-family:${FONT_BODY};font-size:12px;line-height:16px;letter-spacing:0.13em;text-transform:uppercase;font-weight:700;color:${COLORS.violet};">${escapeHtml(text)}</p>`;
}
export function heading1(text: string) {
  return `<h1 style="margin:0 0 8px 0;font-family:${FONT_HEADING};font-size:28px;line-height:34px;letter-spacing:-0.01em;font-weight:700;color:${COLORS.text};">${escapeHtml(text)}</h1>`;
}
export function heading2(text: string) {
  return `<h2 style="margin:24px 0 8px 0;font-family:${FONT_HEADING};font-size:18px;line-height:24px;font-weight:700;color:${COLORS.text};">${escapeHtml(text)}</h2>`;
}
export function subtitle(text: string) {
  return `<p style="margin:0 0 20px 0;font-family:${FONT_BODY};font-size:16px;line-height:24px;color:${COLORS.muted};">${escapeHtml(text)}</p>`;
}
export function callout(tone: "warning" | "info", label: string | undefined, text: string) {
  const bg = tone === "warning" ? COLORS.amberSoft : COLORS.violetSoft;
  const bar = tone === "warning" ? COLORS.amberBorder : COLORS.violet;
  const labelHtml = label ? `<strong style="color:${tone === "warning" ? COLORS.amberText : COLORS.violet};">${escapeHtml(label)}:</strong> ` : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:12px 0 16px 0;"><tr><td style="background:${bg};border-left:3px solid ${bar};padding:12px 16px;font-family:${FONT_BODY};font-size:14px;line-height:22px;color:${COLORS.text};">${labelHtml}${renderInline(text)}</td></tr></table>`;
}
export function linkRow(label: string, url: string) {
  return `<p style="margin:4px 0 20px 0;font-family:${FONT_BODY};font-size:15px;line-height:22px;"><a href="${escapeHtml(url)}" style="color:${COLORS.violet};font-weight:700;text-decoration:none;">${escapeHtml(label)} &rarr;</a></p>`;
}
export function divider() {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="border-top:1px solid ${COLORS.border};font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>`;
}
export function ctaButton(label: string, url: string) {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;"><tr><td style="background:${COLORS.violet};border-radius:6px;"><a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 28px;font-family:${FONT_HEADING};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a></td></tr></table>`;
}
export function signOff(text: string) {
  const [first, ...rest] = text.split("\n");
  return `<p style="margin:24px 0 0 0;font-family:${FONT_BODY};font-size:15px;line-height:22px;color:${COLORS.text};">${escapeHtml(first)}${rest.length ? `<br><strong>${escapeHtml(rest.join(" "))}</strong>` : ""}</p>`;
}

/** Wraps rendered body HTML in the branded shell: stripe, logo, card, footer. */
export function shell(bodyHtml: string, locale: EmailLocale, ctx: RenderContext, preheader: string, title: string) {
  const c = chrome(locale);
  const stripe = COLORS.stripe.map((color) => `<td width="25%" style="background:${color};height:6px;font-size:0;line-height:0;">&nbsp;</td>`).join("");
  const columns = COLORS.stripe.length; // the single-cell rows below must span every stripe column, or they collapse into the first one
  const unsubscribe = ctx.unsubscribeTags
    ? ` &middot; <a href="<%asm_group_unsubscribe_raw_url%>" style="color:${COLORS.muted};">${c.unsubscribe}</a>`
    : "";
  return `<!DOCTYPE html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:${COLORS.page};">
<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${COLORS.page};">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${COLORS.page};"><tr><td align="center" style="padding:0 0 32px 0;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:${COLORS.card};">
<tr>${stripe}</tr>
<tr><td colspan="${columns}" style="padding:28px 32px 8px 32px;"><img src="${ctx.publicUrl}/email/datacentral-logo.png" width="170" alt="DataCentral" style="display:block;width:170px;height:auto;border:0;"></td></tr>
<tr><td colspan="${columns}" style="padding:16px 32px 32px 32px;">${bodyHtml}</td></tr>
<tr><td colspan="${columns}" style="padding:0 32px 28px 32px;">${divider()}
<p style="margin:16px 0 0 0;font-family:${FONT_BODY};font-size:12px;line-height:18px;color:${COLORS.muted};">${c.reason} ${c.questions} <a href="mailto:${escapeHtml(ctx.boilerplate.supportEmail)}" style="color:${COLORS.muted};">${escapeHtml(ctx.boilerplate.supportEmail)}</a>.</p>
<p style="margin:8px 0 0 0;font-family:${FONT_BODY};font-size:12px;line-height:18px;color:${COLORS.muted};">${escapeHtml(ctx.boilerplate.footer)} &middot; <a href="${ctx.publicUrl}/?page=updates" style="color:${COLORS.muted};">${c.preferences}</a>${unsubscribe}</p>
</td></tr></table></td></tr></table></body></html>`;
}

/** Plain-text counterpart of shell(): title, body lines, sign-off, footer. */
export function textShell(lines: string[], locale: EmailLocale, ctx: RenderContext) {
  const c = chrome(locale);
  const footer = [
    "",
    "--",
    `${c.reason} ${c.questions} ${ctx.boilerplate.supportEmail}.`,
    `${ctx.boilerplate.footer} · ${c.preferences}: ${ctx.publicUrl}/?page=updates`,
    ...(ctx.unsubscribeTags ? [`${c.unsubscribe}: <%asm_group_unsubscribe_raw_url%>`] : []),
  ];
  return [...lines, ...footer].map((line) => inlineToText(line)).join("\n");
}
