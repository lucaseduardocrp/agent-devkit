import { useMemo, useState } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import { Textarea } from '../../components/ui/textarea.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import { DiffViewer } from './DiffViewer.js';
import type { DevSession } from './development-types.js';
import {
  Field,
  Hint,
  ListRow,
  ListRows,
  ListToolbar,
  Panel,
  SessionBadge,
  type SectionActions,
} from './development-ui.js';

interface Props extends SectionActions {
  readonly apiClient: ApiClient;
  readonly sessions: readonly DevSession[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
}

const REVIEW_STATUSES = ['waiting_review', 'approved'] as const;
const CLIS = ['claude', 'codex', 'gemini'] as const;

export function ReviewSection({
  apiClient,
  sessions,
  selectedId,
  onSelect,
  busy,
  readOnly,
  run,
}: Props) {
  const { t, messages, formatDate } = useI18n();
  const c = messages.development;
  const [comment, setComment] = useState('');
  const [commentPath, setCommentPath] = useState('');
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [cliFilter, setCliFilter] = useState('');

  // What agents finished: waiting for a decision first, then what was already approved.
  const reviewable = sessions.filter(
    (item) => item.status === 'waiting_review' || item.status === 'approved',
  );
  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    return reviewable.filter(
      (item) =>
        (!statusFilter || item.status === statusFilter) &&
        (!cliFilter || item.cli === cliFilter) &&
        (!query ||
          item.title.toLowerCase().includes(query) ||
          item.worktree.branch.toLowerCase().includes(query)),
    );
  }, [reviewable, search, statusFilter, cliFilter]);
  const session = reviewable.find((item) => item.id === selectedId) ?? null;

  const addComment = (target: DevSession) =>
    run(async () => {
      await apiClient.addDevelopmentComment(target.id, comment.trim(), commentPath || undefined);
      setComment('');
    });
  const decide = (target: DevSession, verdict: 'approve' | 'request_changes') =>
    run(async () => {
      await apiClient.reviewDevelopmentSession(target.id, verdict, note.trim() || undefined);
      setNote('');
    });

  if (!session) {
    return (
      <section aria-label={c.sessions} className="space-y-3">
        <ListToolbar search={search} onSearch={setSearch} searchLabel={c.searchReviews}>
          <Select
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            aria-label={c.filterSessionStatus}
            containerClassName="max-w-52"
          >
            <option value="">{c.anySessionStatus}</option>
            {REVIEW_STATUSES.map((key) => (
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
        {reviewable.length === 0 && <Hint>{c.noReviews}</Hint>}
        {reviewable.length > 0 && visible.length === 0 && <Hint>{c.noReviewsMatch}</Hint>}
        {visible.length > 0 && (
          <ListRows>
            {visible.map((item) => (
              <ListRow key={item.id} onSelect={() => onSelect(item.id)}>
                <span
                  className={cn(
                    'h-2 w-2 shrink-0 rounded-full',
                    item.status === 'approved' ? 'bg-emerald-500' : 'bg-amber-500',
                  )}
                  aria-hidden="true"
                />
                <span className="truncate">{item.title}</span>
                <span className="hidden min-w-0 flex-1 truncate font-mono text-xs text-[var(--text-muted)] md:inline">
                  {item.worktree.branch}
                </span>
                <span className="ml-auto hidden shrink-0 text-xs text-[var(--text-secondary)] sm:inline">
                  {item.cli}
                </span>
                <span className="hidden shrink-0 font-mono text-xs text-[var(--text-muted)] sm:inline">
                  +{item.diff.reduce((sum, file) => sum + file.additions, 0)} -
                  {item.diff.reduce((sum, file) => sum + file.deletions, 0)}
                </span>
                <SessionBadge status={item.status} />
                <span className="hidden w-20 shrink-0 text-right text-xs text-[var(--text-muted)] md:inline">
                  {formatDate(item.updatedAt, { dateStyle: 'short' })}
                </span>
              </ListRow>
            ))}
          </ListRows>
        )}
      </section>
    );
  }

  return (
    <div className="min-w-0 space-y-4">
      {
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">{session.title}</h2>
                <SessionBadge status={session.status} />
              </div>
              <p className="font-mono text-sm text-[var(--text-muted)]">
                {session.worktree.branch} → {session.worktree.baseBranch} ·{' '}
                {t('development.attempt', { attempt: session.attempt })}
              </p>
            </div>
            <Button variant="outline" onClick={() => onSelect(null)}>
              <i className="ti ti-list" aria-hidden="true" /> {c.backToReviews}
            </Button>
          </div>
          {session.summary && <p className="whitespace-pre-wrap text-sm">{session.summary}</p>}
          <Panel title={c.files} aside={String(session.diff.length)}>
            <DiffViewer key={session.id} files={session.diff} />
          </Panel>
          <Panel title={c.comments} aside={String(session.comments.length)}>
            {session.comments.length === 0 ? (
              <p className="text-sm text-[var(--text-muted)]">{c.noComments}</p>
            ) : (
              <ul className="space-y-2">
                {session.comments.map((item) => (
                  <li
                    key={item.id}
                    className="rounded-md border border-[var(--border)] p-3 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-muted)]">
                      <i
                        className={`ti ${item.author === 'agent' ? 'ti-robot' : 'ti-user'}`}
                        aria-hidden="true"
                      />
                      <span className="font-medium text-[var(--text-primary)]">
                        {item.authorName}
                      </span>
                      {item.author === 'agent' && <Badge variant="outline">{c.agentAuthor}</Badge>}
                      {item.path && (
                        <span className="font-mono">
                          {item.path}
                          {item.line ? `:${item.line}` : ''}
                        </span>
                      )}
                      {item.resolved && <Badge variant="success">{c.resolved}</Badge>}
                      {!readOnly && (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-auto"
                          disabled={busy}
                          onClick={() =>
                            void run(() =>
                              apiClient.resolveDevelopmentComment(
                                session.id,
                                item.id,
                                !item.resolved,
                              ),
                            )
                          }
                        >
                          {item.resolved ? c.unresolve : c.resolve}
                        </Button>
                      )}
                    </div>
                    <p className="mt-2 whitespace-pre-wrap">{item.body}</p>
                  </li>
                ))}
              </ul>
            )}
            {!readOnly && (
              <div className="mt-3 space-y-2">
                <Textarea
                  aria-label={c.addComment}
                  placeholder={c.commentPlaceholder}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                />
                <div className="flex flex-wrap items-end gap-2">
                  <Field label={c.commentFile}>
                    <Select
                      value={commentPath}
                      onChange={(event) => setCommentPath(event.target.value)}
                    >
                      <option value="">{c.allFiles}</option>
                      {session.diff.map((file) => (
                        <option key={file.path} value={file.path}>
                          {file.path}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Button
                    variant="outline"
                    disabled={busy || !comment.trim()}
                    onClick={() => void addComment(session)}
                  >
                    {c.addComment}
                  </Button>
                </div>
              </div>
            )}
          </Panel>
          {!readOnly && session.status === 'waiting_review' && (
            <div className="flex flex-wrap items-end gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
              <div className="min-w-[240px] flex-1">
                <Field label={c.note}>
                  <Input value={note} onChange={(event) => setNote(event.target.value)} />
                </Field>
              </div>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => void decide(session, 'request_changes')}
              >
                <i className="ti ti-arrow-back-up" aria-hidden="true" /> {c.requestChanges}
              </Button>
              <Button disabled={busy} onClick={() => void decide(session, 'approve')}>
                <i className="ti ti-check" aria-hidden="true" /> {c.approveSession}
              </Button>
            </div>
          )}
        </>
      }
    </div>
  );
}
