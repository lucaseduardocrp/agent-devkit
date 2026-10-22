import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ImgHTMLAttributes,
  type ReactNode,
  type RefObject,
} from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { Attachment, AttachmentScope } from './attachment-types.js';
import { ATTACHMENT_LIMITS, fileKind } from './attachment-types.js';

/**
 * Files shown inside texts and attachment lists come from two places: the ADK storage
 * (`/attachments/...`, which needs the session headers) and the providers that host them.
 * Public provider files load directly; private ones (Azure DevOps, Jira...) go through the
 * server, which uses the workspace integration to fetch them.
 */
const MediaContext = createContext<ApiClient | null>(null);

export function MediaProvider({
  apiClient,
  children,
}: {
  apiClient: ApiClient;
  children: ReactNode;
}) {
  return <MediaContext.Provider value={apiClient}>{children}</MediaContext.Provider>;
}

export function useMediaClient(): ApiClient | null {
  return useContext(MediaContext);
}

const ADK_MEDIA_PATH = /^\/attachments\/(?:files|images|drafts)\/[A-Za-z0-9/_-]+$/;

export function isAdkMediaPath(src: string): boolean {
  return ADK_MEDIA_PATH.test(src);
}

/**
 * Drafts: files pasted or attached while editing stay in this browser tab, referenced by
 * `/attachments/drafts/:id`, until the item is saved. `commitDrafts` uploads the ones the
 * saved content still references and rewrites them to `/attachments/files/:id`;
 * `discardDrafts` forgets them when the edit is cancelled. Nothing reaches the server
 * before saving.
 */
const DRAFT_PATH = '/attachments/drafts/';
const DRAFT_REFERENCE =
  /\/attachments\/drafts\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi;
const drafts = new Map<string, { file: File; url: string }>();

function draftIds(value: unknown): string[] {
  const text = JSON.stringify(value) ?? '';
  return [...new Set([...text.matchAll(DRAFT_REFERENCE)].map((match) => match[1]!))];
}

/** Keeps a local file as a draft attachment of the item being edited. */
export function createDraft(scope: AttachmentScope, file: File): Attachment {
  const kind = fileKind(file);
  if (!kind) throw new Error(`${file.name}: unsupported file type`);
  if (file.size > ATTACHMENT_LIMITS[kind])
    throw new Error(`${file.name}: max ${ATTACHMENT_LIMITS[kind] / 1024 / 1024} MB`);
  const id = crypto.randomUUID();
  drafts.set(id, { file, url: URL.createObjectURL(file) });
  return {
    id,
    name: file.name || 'file',
    kind,
    ...(file.type ? { mimeType: file.type } : {}),
    size: file.size,
    scope,
    source: 'adk',
    url: `${DRAFT_PATH}${id}`,
  };
}

/** Forgets the drafts a cancelled edit referenced; they were never uploaded. */
export function discardDrafts(value: unknown): void {
  for (const id of draftIds(value)) {
    const draft = drafts.get(id);
    if (draft) URL.revokeObjectURL(draft.url);
    drafts.delete(id);
  }
}

/**
 * Uploads the drafts `value` references and returns it pointing at the stored files.
 * Drafts no longer referenced (removed before saving) are never uploaded.
 */
async function commitDrafts<T>(
  apiClient: ApiClient,
  scope: AttachmentScope,
  value: T,
): Promise<{ value: T; uploaded: Attachment[] }> {
  const uploaded: Attachment[] = [];
  let text = JSON.stringify(value) ?? '';
  try {
    for (const id of draftIds(value)) {
      const draft = drafts.get(id);
      if (!draft) throw new Error('A pasted file is no longer available; add it again.');
      const stored = await apiClient.uploadAttachment(scope, draft.file);
      uploaded.push(stored);
      text = text.replaceAll(`${DRAFT_PATH}${id}`, stored.url).replaceAll(id, stored.id);
    }
  } catch (error) {
    await discardUploads(apiClient, uploaded);
    throw error;
  }
  return { value: JSON.parse(text) as T, uploaded };
}

async function discardUploads(apiClient: ApiClient, uploaded: readonly Attachment[]) {
  // Best effort: the server also removes unsaved uploads after an hour.
  await Promise.all(uploaded.map((file) => apiClient.deleteAttachment(file.id).catch(() => {})));
}

/**
 * Saves an item whose content may reference drafts: uploads them, saves, and removes the
 * uploads again if the save fails, so only a confirmed save leaves files on the server.
 */
export async function saveWithDrafts<T, R>(
  apiClient: ApiClient,
  scope: AttachmentScope,
  value: T,
  save: (value: T) => Promise<R>,
): Promise<R> {
  const committed = await commitDrafts(apiClient, scope, value);
  try {
    const result = await save(committed.value);
    discardDrafts(value);
    return result;
  } catch (error) {
    await discardUploads(apiClient, committed.uploaded);
    throw error;
  }
}

/** Image sources kept by the HTML sanitizers: HTTPS links and files stored by the ADK. */
export function isSafeImageSource(src: string): boolean {
  if (isAdkMediaPath(src.trim())) return true;
  try {
    const url = new URL(src);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

const objectUrls = new WeakMap<ApiClient, Map<string, Promise<string>>>();

/** Object URL of a file loaded with the session (ADK files) or through the server proxy. */
export function resolveMedia(apiClient: ApiClient, src: string): Promise<string> {
  let cache = objectUrls.get(apiClient);
  if (!cache) objectUrls.set(apiClient, (cache = new Map<string, Promise<string>>()));
  if (src.startsWith(DRAFT_PATH)) {
    const draft = drafts.get(src.slice(DRAFT_PATH.length));
    return draft ? Promise.resolve(draft.url) : Promise.reject(new Error('Draft discarded'));
  }
  let pending = cache.get(src);
  if (!pending) {
    pending = apiClient.getMedia(src).then((blob) => URL.createObjectURL(blob));
    pending.catch(() => cache.delete(src));
    cache.set(src, pending);
  }
  return pending;
}

/**
 * Source to give an `<img>`/`<video>`: ADK files once loaded, provider files directly
 * first and through the server when the direct load fails (`onError`).
 */
export function useMediaSource(src: string): {
  src: string | undefined;
  failed: boolean;
  onError: () => void;
} {
  const apiClient = useMediaClient();
  const adk = isAdkMediaPath(src);
  const [resolved, setResolved] = useState<string | undefined>(adk ? undefined : src);
  const [proxied, setProxied] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
    setProxied(adk);
    if (!adk) {
      setResolved(src);
      return;
    }
    setResolved(undefined);
    if (!apiClient) {
      setFailed(true);
      return;
    }
    let active = true;
    resolveMedia(apiClient, src).then(
      (url) => active && setResolved(url),
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, [apiClient, adk, src]);

  const onError = () => {
    if (proxied || !apiClient) {
      setFailed(true);
      return;
    }
    setProxied(true);
    resolveMedia(apiClient, src).then(setResolved, () => setFailed(true));
  };
  return { src: resolved, failed, onError };
}

type MediaImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & { src: string };

/** An image whose file may be stored by the ADK or hosted by an integration. */
export function MediaImage({ src, alt, className, ...props }: MediaImageProps) {
  const apiClient = useMediaClient();
  const media = useMediaSource(src);
  // Static rendering (no provider) keeps the original address; live views resolve it.
  if (!apiClient) return <img src={src} alt={alt} className={className} {...props} />;
  if (media.failed)
    return (
      <span
        role="img"
        aria-label={alt}
        title={alt}
        className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--text-muted)]"
      >
        <i className="ti ti-photo-exclamation" aria-hidden="true" />
        {alt}
      </span>
    );
  return media.src ? (
    <img
      src={media.src}
      alt={alt}
      loading="lazy"
      onError={media.onError}
      className={className}
      data-media-managed=""
      {...props}
    />
  ) : (
    <span
      aria-busy="true"
      aria-label={alt}
      className="inline-block h-24 w-40 animate-pulse rounded bg-[var(--surface-2)]"
    />
  );
}

const ORIGINAL_SRC = 'data-adk-src';

/**
 * Points the `<img>` of HTML rendered with `dangerouslySetInnerHTML` at loadable files.
 * The original address stays in `data-adk-src`, so editors can save it with `editorHtml`.
 */
export function resolveInlineImages(root: HTMLElement, apiClient: ApiClient): void {
  for (const image of root.querySelectorAll('img:not([data-media-managed])')) {
    if (!(image instanceof HTMLImageElement)) continue;
    const original = image.getAttribute(ORIGINAL_SRC) ?? image.getAttribute('src') ?? '';
    if (!original || image.dataset['adkResolved'] === original) continue;
    image.dataset['adkResolved'] = original;
    image.setAttribute(ORIGINAL_SRC, original);
    image.loading = 'lazy';
    const proxy = () =>
      resolveMedia(apiClient, original).then(
        (url) => {
          image.src = url;
        },
        () => {
          image.alt ||= original.split('/').pop() ?? '';
          image.classList.add('opacity-40');
        },
      );
    if (isAdkMediaPath(original)) {
      image.removeAttribute('src');
      void proxy();
    } else {
      image.addEventListener('error', () => void proxy(), { once: true });
    }
  }
}

export function useInlineImages(ref: RefObject<HTMLElement | null>, content: unknown): void {
  const apiClient = useMediaClient();
  useEffect(() => {
    if (ref.current && apiClient) resolveInlineImages(ref.current, apiClient);
  }, [apiClient, content, ref]);
}

/** HTML of an editor with the original image addresses, ready to be sanitized and saved. */
export function editorHtml(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  for (const image of copy.querySelectorAll('img')) {
    const original = image.getAttribute(ORIGINAL_SRC);
    if (original) image.setAttribute('src', original);
    image.removeAttribute(ORIGINAL_SRC);
    image.removeAttribute('data-adk-resolved');
    image.removeAttribute('loading');
    image.classList.remove('opacity-40');
    if (!image.classList.length) image.removeAttribute('class');
  }
  return copy.innerHTML;
}

function droppedImages(transfer: DataTransfer | null): File[] {
  return [...(transfer?.files ?? [])].filter((file) => fileKind(file) === 'image');
}

function draftImages(scope: AttachmentScope, files: readonly File[]): Attachment[] {
  return files.map((file) => createDraft(scope, file));
}

export function markdownImage(attachment: Attachment): string {
  return `![${attachment.name.replace(/[[\]\n]/g, ' ')}](${attachment.url})`;
}

/** The editor's caret, when it is inside the editor. */
function currentRange(root: HTMLElement): Range | undefined {
  const selection = window.getSelection();
  return selection?.rangeCount && root.contains(selection.getRangeAt(0).commonAncestorContainer)
    ? selection.getRangeAt(0).cloneRange()
    : undefined;
}

interface ImageInputState {
  readonly error: string | null;
}

/**
 * Pasting or dropping images in a Markdown textarea keeps them as drafts and writes
 * `![name](/attachments/drafts/:id)` where the cursor was; saving uploads them.
 */
export function useMarkdownImageInput(
  scope: AttachmentScope,
  onChange: (value: string) => void,
): ImageInputState & {
  onPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onDrop: (event: DragEvent<HTMLTextAreaElement>) => void;
  insertFiles: (textarea: HTMLTextAreaElement, files: readonly File[]) => void;
} {
  const apiClient = useMediaClient();
  const [state, setState] = useState<ImageInputState>({ error: null });
  const insertFiles = (textarea: HTMLTextAreaElement, files: readonly File[]) => {
    if (!apiClient || !files.length) return;
    try {
      const images = draftImages(scope, files);
      const current = textarea.value;
      const before = current.slice(0, textarea.selectionStart);
      const text = images.map(markdownImage).join('\n\n');
      onChange(
        `${before}${before && !before.endsWith('\n') ? '\n\n' : ''}${text}\n\n${current.slice(textarea.selectionEnd)}`,
      );
      setState({ error: null });
    } catch (reason) {
      setState({ error: reason instanceof Error ? reason.message : String(reason) });
    }
  };
  return {
    ...state,
    insertFiles,
    onPaste: (event) => {
      const files = droppedImages(event.clipboardData);
      if (!files.length || !apiClient) return;
      event.preventDefault();
      insertFiles(event.currentTarget, files);
    },
    onDrop: (event) => {
      const files = droppedImages(event.dataTransfer);
      if (!files.length || !apiClient) return;
      event.preventDefault();
      insertFiles(event.currentTarget, files);
    },
  };
}

/**
 * Pasting or dropping images in a rich text editor (`contentEditable`) keeps them as
 * drafts and inserts `<img>` at the cursor; `onChange` receives the editor HTML.
 */
export function useRichTextImageInput(
  scope: AttachmentScope,
  editor: RefObject<HTMLElement | null>,
  onChange: (html: string) => void,
): ImageInputState & {
  onPaste: (event: ClipboardEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
  insertFiles: (files: readonly File[]) => void;
  insertAttachment: (attachment: Attachment) => void;
} {
  const apiClient = useMediaClient();
  const [state, setState] = useState<ImageInputState>({ error: null });
  const place = (attachments: readonly Attachment[], range: Range | undefined) => {
    const root = editor.current;
    if (!apiClient || !root) return;
    const fragment = document.createDocumentFragment();
    for (const attachment of attachments) {
      const image = document.createElement('img');
      image.setAttribute('src', attachment.url);
      image.setAttribute('alt', attachment.name);
      const paragraph = document.createElement('p');
      paragraph.append(image);
      fragment.append(paragraph);
    }
    if (range && root.contains(range.commonAncestorContainer)) {
      range.collapse(false);
      range.insertNode(fragment);
    } else {
      root.append(fragment);
    }
    resolveInlineImages(root, apiClient);
    onChange(editorHtml(root));
  };
  const insertFiles = (files: readonly File[], at?: Range) => {
    const root = editor.current;
    if (!apiClient || !root || !files.length) return;
    try {
      place(draftImages(scope, files), at ?? currentRange(root));
      setState({ error: null });
    } catch (reason) {
      setState({ error: reason instanceof Error ? reason.message : String(reason) });
    }
  };
  return {
    ...state,
    insertFiles: (files) => insertFiles(files),
    insertAttachment: (attachment) => {
      if (editor.current) place([attachment], currentRange(editor.current));
    },
    onPaste: (event) => {
      const files = droppedImages(event.clipboardData);
      if (!files.length || !apiClient) return;
      event.preventDefault();
      insertFiles(files);
    },
    onDrop: (event) => {
      const files = droppedImages(event.dataTransfer);
      if (!files.length || !apiClient) return;
      event.preventDefault();
      const caret = document.caretRangeFromPoint?.(event.clientX, event.clientY) ?? undefined;
      insertFiles(files, caret);
    },
  };
}

/** Hint and errors of images pasted or dropped in a text field. */
export function ImageInputStatus({ state }: { state: ImageInputState }) {
  const { locale } = useI18n();
  if (state.error)
    return (
      <span role="alert" className="block text-xs text-red-300">
        {state.error}
      </span>
    );
  return (
    <span className="block text-xs text-[var(--text-muted)]">
      {locale === 'pt-BR'
        ? 'Cole ou arraste imagens para colocá-las no texto.'
        : 'Paste or drop images to place them in the text.'}
    </span>
  );
}
