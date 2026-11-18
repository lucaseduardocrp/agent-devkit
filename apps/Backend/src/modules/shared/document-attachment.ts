import type { E2eArtifactStore } from '../e2e/application/artifact-store.js';
import type { LlmFile } from '../agents/application/agent-ports.js';
import {
  attachmentMimeTypes,
  detectAttachmentType,
  readAttachmentContent,
  readAttachmentMeta,
  type Attachment,
  type AttachmentScope,
} from './attachment.js';
import { isPublicHttpsUrl } from './image-attachment.js';

/** Most documents sent to a model for one request, and the most one of them (or all) may weigh. */
export const MAX_DOCUMENTS = 5;
export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENTS_TOTAL_BYTES = 20 * 1024 * 1024;
/** Links that are tried per request: a description full of links must not become a crawl. */
export const MAX_EXTERNAL_DOCUMENTS = 5;

const EXTERNAL_TIMEOUT_MS = 8_000;
const EXTERNAL_REDIRECTS = 3;

/**
 * The documents a model can be given: PDFs and anything that is text. Word, Excel and PowerPoint
 * files or zips stay out, since no provider reads them, and so do videos.
 */
export function isReadableDocumentType(mimeType: string | undefined): boolean {
  if (!mimeType || attachmentMimeTypes[mimeType] !== 'document') return false;
  return (
    mimeType === 'application/pdf' ||
    mimeType.startsWith('text/') ||
    /^application\/(json|xml|yaml)$/.test(mimeType)
  );
}

/**
 * What a link elsewhere may serve to count as a document. HTML is left out: a link in a
 * description is almost always a page to read in a browser, not a file to give the model.
 */
function isExternalDocumentType(mimeType: string): boolean {
  return isReadableDocumentType(mimeType) && mimeType !== 'text/html';
}

const ADK_FILE =
  /^\/attachments\/files\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
// `[name](target)`, but not `![name](…)`: that is an image.
const MARKDOWN_LINK = /(?<!!)\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const HTML_LINK = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;

/** A link in a description as a document attachment, or nothing when it is not a file to read. */
function linkedFile(target: string, label: string, scope: AttachmentScope): Attachment | null {
  const name = label.replace(/<[^>]*>/g, '').trim() || 'Linked file';
  const adkId = ADK_FILE.exec(target)?.[1]?.toLowerCase();
  if (adkId) {
    return { id: adkId, name, kind: 'document', scope, source: 'adk', url: target.toLowerCase() };
  }
  try {
    const url = new URL(target);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return {
      id: `inline:${url.toString()}`,
      name,
      kind: 'document',
      scope,
      source: 'url',
      url: url.toString(),
    };
  } catch {
    return null;
  }
}

/**
 * Files linked in a description, as Markdown `[name](url)` or HTML `<a>`: the ones kept by the ADK
 * (`/attachments/files/:id`) and any `https` link, which is only fetched if it turns out to serve
 * a document (see `loadDocumentAttachments`).
 */
export function inlineFileAttachments(description: string, scope: AttachmentScope): Attachment[] {
  const found: Attachment[] = [];
  for (const match of description.matchAll(MARKDOWN_LINK)) {
    const file = linkedFile(match[2]!, match[1]!, scope);
    if (file) found.push(file);
  }
  for (const match of description.matchAll(HTML_LINK)) {
    const href = (match[1] ?? match[2] ?? match[3] ?? '').replace(/&amp;/gi, '&');
    const file = linkedFile(href, match[4]!, scope);
    if (file) found.push(file);
  }
  return found;
}

interface Downloaded {
  readonly bytes: Buffer;
  readonly mimeType: string;
  readonly name: string;
}

function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Downloads a document from a public `https` address. Redirects are followed by hand, since links
 * to files usually go through one, and every hop must be public again. No credentials are sent:
 * what needs a login is not reachable this way. What comes back must be what it says it is.
 */
async function downloadDocument(
  attachment: Attachment,
  limit: number,
  fetcher: typeof fetch,
): Promise<Downloaded | null> {
  try {
    let current = new URL(attachment.url);
    for (let hop = 0; hop <= EXTERNAL_REDIRECTS; hop += 1) {
      if (!(await isPublicHttpsUrl(current.toString()))) return null;
      const response = await fetcher(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(EXTERNAL_TIMEOUT_MS),
        headers: { accept: 'application/pdf, text/*, application/json' },
      });
      const location = response.headers.get('location');
      if (response.status >= 300 && response.status < 400 && location) {
        await response.body?.cancel();
        current = new URL(location, current);
        continue;
      }
      if (!response.ok || !response.body) return null;
      const declared = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
      // `octet-stream` is what many servers say for a PDF; the content decides then.
      if (
        !declared ||
        (declared !== 'application/octet-stream' && !isExternalDocumentType(declared))
      ) {
        await response.body.cancel();
        return null;
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > limit) {
        await response.body.cancel();
        return null;
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
      const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      const isPdf = bytes.subarray(0, 5).toString('latin1') === '%PDF-';
      const mimeType = isPdf
        ? 'application/pdf'
        : declared !== 'application/octet-stream' && declared !== 'application/pdf' && isText(bytes)
          ? declared
          : null;
      return mimeType && isExternalDocumentType(mimeType)
        ? { bytes, mimeType, name: attachment.name }
        : null;
    }
  } catch {
    // Unreachable, slow or a bad address: the document is simply not there.
  }
  return null;
}

/**
 * The documents among `attachments`, read from the store (or downloaded, for a link elsewhere) and
 * checked against their content, ready to go to a model. Anything unreadable, too big or not what
 * it says it is stays out: a missing document must never fail the request it was meant to help.
 */
export async function loadDocumentAttachments(
  store: E2eArtifactStore | undefined,
  workspaceId: string,
  attachments: readonly Attachment[],
  fetcher: typeof fetch = fetch,
): Promise<LlmFile[]> {
  const files: LlmFile[] = [];
  let total = 0;
  let external = 0;
  for (const attachment of [...new Map(attachments.map((item) => [item.id, item])).values()]) {
    if (files.length >= MAX_DOCUMENTS) break;
    if (attachment.kind !== 'document') continue;
    if (attachment.source === 'url') {
      if (external >= MAX_EXTERNAL_DOCUMENTS) continue;
      external += 1;
      const limit = Math.min(MAX_DOCUMENT_BYTES, MAX_DOCUMENTS_TOTAL_BYTES - total);
      const document = await downloadDocument(attachment, limit, fetcher);
      if (!document) continue;
      total += document.bytes.length;
      files.push({
        name: document.name,
        mimeType: document.mimeType,
        data: document.bytes.toString('base64'),
      });
      continue;
    }
    if (!store || attachment.source !== 'adk') continue;
    const meta = await readAttachmentMeta(store, workspaceId, attachment.id);
    if (meta?.kind !== 'document' || !isReadableDocumentType(meta.mimeType)) continue;
    if (meta.size > MAX_DOCUMENT_BYTES || total + meta.size > MAX_DOCUMENTS_TOTAL_BYTES) continue;
    const bytes = await readAttachmentContent(store, workspaceId, attachment.id, meta.kind);
    if (!bytes || bytes.length > MAX_DOCUMENT_BYTES) continue;
    if (total + bytes.length > MAX_DOCUMENTS_TOTAL_BYTES) continue;
    if (detectAttachmentType(bytes, meta.name)?.mimeType !== meta.mimeType) continue;
    total += bytes.length;
    files.push({ name: meta.name, mimeType: meta.mimeType, data: bytes.toString('base64') });
  }
  return files;
}
