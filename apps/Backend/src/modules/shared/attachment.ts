import type { E2eArtifactStore } from '../e2e/application/artifact-store.js';

export const attachmentScopes = ['issue', 'pbi', 'brain', 'spec', 'testcase'] as const;
export type AttachmentScope = (typeof attachmentScopes)[number];
export type AttachmentKind = 'image' | 'video' | 'document';

/**
 * A file kept with an item. `adk` files live in the ADK storage and are served by
 * `/attachments/files/:id`; `url` files stay where their provider hosts them.
 * Entries saved before generic attachments existed are images without `kind`.
 */
export interface Attachment {
  readonly id: string;
  readonly name: string;
  readonly kind?: AttachmentKind;
  readonly mimeType?: string;
  readonly size?: number;
  readonly scope: AttachmentScope;
  readonly source: 'adk' | 'url';
  readonly url: string;
}

export interface StoredAttachmentMeta {
  readonly id: string;
  readonly name: string;
  readonly kind: AttachmentKind;
  readonly mimeType: string;
  readonly size: number;
  readonly scope: AttachmentScope;
  readonly createdBy?: string;
  /**
   * `pending` until a saved item references it; files uploaded before this lifecycle
   * have no status and are treated as committed.
   */
  readonly status?: 'pending' | 'committed';
  /** Item that holds the file (e.g. `issue:<id>`); deleting it deletes the file. */
  readonly owner?: string;
  readonly createdAt: string;
}

const MB = 1024 * 1024;
export const MAX_ATTACHMENTS = 20;
export const attachmentLimits: Readonly<Record<AttachmentKind, number>> = {
  image: 10 * MB,
  video: 100 * MB,
  document: 25 * MB,
};
export const MAX_UPLOAD_BYTES = attachmentLimits.video;

export const attachmentMimeTypes: Readonly<Record<string, AttachmentKind>> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'video/mp4': 'video',
  'video/webm': 'video',
  'video/quicktime': 'video',
  'application/pdf': 'document',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'document',
  'application/zip': 'document',
  'text/plain': 'document',
  'text/csv': 'document',
  'text/markdown': 'document',
};

const officeTypes: Readonly<Record<string, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const textTypes: Readonly<Record<string, string>> = {
  txt: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  md: 'text/markdown',
};

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/**
 * Identifies an upload by its content, never by what the client declared. Office files and
 * zips share the zip signature, and text has none, so those also use the file extension.
 */
export function detectAttachmentType(
  bytes: Uint8Array,
  fileName: string,
): { mimeType: string; kind: AttachmentKind } | null {
  const extension = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() ?? '';
  const found = (mimeType: string) => ({ mimeType, kind: attachmentMimeTypes[mimeType]! });
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 4) === 'PNG')
    return found('image/png');
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return found('image/jpeg');
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP')
    return found('image/webp');
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6)))
    return found('image/gif');
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === 'ftyp')
    return found(ascii(bytes, 8, 12) === 'qt  ' ? 'video/quicktime' : 'video/mp4');
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  )
    return found('video/webm');
  if (bytes.length >= 5 && ascii(bytes, 0, 5) === '%PDF-') return found('application/pdf');
  if (bytes.length >= 4 && ascii(bytes, 0, 4) === 'PK\u0003\u0004')
    return found(officeTypes[extension] ?? 'application/zip');
  const textType = textTypes[extension];
  if (textType && !bytes.includes(0)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return found(textType);
    } catch {
      return null;
    }
  }
  return null;
}

export function attachmentKind(attachment: Pick<Attachment, 'kind' | 'mimeType'>): AttachmentKind {
  if (attachment.kind) return attachment.kind;
  return (attachment.mimeType && attachmentMimeTypes[attachment.mimeType]) || 'image';
}

export function attachmentFileUrl(id: string): string {
  return `/attachments/files/${id}`;
}

export function attachmentContentKey(workspaceId: string, id: string): string {
  return `attachments/${workspaceId}/${id}/content`;
}

export function attachmentMetaKey(workspaceId: string, id: string): string {
  return `attachments/${workspaceId}/${id}/meta.json`;
}

export async function readAttachmentMeta(
  store: E2eArtifactStore,
  workspaceId: string,
  id: string,
): Promise<StoredAttachmentMeta | null> {
  const raw = await store.get(attachmentMetaKey(workspaceId, id));
  if (!raw) return null;
  try {
    return JSON.parse(raw.toString('utf8')) as StoredAttachmentMeta;
  } catch {
    return null;
  }
}

/** File name safe for a Content-Disposition header, with the UTF-8 form for other clients. */
export function contentDisposition(type: 'inline' | 'attachment', name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Kind of a provider file, known only by its name until someone opens it. */
export function attachmentKindFromName(name: string): AttachmentKind {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension)) return 'image';
  if (['mp4', 'webm', 'mov'].includes(extension)) return 'video';
  return 'document';
}
