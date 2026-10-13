const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}
const LINK = /\[([^\]\n]{1,200})\]\((https:\/\/[^\s)<>"']{1,2000})\)/g;
const BOLD = /\*\*([^*\n]{1,300})\*\*/g;
/** Escape first, then upgrade **bold**, [label](https://…) and newlines. Everything else stays literal. */
export function renderInline(value: string): string {
  return escapeHtml(value)
    .replace(LINK, (_m, label: string, url: string) => `<a href="${url}" style="color:#7c3aed;font-weight:600;text-decoration:underline;">${label}</a>`)
    .replace(BOLD, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}
export function renderParagraphs(
  value: string,
  style = "margin:0 0 14px 0;font-family:'IBM Plex Sans','Segoe UI',Arial,Helvetica,sans-serif;font-size:15px;line-height:24px;color:#171717;",
): string {
  return value
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p style="${style}">${renderInline(paragraph)}</p>`)
    .join("");
}
export function inlineToText(value: string): string {
  return value.replace(LINK, "$1 ($2)").replace(BOLD, "$1");
}
