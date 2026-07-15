// Converts assistant Markdown replies into Slack's mrkdwn format.
//
// Fenced code blocks (```...```) and inline code (`...`) are extracted
// first and passed through untouched. All other prose segments have the
// following transforms applied, in order:
//   1. escape & then < then >
//   2. [text](url) -> <url|text>
//   3. **bold** / __bold__ -> *bold*
//   4. #{1,6} heading -> *heading*
//   5. leading "- " / "* " bullets -> "• "

const CODE_SPLIT_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;
const LINK_RE = /\[([^\]]*)\]\(([^)]*)\)/g;
const BOLD_STAR_RE = /\*\*(.+?)\*\*/g;
const BOLD_UNDERSCORE_RE = /__(.+?)__/g;
const HEADING_RE = /^#{1,6}\s+(.+)$/gm;
const BULLET_RE = /^[-*] /gm;

function transformProse(text: string): string {
  let result = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  result = result.replace(LINK_RE, (_match, label: string, url: string) => `<${url}|${label}>`);
  result = result.replace(BOLD_STAR_RE, (_match, inner: string) => `*${inner}*`);
  result = result.replace(BOLD_UNDERSCORE_RE, (_match, inner: string) => `*${inner}*`);
  result = result.replace(HEADING_RE, (_match, inner: string) => `*${inner}*`);
  result = result.replace(BULLET_RE, "• ");

  return result;
}

/**
 * Converts Markdown (as produced by the assistant) to Slack mrkdwn.
 * Pure function, no dependencies.
 */
export function toMrkdwn(markdown: string): string {
  const segments = markdown.split(CODE_SPLIT_RE);
  return segments
    .map((segment, index) => (index % 2 === 1 ? segment : transformProse(segment)))
    .join("");
}
