export type AttachmentScope = 'issue' | 'pbi' | 'brain' | 'spec' | 'testcase';
export type AttachmentKind = 'image' | 'video' | 'document';

/**
 * A file kept with an item. `adk` files are stored by the ADK and served from `url`
 * (`/attachments/files/:id`); `url` files stay where their provider hosts them.
 * Entries saved before generic attachments are images without `kind`.
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

const MB = 1024 * 1024;
export const MAX_ATTACHMENTS = 20;
export const ATTACHMENT_LIMITS: Readonly<Record<AttachmentKind, number>> = {
  image: 10 * MB,
  video: 100 * MB,
  document: 25 * MB,
};
export const ATTACHMENT_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm,video/quicktime,.pdf,.docx,.xlsx,.pptx,.zip,.txt,.csv,.md,.log';
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

export function attachmentKind(attachment: Pick<Attachment, 'kind' | 'mimeType' | 'name'>) {
  if (attachment.kind) return attachment.kind;
  if (attachment.mimeType?.startsWith('video/')) return 'video';
  if (attachment.mimeType && !attachment.mimeType.startsWith('image/')) return 'document';
  return 'image';
}

/** Kind of a local file before upload, used to apply the size limits early. */
export function fileKind(file: File): AttachmentKind | null {
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? '';
  if (/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return 'image';
  if (/^video\/(mp4|webm|quicktime)$/.test(file.type) || ['mp4', 'webm', 'mov'].includes(extension))
    return 'video';
  if (['pdf', 'docx', 'xlsx', 'pptx', 'zip', 'txt', 'csv', 'md', 'log'].includes(extension))
    return 'document';
  return null;
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)} MB`;
}
