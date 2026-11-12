import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import type { CustomAgentDto } from '../agents/agent-types.js';
import { MultiSelect } from '../../components/ui/multi-select.js';
import { Button } from '../../components/ui/button.js';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog.js';
import { Input } from '../../components/ui/input.js';
import { RemoteSelect } from '../../components/ui/remote-select.js';
import { Select } from '../../components/ui/select.js';
import { Textarea } from '../../components/ui/textarea.js';
import { desktopDevelopment, type DesktopAutonomy } from '../../lib/desktop.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import { SessionWorkspace } from './SessionWorkspace.js';
import { issueOption, pbiOption, repositoryLabel, repositoryValue } from './development-files.js';
import type {
  BranchOption,
  DevChange,
  DevSession,
  RepositoryOption,
  SessionCli,
} from './development-types.js';
import { Field, Hint, ListToolbar, SessionBadge, type SectionActions } from './development-ui.js';

interface Props extends SectionActions {
  readonly apiClient: ApiClient;
  readonly sessions: readonly DevSession[];
  readonly changes: readonly DevChange[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  /** The change a new session was asked for from Artifacts or the Pipeline. */
  readonly seedChangeId: string | null;
  readonly onOpenReview: (sessionId: string) => void;
}

/** The dot before a session in the list, as the one before an issue: how far it is. */
const STATUS_DOTS: Record<DevSession['status'], string> = {
  queued: 'bg-neutral-500',
  running: 'bg-blue-500',
  waiting_review: 'bg-amber-500',
  approved: 'bg-emerald-500',
  failed: 'bg-red-500',
  cancelled: 'bg-neutral-500',
};

const CLIS: readonly SessionCli[] = ['claude', 'codex', 'gemini'];
const AUTONOMIES: readonly DesktopAutonomy[] = ['safe', 'auto'];

/** Counts are whole and never negative: keep the digits only. */
const digitsOnly = (value: string) => value.replace(/\D/g, '');
const blockNonDigits = (event: KeyboardEvent<HTMLInputElement>) => {
  if (['-', '+', 'e', 'E', '.', ','].includes(event.key)) event.preventDefault();
};
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

export function CodeSection({
  apiClient,
  sessions,
  changes,
  selectedId,
  onSelect,
  seedChangeId,
  onOpenReview,
  busy,
  readOnly,
  canDelete,
  run,
}: Props) {
  const { t, messages, formatDate } = useI18n();
  const c = messages.development;
  // In the desktop app the sessions run on this computer, each in the folder chosen for it.
  const desktop = desktopDevelopment();
  // Agents only work on changes a person approved.
  const approved = changes.filter((change) => change.status === 'approved');
  const seed = approved.find((change) => change.id === seedChangeId);
  const [creating, setCreating] = useState(Boolean(seed) && !readOnly);
  const [title, setTitle] = useState(seed?.title ?? '');
  const [prompt, setPrompt] = useState(
    seed ? t('development.defaultPrompt', { slug: seed.slug }) : '',
  );
  const [changeId, setChangeId] = useState(seed?.id ?? '');
  const [pbiItemId, setPbiItemId] = useState('');
  const [issueId, setIssueId] = useState('');
  // Both lists are paged and searched by the API; the client never holds them whole.
  const fetchPbis = useCallback(
    (request: { q: string; page: number; pageSize: number }, signal: AbortSignal) =>
      apiClient.searchPbiItems(request, signal),
    [apiClient],
  );
  const fetchIssues = useCallback(
    async (request: { q: string; page: number; pageSize: number }, signal: AbortSignal) => {
      const { issues, total } = await apiClient.searchIssues(request, signal);
      return { items: issues, total };
    },
    [apiClient],
  );
  const [cli, setCli] = useState<SessionCli>('claude');
  const [repositories, setRepositories] = useState<readonly RepositoryOption[] | null>(null);
  const [repository, setRepository] = useState(
    seed?.repository ? repositoryValue(seed.repository) : '',
  );
  const [branches, setBranches] = useState<readonly BranchOption[] | null>(null);
  const [branch, setBranch] = useState(seed?.repository?.baseBranch ?? '');
  const [gitError, setGitError] = useState<string | null>(null);
  const [compactAt, setCompactAt] = useState('80');
  const [maxSubagents, setMaxSubagents] = useState('3');
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [agents, setAgents] = useState<readonly CustomAgentDto[]>([]);
  const [folder, setFolder] = useState('');
  const [autonomy, setAutonomy] = useState<DesktopAutonomy>('safe');
  const [folderError, setFolderError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<DevSession | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [cliFilter, setCliFilter] = useState('');
  const visibleSessions = useMemo(() => {
    const query = search.trim().toLowerCase();
    return sessions.filter(
      (item) =>
        (!statusFilter || item.status === statusFilter) &&
        (!cliFilter || item.cli === cliFilter) &&
        (!query ||
          item.title.toLowerCase().includes(query) ||
          item.worktree.branch.toLowerCase().includes(query)),
    );
  }, [sessions, search, statusFilter, cliFilter]);

  const session = sessions.find((item) => item.id === selectedId) ?? null;

  // A new session starts from the folder and the autonomy of the last one.
  useEffect(() => {
    if (!desktop) return;
    void desktop.preferences().then((saved) => {
      if (!saved.ok) return;
      setFolder(saved.lastRepoPath ?? '');
      setAutonomy(saved.autonomy);
    });
  }, [desktop]);

  // The agents of the workspace, to pick the ones that work on the session.
  useEffect(() => {
    const controller = new AbortController();
    apiClient
      .getAgents(controller.signal)
      .then(setAgents)
      .catch(() => setAgents([]));
    return () => controller.abort();
  }, [apiClient]);
  const agentOptions = agents.map((agent) => ({
    value: agent.id,
    label: agent.name,
    description: agent.description,
  }));

  // The repositories of every connected provider, joined.
  useEffect(() => {
    let active = true;
    apiClient
      .getDevelopmentRepositories()
      .then((list) => active && setRepositories(list))
      .catch((error: unknown) => {
        if (!active) return;
        setRepositories([]);
        setGitError(error instanceof Error ? error.message : c.repositoriesLoadFailed);
      });
    return () => {
      active = false;
    };
  }, [apiClient, c.repositoriesLoadFailed]);

  const chosen = repositories?.find((item) => repositoryValue(item) === repository);

  // The branches of the chosen repository.
  useEffect(() => {
    setBranches(null);
    if (!chosen) return;
    let active = true;
    apiClient
      .getDevelopmentBranches(chosen.provider, chosen.id)
      .then((list) => active && setBranches(list))
      .catch((error: unknown) => {
        if (!active) return;
        setBranches([]);
        setGitError(error instanceof Error ? error.message : c.branchesLoadFailed);
      });
    return () => {
      active = false;
    };
  }, [apiClient, chosen, c.branchesLoadFailed]);

  // A branch that is not in the list (nothing picked yet, or one a change brought that no longer
  // exists) becomes the default branch of the repository.
  useEffect(() => {
    if (!chosen || !branches || branches.some((item) => item.name === branch)) return;
    setBranch(branches.find((item) => item.isDefault)?.name ?? chosen.defaultBranch);
  }, [chosen, branches, branch]);

  const pickRepository = (value: string) => {
    setRepository(value);
    setBranch('');
    setGitError(null);
  };
  const pickChange = (id: string) => {
    setChangeId(id);
    // A change brings the repository and branch it was written for.
    const target = approved.find((change) => change.id === id)?.repository;
    if (!target) return;
    setRepository(repositoryValue(target));
    setBranch(target.baseBranch);
  };

  const browse = async () => {
    // Only rendered in the desktop app.
    const picked = await desktop!.pickFolder();
    if (!picked.ok) return setFolderError(picked.error);
    setFolderError(null);
    if (picked.path) setFolder(picked.path);
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      const created = await apiClient.createDevelopmentSession({
        title,
        prompt,
        cli,
        compactAtPercent: clamp(Number(compactAt), 10, 100),
        maxSubagents: clamp(Number(maxSubagents), 0, 20),
        ...(agentIds.length ? { agentIds } : {}),
        ...(changeId ? { changeId } : {}),
        ...(pbiItemId ? { pbiItemId } : {}),
        ...(issueId ? { issueId } : {}),
        ...(chosen && branch
          ? {
              repository: {
                provider: chosen.provider,
                id: chosen.id,
                name: chosen.name,
                baseBranch: branch,
              },
              baseBranch: branch,
            }
          : {}),
      });
      onSelect(created.id);
      setCreating(false);
      if (!desktop || !folder) return;
      const assigned = await desktop.assign(created.id, { repoPath: folder, autonomy });
      if (!assigned.ok) throw new Error(assigned.error);
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {creating ? (
        <form
          className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4"
          aria-label={c.newSession}
          onSubmit={create}
        >
          <Field label={c.title}>
            <Input value={title} required onChange={(event) => setTitle(event.target.value)} />
          </Field>
          <Field label={c.change}>
            <Select value={changeId} onChange={(event) => pickChange(event.target.value)}>
              <option value="">{c.noChange}</option>
              {approved.map((change) => (
                <option key={change.id} value={change.id}>
                  {change.title}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={c.linkPbi}>
              <RemoteSelect
                label={c.linkPbi}
                value={pbiItemId}
                onChange={setPbiItemId}
                fetchPage={fetchPbis}
                toOption={pbiOption}
                placeholder={c.linkPbiPlaceholder}
                emptyMessage={c.linkPbiEmpty}
                errorMessage={c.linkLoadFailed}
              />
            </Field>
            <Field label={c.linkIssue}>
              <RemoteSelect
                label={c.linkIssue}
                value={issueId}
                onChange={setIssueId}
                fetchPage={fetchIssues}
                toOption={issueOption}
                placeholder={c.linkIssuePlaceholder}
                emptyMessage={c.linkIssueEmpty}
                errorMessage={c.linkLoadFailed}
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={c.repositories}>
              <Select
                value={repository}
                disabled={!repositories?.length}
                onChange={(event) => pickRepository(event.target.value)}
              >
                <option value="">
                  {!repositories
                    ? c.loadingRepositories
                    : repositories.length === 0
                      ? c.noRepositories
                      : c.chooseRepository}
                </option>
                {repositories?.map((item) => (
                  <option key={repositoryValue(item)} value={repositoryValue(item)}>
                    {repositoryLabel(item)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={c.branch}>
              <Select
                value={branch}
                disabled={!chosen || !branches?.length}
                onChange={(event) => setBranch(event.target.value)}
              >
                <option value="">
                  {!chosen
                    ? c.chooseRepositoryFirst
                    : !branches
                      ? c.loadingBranches
                      : c.chooseBranch}
                </option>
                {branches?.map((item) => (
                  <option key={item.name} value={item.name}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {gitError && (
            <p role="alert" className="text-sm text-red-300">
              {gitError}
            </p>
          )}
          {desktop && (
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,260px)] sm:items-end">
              <Field label={c.folder}>
                <Input value={folder} readOnly placeholder={c.folderPlaceholder} />
              </Field>
              <Button type="button" variant="outline" onClick={() => void browse()}>
                <i className="ti ti-folder-open" aria-hidden="true" /> {c.chooseFolder}
              </Button>
              <Field label={c.autonomy}>
                <Select
                  value={autonomy}
                  onChange={(event) => setAutonomy(event.target.value as DesktopAutonomy)}
                >
                  {AUTONOMIES.map((item) => (
                    <option key={item} value={item}>
                      {c.autonomyLevels[item]}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          )}
          {folderError && (
            <p role="alert" className="text-sm text-red-300">
              {folderError}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label={c.cli}>
              <Select value={cli} onChange={(event) => setCli(event.target.value as SessionCli)}>
                {CLIS.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={c.compactAt}>
              <Input
                type="number"
                min={10}
                max={100}
                step={1}
                inputMode="numeric"
                value={compactAt}
                onKeyDown={blockNonDigits}
                onChange={(event) => setCompactAt(digitsOnly(event.target.value))}
              />
            </Field>
            <Field label={c.maxSubagents}>
              <Input
                type="number"
                min={0}
                max={20}
                step={1}
                inputMode="numeric"
                value={maxSubagents}
                onKeyDown={blockNonDigits}
                onChange={(event) => setMaxSubagents(digitsOnly(event.target.value))}
              />
            </Field>
          </div>
          <Field label={c.agents}>
            <MultiSelect
              label={c.agents}
              options={agentOptions}
              values={agentIds}
              onChange={setAgentIds}
              placeholder={c.agentsPlaceholder}
              emptyMessage={c.noAgents}
            />
          </Field>
          <Field label={c.prompt}>
            <Textarea
              className="min-h-[140px]"
              value={prompt}
              required
              onChange={(event) => setPrompt(event.target.value)}
            />
          </Field>
          <div className="flex gap-2 pt-4">
            <Button type="submit" disabled={busy || !title.trim() || !prompt.trim()}>
              {c.createSession}
            </Button>
            <Button type="button" variant="outline" onClick={() => setCreating(false)}>
              {c.cancel}
            </Button>
          </div>
        </form>
      ) : !session ? (
        <section aria-label={c.sessions} className="space-y-3">
          <ListToolbar
            search={search}
            onSearch={setSearch}
            searchLabel={c.searchSessions}
            action={
              !readOnly && (
                <Button variant="outline" onClick={() => setCreating(true)}>
                  <i className="ti ti-plus" aria-hidden="true" /> {c.newSession}
                </Button>
              )
            }
          >
            <Select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
              aria-label={c.filterSessionStatus}
              containerClassName="max-w-52"
            >
              <option value="">{c.anySessionStatus}</option>
              {(Object.keys(STATUS_DOTS) as DevSession['status'][]).map((key) => (
                <option key={key} value={key}>
                  {c.sessionStatus[key]}
                </option>
              ))}
            </Select>
            <Select
              value={cliFilter}
              onChange={(event) => setCliFilter(event.target.value)}
              aria-label={c.filterSessionCli}
              containerClassName="max-w-52"
            >
              <option value="">{c.anySessionCli}</option>
              {CLIS.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </Select>
          </ListToolbar>
          {sessions.length === 0 && <Hint>{c.noSessions}</Hint>}
          {sessions.length > 0 && visibleSessions.length === 0 && <Hint>{c.noSessionsMatch}</Hint>}
          {visibleSessions.length > 0 && (
            <div className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
              {visibleSessions.map((item) => (
                <Button
                  key={item.id}
                  type="button"
                  variant="ghost"
                  className="flex h-auto w-full items-center justify-start gap-3 rounded-none border-b border-[var(--border)] px-4 py-3 text-left font-normal last:border-b-0"
                  onClick={() => onSelect(item.id)}
                >
                  <span
                    className={cn('h-2 w-2 shrink-0 rounded-full', STATUS_DOTS[item.status])}
                    aria-hidden="true"
                  />
                  <span className="truncate">{item.title}</span>
                  <span className="hidden min-w-0 flex-1 truncate font-mono text-xs text-[var(--text-muted)] md:inline">
                    {item.worktree.branch}
                  </span>
                  <span className="ml-auto hidden shrink-0 text-xs text-[var(--text-secondary)] sm:inline">
                    {item.cli}
                  </span>
                  <SessionBadge status={item.status} />
                  <span className="hidden w-20 shrink-0 text-right text-xs text-[var(--text-muted)] md:inline">
                    {formatDate(item.updatedAt, { dateStyle: 'short' })}
                  </span>
                </Button>
              ))}
            </div>
          )}
        </section>
      ) : (
        <>
          <SessionWorkspace
            key={session.id}
            apiClient={apiClient}
            session={session}
            {...(desktop ? { desktop } : {})}
            onOpenReview={onOpenReview}
            onBack={() => onSelect(null)}
            onDelete={setDeleting}
            busy={busy}
            readOnly={readOnly}
            canDelete={canDelete}
            run={run}
          />
        </>
      )}
      {deleting && (
        <ConfirmationDialog
          open
          title={c.deleteSessionTitle}
          description={t('development.deleteSessionDescription', { title: deleting.title })}
          confirmLabel={c.delete}
          cancelLabel={c.cancel}
          destructive
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            setDeleting(null);
            void run(() => apiClient.deleteDevelopmentSession(deleting.id));
          }}
        />
      )}
    </div>
  );
}
