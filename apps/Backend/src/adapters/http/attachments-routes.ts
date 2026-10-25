import express, { Router, type Request } from 'express';
import { z } from 'zod';
import type { E2eArtifactStore } from '../../modules/e2e/application/artifact-store.js';
import type { DynamicProviderFactory } from '../../modules/integrations/application/dynamic-provider-factory.js';
import {
  MAX_ATTACHMENTS,
  MAX_UPLOAD_BYTES,
  attachmentContentKey,
  attachmentFileUrl,
  attachmentLimits,
  attachmentMetaKey,
  attachmentMimeTypes,
  attachmentScopes,
  contentDisposition,
  detectAttachmentType,
  readAttachmentMeta,
  type Attachment,
  type AttachmentScope,
  type StoredAttachmentMeta,
} from '../../modules/shared/attachment.js';
import {
  detectImageMimeType,
  imageKey,
  imageMimeTypes,
  isPublicHttpsUrl,
} from '../../modules/shared/image-attachment.js';
import { deleteFile } from '../../modules/shared/attachment-files.js';
import type { PermissionModule } from '../../modules/workspaces/domain/permissions.js';
import { ApplicationError } from '../../shared/errors.js';
import { requireAuth } from './auth-middleware.js';
import { requireModuleAccess } from './module-policy.js';
import type { RequestContextResolver } from './compatibility-routes.js';

const scopeSchema = z.enum(attachmentScopes);
const kindSchema = z.enum(['image', 'video', 'document']);
const nameSchema = z.string().trim().min(1).max(200);
const attachmentSchema = z.discriminatedUnion('source', [
  z.object({
    id: z.string().uuid(),
    name: nameSchema,
    kind: kindSchema.optional(),
    mimeType: z.string().max(120).optional(),
    size: z.number().int().nonnegative().optional(),
    scope: scopeSchema,
    source: z.literal('adk'),
    url: z.string().max(500).optional(),
  }),
  z.object({
    id: z.string().min(1).max(2100),
    name: nameSchema,
    kind: kindSchema.optional(),
    mimeType: z.string().max(120).optional(),
    size: z.number().int().nonnegative().optional(),
    scope: scopeSchema,
    source: z.literal('url'),
    url: z.string().url().max(2000),
  }),
]);

const scopeModules: Readonly<Record<AttachmentScope, PermissionModule>> = {
  issue: 'issues',
  pbi: 'pbis',
  brain: 'brain',
  spec: 'specs',
  testcase: 'testplans',
};

function workspaceId(request: Request): string {
  const id = request.context?.workspaceId;
  if (!id) throw new ApplicationError('WORKSPACE_REQUIRED', 'Workspace context is required.', 400);
  return id;
}

function requireModule(request: Request, scope: AttachmentScope, operation: 'view' | 'edit') {
  if (operation === 'edit' && request.context?.tokenScope === 'read')
    throw new ApplicationError('FORBIDDEN', 'Workspace write access is required.', 403);
  requireModuleAccess(request.context, [{ module: scopeModules[scope], operation }]);
}

/** `value` already passed the schema's URL check, so it always parses. */
function validExternalUrl(value: string): boolean {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password;
}

/**
 * Checks the attachments sent with an item. Files uploaded to the ADK must exist in this
 * workspace and keep the type found on upload; external files must use HTTPS.
 */
export async function validateAttachments(
  store: E2eArtifactStore,
  workspaceId: string,
  input: readonly unknown[],
  allowedScopes: readonly AttachmentScope[],
): Promise<Attachment[]> {
  if (input.length > MAX_ATTACHMENTS)
    throw new ApplicationError(
      'VALIDATION_ERROR',
      `An item can have up to ${MAX_ATTACHMENTS} attachments.`,
      400,
    );
  const parsed = z.array(attachmentSchema).safeParse(input);
  if (!parsed.success)
    throw new ApplicationError('VALIDATION_ERROR', 'An attachment is invalid.', 400);
  const ids = new Set<string>();
  const result: Attachment[] = [];
  for (const attachment of parsed.data) {
    if (!allowedScopes.includes(attachment.scope))
      throw new ApplicationError('VALIDATION_ERROR', 'Attachment scope is invalid.', 400);
    if (ids.has(attachment.id))
      throw new ApplicationError('VALIDATION_ERROR', 'Attachments cannot be repeated.', 400);
    ids.add(attachment.id);
    if (attachment.source === 'url') {
      if (!validExternalUrl(attachment.url))
        throw new ApplicationError('VALIDATION_ERROR', 'Attachment URLs must use HTTPS.', 400);
      result.push(attachment);
      continue;
    }
    if (attachment.kind) {
      const meta = await readAttachmentMeta(store, workspaceId, attachment.id);
      if (!meta)
        throw new ApplicationError('VALIDATION_ERROR', 'Uploaded file was not found.', 400);
      result.push({
        id: meta.id,
        name: attachment.name,
        kind: meta.kind,
        mimeType: meta.mimeType,
        size: meta.size,
        scope: attachment.scope,
        source: 'adk',
        url: attachmentFileUrl(meta.id),
      });
      continue;
    }
    // Images uploaded before generic attachments keep their original storage key.
    const legacy = { ...attachment, url: '' };
    const bytes = imageMimeTypes.includes(attachment.mimeType as (typeof imageMimeTypes)[number])
      ? await store.get(imageKey(workspaceId, legacy))
      : null;
    if (!bytes || detectImageMimeType(bytes) !== attachment.mimeType)
      throw new ApplicationError(
        'VALIDATION_ERROR',
        'Uploaded image was not found or is invalid.',
        400,
      );
    result.push({ ...legacy, url: `/attachments/images/${attachment.scope}/${attachment.id}` });
  }
  return result;
}

/** @deprecated Use validateAttachments; kept for callers written for image-only uploads. */
export const validateImageAttachments = validateAttachments;

const PROXY_REDIRECTS = 3;

/**
 * Downloads a file hosted by an integration. Credentials only go to the integration's own
 * host; redirects (e.g. to signed storage URLs) are followed without them, and every hop
 * must resolve to a public address.
 */
async function fetchExternalFile(
  url: URL,
  authorization: Record<string, string>,
  fetcher: typeof fetch,
): Promise<{ bytes: Buffer; name: string } | null> {
  let current = url;
  for (let hop = 0; hop <= PROXY_REDIRECTS; hop++) {
    if (!(await isPublicHttpsUrl(current.toString()))) return null;
    const response = await fetcher(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
      headers: current.host === url.host ? authorization : {},
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current);
      continue;
    }
    if (!response.ok || !response.body) return null;
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_UPLOAD_BYTES) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPLOAD_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const disposition = response.headers.get('content-disposition') ?? '';
    const name =
      /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1] ??
      /filename="?([^";]+)"?/i.exec(disposition)?.[1] ??
      url.searchParams.get('fileName') ??
      url.searchParams.get('path')?.split('/').at(-1) ??
      url.pathname.split('/').at(-1)!;
    return {
      bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
      name: decodeURIComponent(name),
    };
  }
  return null;
}

function sendFile(
  response: express.Response,
  bytes: Buffer,
  mimeType: string,
  name: string,
  cache: string,
) {
  const kind = attachmentMimeTypes[mimeType];
  response
    .setHeader('Content-Type', mimeType)
    .setHeader('Content-Length', String(bytes.length))
    .setHeader(
      'Content-Disposition',
      contentDisposition(kind === 'document' ? 'attachment' : 'inline', name),
    )
    .setHeader('Cache-Control', cache)
    .setHeader('X-Content-Type-Options', 'nosniff')
    .setHeader('Content-Security-Policy', "sandbox; default-src 'none'")
    .send(bytes);
}

export function createAttachmentsRouter(
  store: E2eArtifactStore,
  contextResolver?: RequestContextResolver,
  providers?: DynamicProviderFactory,
  fetcher: typeof fetch = fetch,
): Router {
  const router = Router();
  if (contextResolver)
    router.use('/attachments', async (request, response, next) => {
      try {
        request.context = await contextResolver(request, response);
        next();
      } catch (error) {
        next(error);
      }
    });

  router.post(
    '/attachments/files',
    requireAuth,
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
    async (request, response, next) => {
      try {
        const scope = scopeSchema.parse(request.query['scope']);
        const name = nameSchema.parse(request.query['name']);
        requireModule(request, scope, 'edit');
        // express.raw above accepts every content type, so the body is always a Buffer.
        const bytes = request.body as Buffer;
        if (!bytes.length)
          throw new ApplicationError('VALIDATION_ERROR', 'The file is empty.', 400);
        const detected = detectAttachmentType(bytes, name);
        if (!detected)
          throw new ApplicationError(
            'ATTACHMENT_TYPE_UNSUPPORTED',
            'Supported files: images (PNG, JPEG, WebP, GIF), videos (MP4, WebM, MOV) and documents (PDF, Word, Excel, PowerPoint, ZIP, TXT, CSV, Markdown).',
            415,
          );
        if (bytes.length > attachmentLimits[detected.kind])
          throw new ApplicationError(
            'ATTACHMENT_TOO_LARGE',
            `This file is larger than the ${attachmentLimits[detected.kind] / 1024 / 1024} MB allowed for ${detected.kind}s.`,
            413,
          );
        const meta: StoredAttachmentMeta = {
          id: crypto.randomUUID(),
          name,
          kind: detected.kind,
          mimeType: detected.mimeType,
          size: bytes.length,
          scope,
          ...(request.context?.actorId ? { createdBy: request.context.actorId } : {}),
          // Only a saved item makes the file permanent; see attachment-files.ts.
          status: 'pending',
          createdAt: new Date().toISOString(),
        };
        const workspace = workspaceId(request);
        await store.put(attachmentContentKey(workspace, meta.id), bytes);
        await store.put(
          attachmentMetaKey(workspace, meta.id),
          Buffer.from(JSON.stringify(meta), 'utf8'),
        );
        const attachment: Attachment = {
          id: meta.id,
          name: meta.name,
          kind: meta.kind,
          mimeType: meta.mimeType,
          size: meta.size,
          scope,
          source: 'adk',
          url: attachmentFileUrl(meta.id),
        };
        response.status(201).json({ attachment });
      } catch (error) {
        next(error);
      }
    },
  );

  router.get('/attachments/files/:id', requireAuth, async (request, response, next) => {
    try {
      const id = z.string().uuid().parse(request.params['id']);
      const workspace = workspaceId(request);
      const meta = await readAttachmentMeta(store, workspace, id);
      if (!meta) throw new ApplicationError('ATTACHMENT_NOT_FOUND', 'File not found.', 404);
      requireModule(request, meta.scope, 'view');
      const bytes = await store.get(attachmentContentKey(workspace, id));
      if (!bytes) throw new ApplicationError('ATTACHMENT_NOT_FOUND', 'File not found.', 404);
      sendFile(response, bytes, meta.mimeType, meta.name, 'private, max-age=3600, immutable');
    } catch (error) {
      next(error);
    }
  });

  // Discards an upload whose item was not saved (the save failed after uploading).
  router.delete('/attachments/files/:id', requireAuth, async (request, response, next) => {
    try {
      const id = z.string().uuid().parse(request.params['id']);
      const workspace = workspaceId(request);
      const meta = await readAttachmentMeta(store, workspace, id);
      if (!meta) {
        response.status(204).end();
        return;
      }
      requireModule(request, meta.scope, 'edit');
      if (meta.status !== 'pending' || meta.createdBy !== request.context?.actorId)
        throw new ApplicationError(
          'ATTACHMENT_IN_USE',
          'Only unsaved uploads can be discarded; saved files go away with their item.',
          409,
        );
      await deleteFile(store, workspace, id);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  router.get('/attachments/proxy', requireAuth, async (request, response, next) => {
    try {
      const raw = z.string().url().max(2000).parse(request.query['url']);
      const url = new URL(raw);
      if (url.protocol !== 'https:' || url.username || url.password)
        throw new ApplicationError('VALIDATION_ERROR', 'Only HTTPS files can be shown.', 400);
      const authorization = await providers?.resolveMediaAuthorization(workspaceId(request), url);
      if (!authorization)
        throw new ApplicationError(
          'ATTACHMENT_HOST_NOT_INTEGRATED',
          'This file is not hosted by an integration of the workspace.',
          403,
        );
      const file = await fetchExternalFile(url, authorization, fetcher);
      if (!file)
        throw new ApplicationError(
          'ATTACHMENT_UNAVAILABLE',
          'The provider did not return the file.',
          502,
        );
      const detected = detectAttachmentType(file.bytes, file.name);
      if (!detected)
        throw new ApplicationError(
          'ATTACHMENT_TYPE_UNSUPPORTED',
          'The provider returned an unsupported file type.',
          415,
        );
      sendFile(response, file.bytes, detected.mimeType, file.name, 'private, max-age=300');
    } catch (error) {
      next(error);
    }
  });

  // Images uploaded before generic attachments existed.
  router.get('/attachments/images/:scope/:id', requireAuth, async (request, response, next) => {
    try {
      const scope = scopeSchema.parse(request.params['scope']);
      const id = z.string().uuid().parse(request.params['id']);
      requireModule(request, scope, 'view');
      for (const mimeType of imageMimeTypes) {
        const bytes = await store.get(imageKey(workspaceId(request), { id, scope, mimeType }));
        if (bytes && detectImageMimeType(bytes) === mimeType) {
          sendFile(response, bytes, mimeType, id, 'private, max-age=300');
          return;
        }
      }
      throw new ApplicationError('IMAGE_NOT_FOUND', 'Image not found.', 404);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
