/** What a reference shows when it is opened: a title, a short line and the text itself. */
export interface ReferenceDetail {
  readonly title: string;
  readonly subtitle?: string;
  readonly body: string;
}

/** The text of an HTML or Markdown-with-tags value, without parsing it into the page. */
export function plainText(value: string | null | undefined): string {
  if (!value) return '';
  if (!/<[a-z!/][^>]*>/i.test(value)) return value;
  const parsed = new DOMParser().parseFromString(
    value.replace(/<\/(p|div|li|h[1-6]|tr|br)\s*>|<br\s*\/?>/gi, '\n'),
    'text/html',
  );
  // Code and styles are not text anyone wrote for reading.
  parsed.body.querySelectorAll('script, style, noscript').forEach((element) => element.remove());
  return parsed.body.textContent.replace(/\n{3,}/g, '\n\n').trim();
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The pattern of a passage that tolerates the whitespace changes chunking introduces. */
const loose = (text: string) => escapeRegExp(text.trim()).replace(/\s+/g, '\\s+');
/** A long passage is looked for by its start when it does not match whole. */
const PREFIX = 160;

/** Where `excerpt` is in `body`, as the range to highlight; null when it is not there. */
export function locateExcerpt(
  body: string,
  excerpt: string,
): { start: number; end: number } | null {
  const text = excerpt.trim();
  if (!text) return null;
  const exact = body.indexOf(text);
  if (exact >= 0) return { start: exact, end: exact + text.length };
  for (const candidate of [text, text.slice(0, PREFIX)]) {
    const match = new RegExp(loose(candidate)).exec(body);
    if (match) return { start: match.index, end: match.index + match[0].length };
  }
  return null;
}
