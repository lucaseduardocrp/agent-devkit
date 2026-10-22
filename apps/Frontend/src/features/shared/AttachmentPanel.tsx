import { useState, type ChangeEvent, type DragEvent } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_LIMITS,
  MAX_ATTACHMENTS,
  attachmentKind,
  fileKind,
  formatBytes,
  type Attachment,
  type AttachmentScope,
} from './attachment-types.js';
import {
  MediaImage,
  createDraft,
  isAdkMediaPath,
  resolveMedia,
  useMediaClient,
  useMediaSource,
} from './media.js';

interface Props {
  /** Defaults to the client of the surrounding MediaProvider. */
  apiClient?: ApiClient;
  attachments: readonly Attachment[];
  scope: AttachmentScope;
  onChange?: (attachments: Attachment[]) => void;
  /** Puts an image attachment in the item text; shown on images when set. */
  onInsertInline?: (attachment: Attachment) => void;
  disabled?: boolean;
}

const copy = {
  'pt-BR': {
    title: 'Anexos',
    url: 'URL do arquivo',
    addUrl: 'Adicionar URL',
    upload: 'Anexar arquivo',
    drop: 'Solte arquivos aqui ou use “Anexar arquivo”. Imagens até 10 MB, vídeos até 100 MB, documentos até 25 MB.',
    remove: 'Remover anexo',
    download: 'Baixar',
    open: 'Abrir no provedor',
    insert: 'Inserir no texto',
    limit: `Máximo de ${MAX_ATTACHMENTS} anexos.`,
    invalidUrl: 'Informe uma URL HTTPS válida.',
    unsupported: 'Tipo de arquivo não suportado.',
    tooLarge: (name: string, limit: number) => `${name} passa do limite de ${limit} MB.`,
    unavailable: 'Arquivo indisponível',
  },
  'en-US': {
    title: 'Attachments',
    url: 'File URL',
    addUrl: 'Add URL',
    upload: 'Attach file',
    drop: 'Drop files here or use “Attach file”. Images up to 10 MB, videos up to 100 MB, documents up to 25 MB.',
    remove: 'Remove attachment',
    download: 'Download',
    open: 'Open at the provider',
    insert: 'Insert in text',
    limit: `Up to ${MAX_ATTACHMENTS} attachments.`,
    invalidUrl: 'Enter a valid HTTPS URL.',
    unsupported: 'Unsupported file type.',
    tooLarge: (name: string, limit: number) => `${name} is over the ${limit} MB limit.`,
    unavailable: 'File unavailable',
  },
} as const;

function documentIcon(name: string): string {
  const extension = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  if (extension === 'pdf') return 'ti-file-type-pdf';
  if (['doc', 'docx'].includes(extension)) return 'ti-file-type-doc';
  if (['xls', 'xlsx', 'csv'].includes(extension)) return 'ti-file-spreadsheet';
  if (['ppt', 'pptx'].includes(extension)) return 'ti-presentation';
  if (extension === 'zip') return 'ti-file-zip';
  return 'ti-file-text';
}

function VideoPreview({ attachment, label }: { attachment: Attachment; label: string }) {
  const media = useMediaSource(attachment.url);
  if (media.failed)
    return (
      <div className="flex h-40 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface-1)] text-xs text-[var(--text-muted)]">
        <i className="ti ti-video-off mr-2" aria-hidden="true" />
        {label}
      </div>
    );
  return media.src ? (
    <video
      src={media.src}
      controls
      preload="metadata"
      onError={media.onError}
      aria-label={attachment.name}
      className="max-h-60 w-full rounded-md border border-[var(--border)] bg-black"
    />
  ) : (
    <div className="h-40 animate-pulse rounded-md border border-[var(--border)] bg-[var(--surface-1)]" />
  );
}

export function AttachmentPanel({
  apiClient: givenClient,
  attachments,
  scope,
  onChange,
  onInsertInline,
  disabled = false,
}: Props) {
  const { locale } = useI18n();
  const contextClient = useMediaClient();
  const apiClient = givenClient ?? contextClient;
  const c = copy[locale];
  const [url, setUrl] = useState('');
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editable = Boolean(onChange && apiClient) && !disabled;
  const full = attachments.length >= MAX_ATTACHMENTS;

  const addUrl = () => {
    if (!onChange) return;
    if (full) {
      setError(c.limit);
      return;
    }
    try {
      const parsed = new URL(url.trim());
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error();
      const name = decodeURIComponent(
        parsed.pathname.split('/').filter(Boolean).at(-1) || parsed.hostname,
      );
      onChange([
        ...attachments,
        {
          id: crypto.randomUUID(),
          name,
          kind: fileKind(new File([], name)) ?? 'document',
          scope,
          source: 'url',
          url: parsed.toString(),
        },
      ]);
      setUrl('');
      setError(null);
    } catch {
      setError(c.invalidUrl);
    }
  };

  const addFiles = (files: readonly File[]) => {
    if (!onChange || !apiClient || !files.length) return;
    if (attachments.length + files.length > MAX_ATTACHMENTS) {
      setError(c.limit);
      return;
    }
    for (const file of files) {
      const kind = fileKind(file);
      if (!kind) {
        setError(`${file.name}: ${c.unsupported}`);
        return;
      }
      if (file.size > ATTACHMENT_LIMITS[kind]) {
        setError(c.tooLarge(file.name, ATTACHMENT_LIMITS[kind] / 1024 / 1024));
        return;
      }
    }
    setError(null);
    // Files stay in the browser as drafts; saving the item uploads them.
    onChange([...attachments, ...files.map((file) => createDraft(scope, file))]);
  };

  const download = async (attachment: Attachment) => {
    try {
      if (!apiClient) throw new Error();
      const objectUrl = await resolveMedia(apiClient, attachment.url);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = attachment.name;
      link.click();
    } catch {
      // Files of providers without an integration open where they are hosted.
      if (!isAdkMediaPath(attachment.url))
        window.open(attachment.url, '_blank', 'noopener,noreferrer');
      else setError(c.unavailable);
    }
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!editable) return;
    event.preventDefault();
    setDragging(false);
    addFiles([...event.dataTransfer.files]);
  };

  if (!editable && attachments.length === 0) return null;

  const remove = (attachment: Attachment) =>
    onChange?.(attachments.filter((item) => item.id !== attachment.id));

  return (
    <section
      className={`space-y-3 rounded-md ${dragging ? 'outline outline-2 outline-[var(--border-accent)]' : ''}`}
      aria-label={c.title}
      onDragOver={(event) => {
        if (!editable || !event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <i className="ti ti-paperclip text-[var(--text-accent)]" aria-hidden="true" />
        {c.title}
        {attachments.length > 0 && (
          <span className="text-xs font-normal text-[var(--text-muted)]">{attachments.length}</span>
        )}
      </h3>
      {attachments.length > 0 && (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {attachments.map((attachment) => {
            const kind = attachmentKind(attachment);
            return (
              <li
                key={`${attachment.scope}:${attachment.id}`}
                className="min-w-0 space-y-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-1)] p-2"
              >
                {kind === 'image' && (
                  <MediaImage
                    src={attachment.url}
                    alt={attachment.name}
                    className="max-h-52 w-full rounded object-contain"
                  />
                )}
                {kind === 'video' && <VideoPreview attachment={attachment} label={c.unavailable} />}
                <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                  {kind === 'document' && (
                    <i
                      className={`ti ${documentIcon(attachment.name)} text-lg text-[var(--text-accent)]`}
                      aria-hidden="true"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate" title={attachment.name}>
                    {attachment.name}
                    {attachment.size !== undefined && (
                      <span className="ml-1 opacity-70">· {formatBytes(attachment.size)}</span>
                    )}
                  </span>
                  {kind === 'image' && editable && onInsertInline && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`${c.insert}: ${attachment.name}`}
                      title={c.insert}
                      onClick={() => onInsertInline(attachment)}
                    >
                      <i className="ti ti-text-wrap text-sm" aria-hidden="true" />
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`${c.download}: ${attachment.name}`}
                    title={c.download}
                    onClick={() => void download(attachment)}
                  >
                    <i className="ti ti-download text-sm" aria-hidden="true" />
                  </Button>
                  {attachment.source === 'url' && (
                    <a
                      href={attachment.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={`${c.open}: ${attachment.name}`}
                      title={c.open}
                      className="inline-flex h-8 w-8 items-center justify-center rounded hover:bg-[var(--fill-ghost-hover)]"
                    >
                      <i className="ti ti-external-link text-sm" aria-hidden="true" />
                    </a>
                  )}
                  {editable && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`${c.remove}: ${attachment.name}`}
                      title={c.remove}
                      onClick={() => remove(attachment)}
                    >
                      <i className="ti ti-x text-sm" aria-hidden="true" />
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editable && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Input
              type="url"
              value={url}
              aria-label={c.url}
              placeholder="https://..."
              disabled={full}
              className="min-w-[200px] flex-1"
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addUrl();
                }
              }}
            />
            <Button type="button" variant="secondary" onClick={addUrl} disabled={full}>
              {c.addUrl}
            </Button>
            <label className="inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-sm font-semibold hover:bg-[var(--fill-ghost-hover)] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
              <i className="ti ti-upload" aria-hidden="true" />
              {c.upload}
              <Input
                type="file"
                accept={ATTACHMENT_ACCEPT}
                multiple
                disabled={full}
                onChange={(event: ChangeEvent<HTMLInputElement>) => {
                  const files = [...(event.currentTarget.files ?? [])];
                  event.currentTarget.value = '';
                  addFiles(files);
                }}
                className="sr-only"
              />
            </label>
          </div>
          <p className="text-xs text-[var(--text-muted)]">{c.drop}</p>
          {error && (
            <p role="alert" className="text-xs text-red-300">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
