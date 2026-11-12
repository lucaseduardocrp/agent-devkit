import { useMemo, useState, type FormEvent } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { Button } from '../../components/ui/button.js';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import { Textarea } from '../../components/ui/textarea.js';
import { useI18n } from '../../lib/i18n/index.js';
import { MarkdownViewer } from '../brain/MarkdownViewer.js';
import type {
  ChangeAction,
  ChangeFramework,
  ChangeStatus,
  DevChange,
} from './development-types.js';
import {
  ChangeBadge,
  Field,
  Hint,
  ListRow,
  ListRows,
  ListToolbar,
  Panel,
  type SectionActions,
} from './development-ui.js';

interface Props extends SectionActions {
  readonly apiClient: ApiClient;
  readonly changes: readonly DevChange[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly onStartSession: (changeId: string) => void;
}

/** The lifecycle moves a person may make from each status. */
const ACTIONS: Record<ChangeStatus, readonly ChangeAction[]> = {
  draft: ['propose'],
  proposed: ['approve', 'reject', 'reopen'],
  approved: ['archive'],
  rejected: ['reopen'],
  archived: [],
};
const STATUSES: readonly ChangeStatus[] = ['draft', 'proposed', 'approved', 'rejected', 'archived'];
const FRAMEWORKS: readonly ChangeFramework[] = ['openspec', 'speckit', 'custom'];
const fileName = (path: string) => path.split('/').pop();

export function ArtifactsSection({
  apiClient,
  changes,
  selectedId,
  onSelect,
  onStartSession,
  busy,
  readOnly,
  canDelete,
  run,
}: Props) {
  const { t, messages, formatDate } = useI18n();
  const c = messages.development;
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  // The change summary is read on demand, not always in the way of the artifacts.
  const [showSummary, setShowSummary] = useState(false);
  const [framework, setFramework] = useState<ChangeFramework>('openspec');
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DevChange | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return changes.filter(
      (item) =>
        (!statusFilter || item.status === statusFilter) &&
        (!query ||
          item.title.toLowerCase().includes(query) ||
          item.slug.toLowerCase().includes(query)),
    );
  }, [changes, search, statusFilter]);

  const change = changes.find((item) => item.id === selectedId) ?? null;
  const artifact =
    change?.artifacts.find((item) => item.id === artifactId) ?? change?.artifacts[0] ?? null;
  const editable = !readOnly && change?.status !== 'archived' && change?.status !== 'rejected';

  const create = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const created = await apiClient.createDevelopmentChange({
        title,
        framework,
        ...(summary.trim() ? { summary } : {}),
      });
      onSelect(created.id);
      setCreating(false);
      setTitle('');
      setSummary('');
    });
  };
  const save = (target: DevChange, id: string, content: string) =>
    run(async () => {
      await apiClient.updateDevelopmentChange(target.id, {
        artifacts: target.artifacts.map((item) => (item.id === id ? { ...item, content } : item)),
      });
      setDraft(null);
    });

  const list = (
    <section aria-label={c.changes} className="space-y-3">
      <ListToolbar
        search={search}
        onSearch={setSearch}
        searchLabel={c.searchArtifacts}
        action={
          !readOnly && (
            <Button variant="outline" onClick={() => setCreating(true)}>
              <i className="ti ti-plus" aria-hidden="true" /> {c.newChange}
            </Button>
          )
        }
      >
        <Select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value)}
          aria-label={c.filterChangeStatus}
          containerClassName="max-w-52"
        >
          <option value="">{c.anyChangeStatus}</option>
          {STATUSES.map((key) => (
            <option key={key} value={key}>
              {c.changeStatus[key]}
            </option>
          ))}
        </Select>
      </ListToolbar>
      {changes.length === 0 && <Hint>{c.noChanges}</Hint>}
      {changes.length > 0 && visible.length === 0 && <Hint>{c.noChangesMatch}</Hint>}
      {visible.length > 0 && (
        <ListRows>
          {visible.map((item) => (
            <ListRow
              key={item.id}
              onSelect={() => {
                onSelect(item.id);
                setCreating(false);
                setArtifactId(null);
                setDraft(null);
              }}
            >
              <span className="truncate">{item.title}</span>
              <span className="hidden min-w-0 flex-1 truncate font-mono text-xs text-[var(--text-muted)] md:inline">
                {item.slug}
              </span>
              <span className="ml-auto shrink-0">
                <ChangeBadge status={item.status} />
              </span>
              <span className="hidden w-20 shrink-0 text-right text-xs text-[var(--text-muted)] md:inline">
                {formatDate(item.updatedAt, { dateStyle: 'short' })}
              </span>
            </ListRow>
          ))}
        </ListRows>
      )}
    </section>
  );

  return (
    <div className="min-w-0 space-y-4">
      {creating ? (
        <form
          className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4"
          aria-label={c.newChange}
          onSubmit={create}
        >
          <Field label={c.title}>
            <Input value={title} required onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Field label={c.framework}>
            <Select
              value={framework}
              onChange={(event) => setFramework(event.target.value as ChangeFramework)}
            >
              {FRAMEWORKS.map((item) => (
                <option key={item} value={item}>
                  {c.frameworks[item]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={c.summary}>
            <Textarea value={summary} onChange={(event) => setSummary(event.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || !title.trim()}>
              {c.createChange}
            </Button>
            <Button type="button" variant="outline" onClick={() => setCreating(false)}>
              {c.cancel}
            </Button>
          </div>
        </form>
      ) : !change ? (
        list
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">{change.title}</h2>
                <ChangeBadge status={change.status} />
              </div>
              <p className="text-sm text-[var(--text-muted)]">
                {c.frameworks[change.framework]} · {change.slug}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => onSelect(null)}>
                <i className="ti ti-list" aria-hidden="true" /> {c.backToChanges}
              </Button>
              {change.summary && (
                <Button
                  variant="outline"
                  aria-pressed={showSummary}
                  onClick={() => setShowSummary(!showSummary)}
                >
                  <i className="ti ti-file-text" aria-hidden="true" />{' '}
                  {showSummary ? c.hideSummary : c.viewSummary}
                </Button>
              )}
              {!readOnly && (
                <>
                  {ACTIONS[change.status].map((action) => (
                    <Button
                      key={action}
                      variant={action === 'approve' || action === 'propose' ? 'default' : 'outline'}
                      disabled={busy}
                      onClick={() =>
                        void run(() => apiClient.transitionDevelopmentChange(change.id, action))
                      }
                    >
                      {c.actions[action]}
                    </Button>
                  ))}
                  {change.status === 'approved' && (
                    <Button disabled={busy} onClick={() => onStartSession(change.id)}>
                      <i className="ti ti-player-play" aria-hidden="true" /> {c.startSession}
                    </Button>
                  )}
                  {canDelete && (
                    <Button
                      variant="destructive"
                      disabled={busy}
                      onClick={() => setDeleting(change)}
                    >
                      {c.delete}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
          {change.summary && showSummary && (
            <Panel title={c.summary}>
              <p className="whitespace-pre-wrap text-sm">{change.summary}</p>
            </Panel>
          )}
          {!artifact ? (
            <Hint>{c.noArtifacts}</Hint>
          ) : (
            <Panel title={c.artifacts} aside={artifact.path}>
              <div className="mb-3 flex flex-wrap gap-1" role="tablist" aria-label={c.artifacts}>
                {change.artifacts.map((item) => (
                  <Button
                    key={item.id}
                    role="tab"
                    size="sm"
                    aria-selected={item.id === artifact.id}
                    variant={item.id === artifact.id ? 'secondary' : 'ghost'}
                    onClick={() => {
                      setArtifactId(item.id);
                      setDraft(null);
                    }}
                  >
                    {fileName(item.path)}
                  </Button>
                ))}
              </div>
              {draft === null ? (
                <>
                  {artifact.content.trim() ? (
                    <MarkdownViewer
                      content={artifact.content}
                      toolbarActions={
                        editable && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="h-8 px-2.5 text-xs"
                            onClick={() => setDraft(artifact.content)}
                            leftIcon={<i className="ti ti-pencil text-xs" aria-hidden="true" />}
                          >
                            {c.edit}
                          </Button>
                        )
                      }
                    />
                  ) : (
                    <>
                      <p className="text-sm text-[var(--text-muted)]">{c.emptyArtifact}</p>
                      {editable && (
                        <Button
                          className="mt-3"
                          variant="outline"
                          onClick={() => setDraft(artifact.content)}
                        >
                          <i className="ti ti-pencil" aria-hidden="true" /> {c.edit}
                        </Button>
                      )}
                    </>
                  )}
                </>
              ) : (
                <>
                  <Textarea
                    className="min-h-[320px] font-mono text-sm"
                    aria-label={t('development.artifactContent', { path: artifact.path })}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <div className="mt-3 flex gap-2">
                    <Button disabled={busy} onClick={() => void save(change, artifact.id, draft)}>
                      {c.save}
                    </Button>
                    <Button variant="outline" onClick={() => setDraft(null)}>
                      {c.cancel}
                    </Button>
                  </div>
                </>
              )}
            </Panel>
          )}
        </>
      )}
      {deleting && (
        <ConfirmationDialog
          open
          title={c.deleteChangeTitle}
          description={t('development.deleteChangeDescription', { title: deleting.title })}
          confirmLabel={c.delete}
          cancelLabel={c.cancel}
          destructive
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            setDeleting(null);
            void run(() => apiClient.deleteDevelopmentChange(deleting.id));
          }}
        />
      )}
    </div>
  );
}
