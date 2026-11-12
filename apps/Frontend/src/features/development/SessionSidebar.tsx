import type { ReactNode } from 'react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import type { DesktopAssignment } from '../../lib/desktop.js';
import { useI18n } from '../../lib/i18n/index.js';
import { cn } from '../../lib/utils.js';
import { contextUsage, shortTokens, splitFolder } from './development-files.js';
import type { DevSession, DiffFile } from './development-types.js';

interface Props {
  readonly session: DevSession;
  /** Where the session runs on this computer (desktop app); null anywhere else. */
  readonly assignment: DesktopAssignment | null;
  readonly files: readonly DiffFile[];
  /** Offered while the desktop app has no folder for the session. */
  readonly onChooseFolder?: () => void;
  readonly onViewChanges: () => void;
}

function Block({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section
      className="space-y-2 border-b border-[var(--border)] p-4 last:border-b-0"
      aria-label={title}
    >
      <h2 className="text-sm font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Line({ icon, children }: { readonly icon: string; readonly children: ReactNode }) {
  return (
    <p className="flex min-w-0 items-center gap-2 text-sm">
      <i className={cn('ti shrink-0 text-[var(--text-muted)]', icon)} aria-hidden="true" />
      {children}
    </p>
  );
}

function FolderName({ path }: { readonly path: string }) {
  const folder = splitFolder(path);
  return (
    <span className="truncate" title={path}>
      {folder.name} <span className="text-[var(--text-muted)]">· {folder.parent}</span>
    </span>
  );
}

/** Beside the session: where it runs, how full its context is, its subagents and its changes. */
export function SessionSidebar({
  session,
  assignment,
  files,
  onChooseFolder,
  onViewChanges,
}: Props) {
  const { t, messages } = useI18n();
  const c = messages.development;
  const { windowTokens, usedTokens, compactAtPercent, compactions } = session.context;
  const usage = contextUsage(session.context);
  const share = (tokens: number) => `${((tokens / windowTokens) * 100).toFixed(1)}%`;
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const rows = [
    { label: c.contextRows.conversation, tokens: usedTokens, tone: 'bg-[var(--fill-accent)]' },
    { label: c.contextRows.buffer, tokens: usage.buffer, tone: 'bg-[var(--border-strong)]' },
    { label: c.contextRows.free, tokens: usage.free, tone: 'bg-[var(--surface-2)]' },
  ];

  return (
    <aside className="min-w-0 flex-1 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
      <div>
        <Block title={c.environment}>
          <Line icon="ti-device-desktop">
            <span className="truncate">
              {assignment ? c.thisComputer : (session.runner ?? c.noRunner)}
            </span>
          </Line>
          <Line icon="ti-folder">
            {assignment ? (
              <FolderName path={assignment.repoPath} />
            ) : (
              <span className="truncate font-mono text-xs">
                {session.worktree.path ?? c.pathPending}
              </span>
            )}
          </Line>
          <Line icon="ti-git-branch">
            <span className="min-w-0 truncate font-mono text-xs" title={session.worktree.branch}>
              {session.worktree.branch}
            </span>
            <span className="shrink-0 text-xs text-[var(--text-muted)]">
              {t('development.fromBranch', { branch: session.worktree.baseBranch })}
            </span>
            <span className="ml-auto shrink-0 text-xs text-[var(--text-muted)]">
              {c.worktreeTag}
            </span>
          </Line>
          {onChooseFolder && (
            <Button variant="outline" size="sm" className="w-full" onClick={onChooseFolder}>
              <i className="ti ti-folder-open" aria-hidden="true" /> {c.chooseFolder}
            </Button>
          )}
        </Block>

        <Block title={c.context}>
          <p className="flex items-baseline justify-between gap-2 text-sm">
            <span className="font-medium">
              {t('development.contextUsed', { percent: usage.percent })}
            </span>
            <span className="text-xs text-[var(--text-muted)]">
              {shortTokens(usedTokens)} / {shortTokens(windowTokens)}
            </span>
          </p>
          <div
            role="progressbar"
            aria-label={c.context}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={usage.percent}
            className="flex h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]"
          >
            <div
              className={
                usage.percent >= compactAtPercent
                  ? 'bg-[var(--fill-warning)]'
                  : 'bg-[var(--fill-accent)]'
              }
              style={{ width: `${usage.percent}%` }}
            />
            <div
              className="ml-auto bg-[var(--border-strong)]"
              style={{ width: `${100 - compactAtPercent}%` }}
            />
          </div>
          <dl className="space-y-1 text-xs">
            {rows.map((row) => (
              <div key={row.label} className="flex items-center gap-2">
                <span className={cn('h-2 w-2 shrink-0 rounded-sm', row.tone)} aria-hidden="true" />
                <dt className="min-w-0 flex-1 truncate text-[var(--text-secondary)]">
                  {row.label}
                </dt>
                <dd className="text-[var(--text-muted)]">{shortTokens(row.tokens)}</dd>
                <dd className="w-12 text-right">{share(row.tokens)}</dd>
              </div>
            ))}
          </dl>
          <p className="text-xs text-[var(--text-muted)]">
            {t('development.untilCompact', { count: shortTokens(usage.untilCompact) })}
          </p>
          <p className="text-xs text-[var(--text-muted)]">
            {t('development.compactions', { count: compactions, limit: compactAtPercent })}
          </p>
        </Block>

        <Block title={c.subagents}>
          <p className="text-xs text-[var(--text-muted)]">
            {t('development.subagentsLimit', { max: session.maxSubagents })}
          </p>
          {session.subagents.length === 0 ? (
            <p className="text-sm text-[var(--text-muted)]">{c.noSubagents}</p>
          ) : (
            <ul className="space-y-2">
              {session.subagents.map((subagent) => (
                <li
                  key={subagent.id}
                  className="rounded-md border border-[var(--border)] p-2 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <i className="ti ti-robot" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate font-medium">{subagent.name}</span>
                    <Badge variant={subagent.status === 'failed' ? 'destructive' : 'outline'}>
                      {c.subagentStatus[subagent.status]}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">
                    {subagent.role && `${subagent.role} · `}
                    {t('development.tokens', { count: shortTokens(subagent.usedTokens) })}
                  </p>
                  {subagent.summary && <p className="mt-1 text-xs">{subagent.summary}</p>}
                </li>
              ))}
            </ul>
          )}
        </Block>

        <Block title={c.files}>
          <div className="flex items-center justify-between gap-2">
            <p
              className="font-mono text-sm"
              title={t('development.changedFiles', { count: files.length })}
            >
              <span className="text-green-400">+{additions}</span>{' '}
              <span className="text-red-400">-{deletions}</span>
            </p>
            <Button variant="outline" size="sm" onClick={onViewChanges}>
              {c.viewChanges}
            </Button>
          </div>
        </Block>
      </div>
    </aside>
  );
}
