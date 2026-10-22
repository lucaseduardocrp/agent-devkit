import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { E2eArtifactStore } from '../e2e/application/artifact-store.js';
import type { LlmImage } from '../agents/application/agent-ports.js';
import {
  attachmentContentKey,
  attachmentKind,
  readAttachmentMeta,
  type Attachment,
  type AttachmentScope,
} from './attachment.js';

export const imageMimeTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ImageMimeType = (typeof imageMimeTypes)[number];
export type ImageAttachmentScope = AttachmentScope;
export type ImageAttachment = Attachment;

/** Largest image sent to a model; bigger attachments stay out of the prompt. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export function imageExtension(mimeType: ImageMimeType): string {
  return mimeType === 'image/jpeg' ? 'jpg' : mimeType.slice('image/'.length);
}

function isImageMimeType(value: string | undefined): value is ImageMimeType {
  return imageMimeTypes.includes(value as ImageMimeType);
}

/** Storage key of images uploaded before generic attachments (entries without `kind`). */
export function imageKey(
  workspaceId: string,
  attachment: Pick<ImageAttachment, 'id' | 'scope' | 'mimeType'>,
): string {
  if (!isImageMimeType(attachment.mimeType))
    throw new Error('Uploaded image is missing its media type.');
  return `images/${attachment.scope}/${workspaceId}/${attachment.id}.${imageExtension(attachment.mimeType)}`;
}

const ADK_FILE_PATH = /^\/attachments\/files\/([0-9a-f-]{36})$/i;
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

function inlineImage(
  url: string,
  name: string,
  scope: ImageAttachmentScope,
): ImageAttachment | null {
  const adkId = ADK_FILE_PATH.exec(url)?.[1];
  if (adkId) return { id: adkId, name, kind: 'image', scope, source: 'adk', url };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
    return {
      id: `inline:${parsed.toString()}`,
      name,
      kind: 'image',
      scope,
      source: 'url',
      url: parsed.toString(),
    };
  } catch {
    return null;
  }
}

export function detectImageMimeType(bytes: Uint8Array): ImageMimeType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  )
    return 'image/webp';
  if (
    bytes.length >= 6 &&
    ['GIF87a', 'GIF89a'].includes(String.fromCharCode(...bytes.subarray(0, 6)))
  )
    return 'image/gif';
  return null;
}

/** Images written in a description, as HTML `<img>` or Markdown `![alt](url)`. */
export function inlineImageAttachments(
  description: string,
  scope: ImageAttachmentScope,
): ImageAttachment[] {
  const attachments: ImageAttachment[] = [];
  for (const match of description.matchAll(MARKDOWN_IMAGE)) {
    const image = inlineImage(match[2]!, match[1]?.trim() || 'Image in description', scope);
    if (image) attachments.push(image);
  }
  for (const match of description.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const source = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const rawUrl = source?.[1] ?? source?.[2] ?? source?.[3];
    if (!rawUrl) continue;
    const url = rawUrl.replace(/&amp;/gi, '&').replace(/&#(?:0*38|x0*26);/gi, '&');
    const name = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    // Malformed image URLs in imported HTML are ignored.
    const image = inlineImage(
      url,
      (name?.[1] ?? name?.[2] ?? name?.[3] ?? '').trim() || 'Image in description',
      scope,
    );
    if (image) attachments.push(image);
  }
  return attachments;
}

export function decodeImageData(value: string): Buffer {
  const data = value.replace(/^data:image\/(?:png|jpeg|webp|gif);base64,/i, '');
  if (
    !data ||
    data.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  )
    throw new Error('Image data must be valid base64 and no larger than 5 MB.');
  const bytes = Buffer.from(data, 'base64');
  if (
    !bytes.length ||
    bytes.length > MAX_IMAGE_BYTES ||
    bytes.toString('base64').replace(/=+$/, '') !== data.replace(/=+$/, '')
  )
    throw new Error('Image data must be valid base64 and no larger than 5 MB.');
  return bytes;
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    const first = octets[0]!;
    const second = octets[1]!;
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 198 && (second === 18 || second === 19)) ||
      first >= 224
    );
  }
  const normalized = address.toLowerCase();
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('2001:db8:') ||
    normalized.startsWith('::ffff:')
  );
}

export async function isPublicHttpsUrl(value: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443'))
    return false;
  if (isIP(url.hostname)) return !isPrivateAddress(url.hostname);
  if (
    url.hostname === 'localhost' ||
    url.hostname.endsWith('.localhost') ||
    url.hostname.endsWith('.local')
  )
    return false;
  try {
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    return addresses.length > 0 && addresses.every(({ address }) => !isPrivateAddress(address));
  } catch {
    return false;
  }
}

async function externalImage(attachment: ImageAttachment): Promise<LlmImage | null> {
  if (!(await isPublicHttpsUrl(attachment.url))) return null;
  try {
    const response = await fetch(attachment.url, {
      redirect: 'error',
      signal: AbortSignal.timeout(8_000),
      headers: { accept: imageMimeTypes.join(', ') },
    });
    if (!response.ok || !response.body) return null;
    const declaredType = response.headers.get('content-type')?.split(';', 1)[0]?.trim();
    if (!imageMimeTypes.includes(declaredType as ImageMimeType)) return null;
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_IMAGE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const mimeType = detectImageMimeType(bytes);
    return mimeType && mimeType === declaredType
      ? { mimeType, data: bytes.toString('base64') }
      : null;
  } catch {
    return null;
  }
}

export async function loadImageAttachments(
  store: E2eArtifactStore | undefined,
  workspaceId: string,
  attachments: readonly ImageAttachment[],
): Promise<LlmImage[]> {
  if (!store) return [];
  const images: LlmImage[] = [];
  for (const attachment of [...new Map(attachments.map((item) => [item.id, item])).values()].slice(
    0,
    10,
  )) {
    if (attachmentKind(attachment) !== 'image') continue;
    if (attachment.source === 'url') {
      const image = await externalImage(attachment);
      if (image) images.push(image);
      continue;
    }
    if (attachment.kind) {
      const meta = await readAttachmentMeta(store, workspaceId, attachment.id);
      if (meta?.kind !== 'image' || !isImageMimeType(meta.mimeType)) continue;
      const bytes = await store.get(attachmentContentKey(workspaceId, attachment.id));
      if (bytes && bytes.length <= MAX_IMAGE_BYTES && detectImageMimeType(bytes) === meta.mimeType)
        images.push({ mimeType: meta.mimeType, data: bytes.toString('base64') });
      continue;
    }
    if (!isImageMimeType(attachment.mimeType)) continue;
    const bytes = await store.get(imageKey(workspaceId, attachment));
    if (
      !bytes ||
      bytes.length > MAX_IMAGE_BYTES ||
      detectImageMimeType(bytes) !== attachment.mimeType
    )
      continue;
    images.push({ mimeType: attachment.mimeType, data: bytes.toString('base64') });
  }
  return images;
}
