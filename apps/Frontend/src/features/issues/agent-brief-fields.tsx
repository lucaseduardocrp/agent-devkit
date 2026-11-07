import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import {
  SearchableSelect,
  type SearchableSelectOption,
} from '../../components/ui/searchable-select.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { ApiClient } from '../../lib/api-client.js';
import {
  ATTACHMENT_ACCEPT,
  ATTACHMENT_LIMITS,
  MAX_ATTACHMENTS,
  fileKind,
  formatBytes,
  type Attachment,
} from '../shared/attachment-types.js';
import { plainText, type ReferenceDetail } from './agent-brief-reference-text.js';
import { openReferencedFile } from './agent-brief-reference-open.js';
import { ReferenceViewer } from './agent-brief-reference-viewer.js';
import {
  BRIEF_REFERENCE_KINDS,
  type BriefReference,
  type BriefReferenceKind,
} from './agent-brief-types.js';

/** The backend rejects a longer list on save. */
const MAX_REFERENCES = 30;
const MAX_LABEL = 300;

const copy = {
  'pt-BR': {
    useTyped: (text: string) => `Usar “${text}”`,
    kind: 'Tipo',
    kinds: {
      pbi: 'PBI',
      issue: 'Issue',
      attachment: 'Anexo',
      brain: 'Brain',
      spec: 'Spec',
      testplan: 'Plano de testes',
      file: 'Arquivo',
    },
    target: 'Item',
    reason: 'Motivo',
    reasonPlaceholder: 'Por que o agente deve ler isto primeiro?',
    pick: {
      pbi: 'Buscar PBI…',
      issue: 'Buscar issue…',
      attachment: 'Escolher anexo…',
      brain: 'Buscar página do Brain…',
      spec: 'Buscar spec…',
      testplan: 'Buscar plano de testes…',
      file: 'Escolher arquivo…',
    },
    loading: 'Carregando…',
    open: 'Abrir',
    openHint: 'Abrir o item referenciado',
    openFile: 'Abrir o arquivo',
    openFailed: 'Não foi possível abrir o arquivo.',
    empty: 'Nada encontrado',
    loadFailed: 'Não foi possível carregar a lista.',
    noAttachments: 'Nenhum arquivo anexado ainda. Use “Anexar arquivo”.',
    upload: 'Anexar arquivo',
    uploading: 'Enviando…',
    uploadHint: 'O arquivo passa a fazer parte dos anexos da issue ao salvar.',
    unsupported: 'Tipo de arquivo não suportado.',
    tooLarge: (name: string, limit: number) => `${name} passa do limite de ${limit} MB.`,
    limit: `Máximo de ${MAX_ATTACHMENTS} anexos na issue.`,
    uploadFailed: 'Não foi possível enviar o arquivo.',
    remove: 'Remover referência',
  },
  'en-US': {
    useTyped: (text: string) => `Use “${text}”`,
    kind: 'Type',
    kinds: {
      pbi: 'PBI',
      issue: 'Issue',
      attachment: 'Attachment',
      brain: 'Brain',
      spec: 'Spec',
      testplan: 'Test plan',
      file: 'File',
    },
    target: 'Item',
    reason: 'Reason',
    reasonPlaceholder: 'Why should the agent read this first?',
    pick: {
      pbi: 'Search PBIs…',
      issue: 'Search issues…',
      attachment: 'Choose attachment…',
      brain: 'Search Brain pages…',
      spec: 'Search specs…',
      testplan: 'Search test plans…',
      file: 'Choose file…',
    },
    loading: 'Loading…',
    open: 'Open',
    openHint: 'Open the referenced item',
    openFile: 'Open the file',
    openFailed: 'The file could not be opened.',
    empty: 'Nothing found',
    loadFailed: 'The list could not be loaded.',
    noAttachments: 'No attached files yet. Use “Attach file”.',
    upload: 'Attach file',
    uploading: 'Uploading…',
    uploadHint: 'The file becomes an attachment of the issue when you save.',
    unsupported: 'Unsupported file type.',
    tooLarge: (name: string, limit: number) => `${name} is over the ${limit} MB limit.`,
    limit: `Up to ${MAX_ATTACHMENTS} attachments per issue.`,
    uploadFailed: 'The file could not be uploaded.',
    remove: 'Remove reference',
  },
} as const;

/**
 * A list of known values that also takes one the list does not have (a private model, a new
 * provider): the user types it in the same field and picks "Use “text”" in the list.
 */
export function ChoiceField({
  label,
  value,
  options,
  onChange,
  disabled,
  placeholder,
  emptyMessage,
}: {
  label: string;
  value: string;
  options: readonly SearchableSelectOption[];
  onChange: (value: string) => void;
  disabled: boolean;
  placeholder: string;
  emptyMessage: string;
}) {
  const { locale } = useI18n();
  const useTyped = copy[locale].useTyped;
  return (
    <SearchableSelect
      label={label}
      options={options}
      value={value}
      placeholder={placeholder}
      emptyMessage={emptyMessage}
      disabled={disabled}
      customOptionLabel={useTyped}
      onChange={(next) => {
        // Typing in the search box reports an empty value; that is not a choice.
        if (next) onChange(next);
      }}
    />
  );
}

type SourceKind = Exclude<BriefReferenceKind, 'attachment' | 'file'>;
interface Source {
  readonly options: SearchableSelectOption[];
  /** What opening a reference shows; undefined when the item is no longer in the source. */
  readonly detail: (ref: string) => ReferenceDetail | undefined;
}
type SourceState = { status: 'loading' | 'ready' | 'error' } & Source;
const NO_SOURCE: Source = { options: [], detail: () => undefined };

/** The options of a list, and the text each one opens, keeping the first entry of an id. */
function source<T>(
  items: readonly T[],
  id: (item: T) => string,
  label: (item: T) => string,
  detail: (item: T) => ReferenceDetail,
): Source {
  const byId = new Map<string, T>();
  for (const item of items) if (!byId.has(id(item))) byId.set(id(item), item);
  return {
    options: [...byId.entries()].map(([value, item]) => ({ value, label: label(item) })),
    detail: (ref) => {
      const item = byId.get(ref);
      return item === undefined ? undefined : detail(item);
    },
  };
}

const loaders: Record<SourceKind, (api: ApiClient, issueId: string) => Promise<Source>> = {
  pbi: async (api) =>
    source(
      await api.getPbiItems(),
      (item) => item.id,
      (item) => item.title,
      (item) => ({
        title: item.title,
        subtitle: `${item.kind} · ${item.status}`,
        body: plainText(item.description),
      }),
    ),
  issue: async (api, issueId) =>
    source(
      (await api.getIssues()).filter((issue) => issue.id !== issueId),
      (issue) => issue.id,
      (issue) => `#${issue.number} ${issue.title}`,
      (issue) => ({
        title: `#${issue.number} ${issue.title}`,
        subtitle: issue.status,
        body: plainText(issue.description),
      }),
    ),
  brain: async (api) =>
    source(
      await api.getKnowledgeDocuments(),
      (page) => page.pageId,
      (page) => page.title,
      (page) => ({ title: page.title, body: plainText(page.content) }),
    ),
  spec: async (api) =>
    source(
      await api.getSpecifications(),
      (spec) => spec.id,
      (spec) => spec.title,
      (spec) => ({
        title: spec.title,
        body: spec.sections
          .map((section) => `${section.title}\n\n${plainText(section.content)}`)
          .join('\n\n'),
      }),
    ),
  testplan: async (api) =>
    source(
      await api.getAllSavedTestPlans(),
      (plan) => plan.id,
      (plan) => plan.title,
      (plan) => ({
        title: plan.title,
        body: plan.plans
          .map((entry) => `${entry.title}\n${plainText(entry.description)}\n${entry.steps.length}`)
          .join('\n\n'),
      }),
    ),
};

const isFileKind = (kind: BriefReferenceKind): kind is 'attachment' | 'file' =>
  kind === 'attachment' || kind === 'file';

function ReferenceRow({
  index,
  item,
  source,
  ensure,
  files,
  disabled,
  onPatch,
  onRemove,
  onUpload,
  uploadsLeft,
  onOpen,
}: {
  index: number;
  item: BriefReference;
  source: SourceState | undefined;
  ensure: (kind: BriefReferenceKind) => void;
  files: readonly Attachment[];
  disabled: boolean;
  onPatch: (changes: Partial<BriefReference>) => void;
  onRemove: () => void;
  onUpload: (file: File) => Promise<Attachment>;
  uploadsLeft: number;
  /** Shows what the reference points at; a file is opened, anything else in the viewer. */
  onOpen: (() => void | Promise<void>) | undefined;
}) {
  const { locale } = useI18n();
  const c = copy[locale];
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => ensure(item.kind), [ensure, item.kind]);

  const options = useMemo(() => {
    const base = isFileKind(item.kind)
      ? files.map((file) => ({
          value: file.id,
          label: file.size === undefined ? file.name : `${file.name} · ${formatBytes(file.size)}`,
        }))
      : (source?.options ?? []);
    // A reference saved earlier stays visible even if its source no longer lists it.
    return item.ref && !base.some((option) => option.value === item.ref)
      ? [{ value: item.ref, label: item.label || item.ref }, ...base]
      : base;
  }, [files, item.kind, item.label, item.ref, source]);

  const choose = (value: string) => {
    // Typing in the search box reports an empty value; keep the current reference.
    const option = options.find((candidate) => candidate.value === value);
    if (option) onPatch({ ref: option.value, label: option.label.slice(0, MAX_LABEL) });
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    const kind = fileKind(file);
    if (!kind) return setError(`${file.name}: ${c.unsupported}`);
    if (file.size > ATTACHMENT_LIMITS[kind])
      return setError(c.tooLarge(file.name, ATTACHMENT_LIMITS[kind] / 1024 / 1024));
    if (uploadsLeft <= 0) return setError(c.limit);
    setError('');
    setUploading(true);
    try {
      const attachment = await onUpload(file);
      onPatch({ ref: attachment.id, label: attachment.name.slice(0, MAX_LABEL) });
    } catch {
      setError(c.uploadFailed);
    } finally {
      setUploading(false);
    }
  };

  const open = async () => {
    try {
      setError('');
      await onOpen?.();
    } catch {
      setError(c.openFailed);
    }
  };

  const loading =
    !isFileKind(item.kind) && source?.status !== 'ready' && source?.status !== 'error';
  const emptyMessage = isFileKind(item.kind)
    ? c.noAttachments
    : source?.status === 'error'
      ? c.loadFailed
      : loading
        ? c.loading
        : c.empty;

  return (
    <div className="space-y-2 rounded-md border border-[var(--border)] p-3">
      <div className="grid gap-2 sm:grid-cols-[150px_minmax(0,1fr)_auto]">
        <Select
          aria-label={`${c.kind} ${index + 1}`}
          disabled={disabled}
          value={item.kind}
          onChange={(event) =>
            onPatch({ kind: event.target.value as BriefReferenceKind, label: '', ref: '' })
          }
        >
          {BRIEF_REFERENCE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {c.kinds[kind]}
            </option>
          ))}
        </Select>
        <SearchableSelect
          label={`${c.target} ${index + 1}`}
          options={options}
          value={item.ref}
          placeholder={loading ? c.loading : c.pick[item.kind]}
          emptyMessage={emptyMessage}
          disabled={disabled}
          onChange={choose}
        />
        <div className="flex items-center gap-2">
          {isFileKind(item.kind) && !disabled && (
            <label className="inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] px-3 text-sm font-semibold hover:bg-[var(--fill-ghost-hover)] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
              <i
                className={`ti ${uploading ? 'ti-loader-2 animate-spin' : 'ti-upload'}`}
                aria-hidden="true"
              />
              {uploading ? c.uploading : c.upload}
              <Input
                type="file"
                accept={ATTACHMENT_ACCEPT}
                disabled={uploading}
                aria-label={`${c.upload} ${index + 1}`}
                className="sr-only"
                onChange={(event) => void upload(event)}
              />
            </label>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-blue-400 hover:text-blue-300"
            disabled={!item.ref || !onOpen}
            aria-label={`${isFileKind(item.kind) ? c.openFile : c.open} ${index + 1}`}
            title={isFileKind(item.kind) ? c.openFile : c.openHint}
            onClick={() => void open()}
          >
            <i className="ti ti-external-link" aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-red-400 hover:text-red-300"
            disabled={disabled}
            aria-label={`${c.remove} ${index + 1}`}
            onClick={onRemove}
          >
            <i className="ti ti-trash" aria-hidden="true" />
          </Button>
        </div>
      </div>
      <Input
        aria-label={`${c.reason} ${index + 1}`}
        placeholder={c.reasonPlaceholder}
        disabled={disabled}
        value={item.reason}
        onChange={(event) => onPatch({ reason: event.target.value })}
      />
      {isFileKind(item.kind) && !disabled && (
        <p className="text-xs text-[var(--text-muted)]">{c.uploadHint}</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The "read first" list: every reference is picked from what the workspace has (searchable
 * lists, the issue attachments, or a file sent right here) so ids are never typed by hand.
 */
export function ReferencesEditor({
  apiClient,
  issueId,
  items,
  onChange,
  disabled,
  readOnly,
  issueAttachments,
  uploaded,
  onUpload,
  addLabel,
  onOpenModule,
}: {
  apiClient: ApiClient;
  issueId: string;
  items: readonly BriefReference[];
  onChange: (items: BriefReference[]) => void;
  disabled: boolean;
  readOnly: boolean;
  issueAttachments: readonly Attachment[];
  /** Files sent from this tab that are not yet part of the issue. */
  uploaded: readonly Attachment[];
  onUpload: (file: File) => Promise<Attachment>;
  addLabel: string;
  /** Goes to the module a reference belongs to (Brain, PBIs...); omitted when there is none. */
  onOpenModule?: (reference: BriefReference) => void;
}) {
  const [viewing, setViewing] = useState<number | null>(null);
  const requested = useRef(new Set<SourceKind>());
  const [sources, setSources] = useState<Partial<Record<SourceKind, SourceState>>>({});

  const ensure = useCallback(
    (kind: BriefReferenceKind) => {
      if (isFileKind(kind)) return;
      const source = kind;
      if (requested.current.has(source)) return;
      requested.current.add(source);
      setSources((current) => ({ ...current, [source]: { status: 'loading', ...NO_SOURCE } }));
      loaders[source](apiClient, issueId).then(
        (loaded) =>
          setSources((current) => ({ ...current, [source]: { status: 'ready', ...loaded } })),
        () =>
          setSources((current) => ({ ...current, [source]: { status: 'error', ...NO_SOURCE } })),
      );
    },
    [apiClient, issueId],
  );

  const files = useMemo(
    () => [...new Map([...issueAttachments, ...uploaded].map((file) => [file.id, file])).values()],
    [issueAttachments, uploaded],
  );
  const patch = (index: number, changes: Partial<BriefReference>) =>
    onChange(
      items.map((item, position) => {
        if (position !== index) return item;
        // The passage belongs to the item it was found in: picking another one drops it.
        const { excerpt: _passage, ...withoutPassage } = item;
        const another = 'ref' in changes || 'kind' in changes;
        return { ...(another ? withoutPassage : item), ...changes };
      }),
    );

  const viewed = viewing === null ? undefined : items[viewing];
  const viewedSource = viewed && !isFileKind(viewed.kind) ? sources[viewed.kind] : undefined;
  const opener = (item: BriefReference, index: number) => {
    if (!item.ref) return undefined;
    if (isFileKind(item.kind)) {
      const file = files.find((candidate) => candidate.id === item.ref);
      return file ? () => openReferencedFile(apiClient, file) : undefined;
    }
    return () => setViewing(index);
  };

  return (
    <>
      {items.map((item, index) => (
        <ReferenceRow
          // Rows are edited in place and have no stable id, so the position is the identity.
          key={index}
          index={index}
          item={item}
          source={isFileKind(item.kind) ? undefined : sources[item.kind]}
          ensure={ensure}
          files={files}
          disabled={disabled}
          uploadsLeft={MAX_ATTACHMENTS - files.length}
          onPatch={(changes) => patch(index, changes)}
          onRemove={() => onChange(items.filter((_, position) => position !== index))}
          onUpload={onUpload}
          onOpen={opener(item, index)}
        />
      ))}
      {viewed && !isFileKind(viewed.kind) && (
        <ReferenceViewer
          reference={viewed}
          detail={viewedSource?.detail(viewed.ref)}
          status={
            viewedSource?.status === 'ready'
              ? 'ready'
              : viewedSource?.status === 'error'
                ? 'error'
                : 'loading'
          }
          onClose={() => setViewing(null)}
          {...(onOpenModule
            ? {
                onOpenModule: (reference: BriefReference) => {
                  setViewing(null);
                  onOpenModule(reference);
                },
              }
            : {})}
        />
      )}
      {!readOnly && (
        <Button
          type="button"
          variant="outline"
          disabled={disabled || items.length >= MAX_REFERENCES}
          onClick={() => onChange([...items, { kind: 'brain', label: '', ref: '', reason: '' }])}
        >
          <i className="ti ti-plus" aria-hidden="true" />
          {addLabel}
        </Button>
      )}
    </>
  );
}
