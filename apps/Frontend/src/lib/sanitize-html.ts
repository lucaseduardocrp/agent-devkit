import { isSafeImageSource } from '../features/shared/media.js';

const removedTags = new Set([
  'SCRIPT',
  'STYLE',
  'IFRAME',
  'OBJECT',
  'EMBED',
  'SVG',
  'MATH',
  'TEMPLATE',
]);
const allowedTags = new Set([
  'A',
  'ABBR',
  'B',
  'BLOCKQUOTE',
  'BR',
  'CAPTION',
  'CODE',
  'DD',
  'DEL',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'EM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HR',
  'I',
  'IMG',
  'INS',
  'KBD',
  'LI',
  'MARK',
  'OL',
  'P',
  'PRE',
  'S',
  'SMALL',
  'SPAN',
  'STRONG',
  'SUB',
  'SUMMARY',
  'SUP',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'U',
  'UL',
]);
const allowedAttributes: Readonly<Record<string, readonly string[]>> = {
  A: ['href'],
  TD: ['colspan', 'rowspan'],
  TH: ['colspan', 'rowspan'],
  DETAILS: ['open'],
  IMG: ['src', 'alt', 'title', 'width', 'height'],
};

export const INLINE_HTML_TAG =
  /<\/?(?:a|abbr|b|br|code|del|em|i|img|ins|kbd|mark|s|small|span|strong|sub|sup|u)\b[^>]*>/i;

/** Keeps a conservative subset of HTML, drops scripts/attributes and makes links open safely. */
export function sanitizeHtml(value: string): string {
  if (typeof DOMParser === 'undefined') return value.replace(/<[^>]*>/g, ' ');
  const document = new DOMParser().parseFromString(value, 'text/html');
  for (const element of [...document.body.querySelectorAll<HTMLElement>('*')]) {
    if (removedTags.has(element.tagName)) {
      element.remove();
      continue;
    }
    if (!allowedTags.has(element.tagName)) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    const keep = allowedAttributes[element.tagName] ?? [];
    for (const attribute of [...element.attributes]) {
      if (!keep.includes(attribute.name)) element.removeAttribute(attribute.name);
    }
    if (element.tagName === 'IMG' && !isSafeImageSource(element.getAttribute('src') ?? '')) {
      element.remove();
      continue;
    }
    if (element.tagName === 'A') {
      const href = element.getAttribute('href')?.trim() ?? '';
      if (!/^(https?:|mailto:|tel:|\/|#|\.\.?\/)/i.test(href)) element.removeAttribute('href');
      element.setAttribute('target', '_blank');
      element.setAttribute('rel', 'noopener noreferrer');
    }
  }
  return document.body.innerHTML;
}
