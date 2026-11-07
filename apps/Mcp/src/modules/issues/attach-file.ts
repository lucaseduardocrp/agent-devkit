import { readFile, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import { segment } from '../../api/http-client.js';
import type { ToolContext } from '../../core/tool.js';

/** Largest file the backend accepts (videos); it applies the per-type limits itself. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
/** Uploading a video can take longer than the default request timeout. */
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

export const attachFileInput = {
  issueId: z.string().trim().min(1).max(500).describe('Issue (card) that receives the file.'),
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      'File name with its extension, e.g. review.html or summary.pdf. The extension matters for text files (html, md, csv, json...).',
    ),
  filePath: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      'Path of a file on the user computer. Best for videos, images and PDFs. Only works when the MCP server runs locally (stdio).',
    ),
  contentBase64: z
    .string()
    .min(1)
    .optional()
    .describe('File bytes as base64. Fits small binary files when no local path is available.'),
  text: z
    .string()
    .min(1)
    .optional()
    .describe('UTF-8 text content for html, md, txt, csv, tsv, json, xml or yaml files.'),
};

export interface AttachFileInput {
  readonly issueId: string;
  readonly name: string;
  readonly filePath?: string | undefined;
  readonly contentBase64?: string | undefined;
  readonly text?: string | undefined;
}

interface UploadedAttachment {
  readonly id: string;
  readonly name: string;
  readonly kind?: string;
  readonly mimeType?: string;
  readonly size?: number;
  readonly url: string;
}

/** Reads the file bytes from whichever source the caller gave; exactly one is required. */
export async function readAttachmentBytes(
  input: AttachFileInput,
  context: Pick<ToolContext, 'allowLocalFiles'>,
): Promise<Buffer> {
  const sources = [input.filePath, input.contentBase64, input.text].filter(
    (value) => value !== undefined,
  );
  if (sources.length !== 1) throw new Error('Send exactly one of filePath, contentBase64 or text.');

  let bytes: Buffer;
  if (input.filePath !== undefined) {
    if (!context.allowLocalFiles)
      throw new Error(
        'filePath only works when the ADK MCP server runs on your computer. Send contentBase64 or text instead.',
      );
    const path = resolve(input.filePath);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) throw new Error(`Not a readable file: ${path}`);
    if (info.size > MAX_ATTACHMENT_BYTES)
      throw new Error(`The file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
    bytes = await readFile(path);
  } else if (input.contentBase64 !== undefined) {
    const encoded = input.contentBase64.replace(/^data:[^,]*;base64,/i, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) throw new Error('contentBase64 is not valid.');
    bytes = Buffer.from(encoded, 'base64');
  } else {
    bytes = Buffer.from(input.text!, 'utf8');
  }
  if (!bytes.length) throw new Error('The file is empty.');
  if (bytes.length > MAX_ATTACHMENT_BYTES)
    throw new Error(`The file is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
  return bytes;
}

/**
 * Uploads a file and saves it in the attachments of an issue. The backend detects the type from
 * the content, enforces the size limit of that type and the 20 attachments per item.
 */
export async function attachFileToIssue(input: AttachFileInput, context: ToolContext) {
  const bytes = await readAttachmentBytes(input, context);
  const name = basename(input.name.replace(/\\/g, '/'));
  const { api } = context;

  const { attachment } = await api.request<{ attachment: UploadedAttachment }>({
    method: 'POST',
    path: '/attachments/files',
    query: { scope: 'issue', name },
    rawBody: { data: bytes, contentType: 'application/octet-stream' },
    timeoutMs: UPLOAD_TIMEOUT_MS,
  });

  try {
    const { issue } = await api.request<{ issue: { attachments?: unknown[] } }>({
      method: 'GET',
      path: `/issues/${segment(input.issueId)}`,
    });
    const attachments = [...(issue.attachments ?? []), attachment];
    await api.request({
      method: 'PATCH',
      path: `/issues/${segment(input.issueId)}`,
      body: { attachments },
    });
    return { attachment, attachmentCount: attachments.length };
  } catch (error) {
    // The upload stays "pending" until an issue saves it; drop it so a failed attach leaves nothing.
    await api
      .request({ method: 'DELETE', path: `/attachments/files/${segment(attachment.id)}` })
      .catch(() => undefined);
    throw error;
  }
}
