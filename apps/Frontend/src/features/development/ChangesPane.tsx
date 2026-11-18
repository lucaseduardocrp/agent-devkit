import { useEffect, useMemo, useState } from 'react';
import { ResizableBox } from './ResizableBox.js';
import { SplitLayout } from './SplitLayout.js';
import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Input } from '../../components/ui/input.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import type {
  DesktopCommit,
  DesktopDevelopmentBridge,
  DesktopDiffFile,
} from '../../lib/desktop.js';
import { useI18n } from '../../lib/i18n/index.js';
import { cn } from '../../lib/utils.js';
import { parsePatch, splitPath, type DiffRow } from './diff-parse.js';
import { MenuItem, MenuPanel, MenuSeparator, PickerList, SubMenu } from './development-menu.js';
import type { DevSession, DiffFile } from './development-types.js';
import { useViewedFiles } from './files-prefs.js';

interface Props {
  readonly session: DevSession;
  /** The changes of the session against its base branch. */
  readonly files: readonly DiffFile[];
  /** The commits of the session's branch; null where the worktree cannot be read (a browser). */
  readonly commits: readonly DesktopCommit[] | null;
  /** Given once the session has a worktree on this computer. */
  readonly desktop?: DesktopDevelopmentBridge;
  /** Changes whenever the session moved, so a chosen comparison is read again. */
  readonly refreshKey: string;
  readonly maximized: boolean;
  readonly onToggleMaximize: () => void;
  readonly onClose: () => void;
  readonly onOpenFile: (path: string) => void;
  readonly onAttachContext: (path: string) => Promise<void>;
}

const STATUS_ICONS: Record<DiffFile['status'], string> = {
  added: 'ti-file-plus',
  modified: 'ti-file-pencil',
  deleted: 'ti-file-minus',
  renamed: 'ti-file-arrow-right',
};
const STATUS_TEXT: Record<DiffFile['status'], string> = {
  added: 'text-green-400',
  modified: 'text-[var(--text-primary)]',
  deleted: 'text-red-400',
  renamed: 'text-[var(--text-primary)]',
};
const ROW_TONE: Record<DiffRow['kind'], string> = {
  hunk: 'bg-[var(--surface-2)] text-[var(--text-accent)]',
  add: 'bg-green-500/15',
  del: 'bg-red-500/15',
  context: '',
  note: 'text-[var(--text-muted)]',
};
const SIGNS: Record<DiffRow['kind'], string> = {
  hunk: '',
  add: '+',
  del: '-',
  context: ' ',
  note: '',
};
const NOTICE_MS = 2500;
const NO_FILES: readonly DiffFile[] = [];

/** Where the diff of a chosen commit or branch will be, while git reads it. */
function DiffSkeleton({ label }: { readonly label: string }) {
  return (
    <div role="status" aria-label={label} className="space-y-4 p-3">
      {[0, 1].map((file) => (
        <div key={file} className="space-y-2">
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="ml-auto h-4 w-12" />
          </div>
          {[72, 56, 88, 40, 64].map((width, line) => (
            <Skeleton key={line} className="h-3 rounded" style={{ width: `${width}%` }} />
          ))}
        </div>
      ))}
    </div>
  );
}

function FileListSkeleton() {
  return (
    <>
      {[0, 1, 2].map((row) => (
        <li key={row} className="px-2 py-1.5" aria-hidden="true">
          <Skeleton className="h-4 w-full" />
        </li>
      ))}
    </>
  );
}

/** What the session changed: a menu to compare it against another branch or one commit, the files
 * one after the other with their diff, and on the side the list of files and the commits. */
export function ChangesPane({
  session,
  files,
  commits,
  desktop,
  refreshKey,
  maximized,
  onToggleMaximize,
  onClose,
  onOpenFile,
  onAttachContext,
}: Props) {
  const { t, messages, formatDate } = useI18n();
  const c = messages.development;
  const { baseBranch, branch } = session.worktree;
  const [against, setAgainst] = useState<string | null>(null);
  const [commit, setCommit] = useState<string | null>(null);
  const [branches, setBranches] = useState<readonly string[]>([]);
  const [chosen, setChosen] = useState<{
    key: string;
    files: readonly DesktopDiffFile[];
    commits: readonly DesktopCommit[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const [listVisible, setListVisible] = useState(true);
  const [commitsOpen, setCommitsOpen] = useState(true);
  const [open, setOpen] = useState<Readonly<Record<string, boolean>>>({});
  const [viewed, toggleViewed] = useViewedFiles(session.id);
  // A file marked as viewed folds away, even if it was opened by hand before.
  const markViewed = (path: string) => {
    if (!viewed.has(path)) setOpen((current) => ({ ...current, [path]: false }));
    toggleViewed(path);
  };

  useEffect(() => {
    if (!desktop) return setBranches([]);
    let active = true;
    void desktop.branches(session.id).then((result) => {
      if (active) setBranches(result.ok ? result.branches : []);
    });
    return () => {
      active = false;
    };
  }, [desktop, session.id]);

  // A comparison other than the session's own is read from the worktree, and again whenever the
  // session moves.
  // After a revert the session's own list is stale, so the worktree is read instead.
  const [reloads, setReloads] = useState(0);
  const selection = Boolean(desktop) && (against !== null || commit !== null || reloads > 0);
  const choiceKey = `${against ?? ''}|${commit ?? ''}`;
  useEffect(() => {
    if (!desktop || !selection) return setChosen(null);
    let active = true;
    setError(null);
    void desktop
      .changes(session.id, baseBranch, {
        ...(against ? { against } : {}),
        ...(commit ? { commit } : {}),
      })
      .then((result) => {
        if (!active) return;
        if (!result.ok) return setError(result.error);
        setError(null);
        setChosen({ key: choiceKey, files: result.files, commits: result.commits });
      });
    return () => {
      active = false;
    };
  }, [desktop, selection, session.id, baseBranch, against, commit, choiceKey, refreshKey, reloads]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // What was chosen is being read: until it arrives the changes of the last choice are not shown.
  const current = selection && chosen?.key === choiceKey ? chosen : null;
  const pending = selection && !current && !error;
  const shownFiles: readonly DiffFile[] = current ? current.files : pending ? NO_FILES : files;
  const shownCommits = selection && chosen ? chosen.commits : commits;
  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      needle
        ? shownFiles.filter(
            (file) =>
              file.path.toLowerCase().includes(needle) || file.patch.toLowerCase().includes(needle),
          )
        : shownFiles,
    [shownFiles, needle],
  );
  const isOpen = (path: string) => open[path] ?? !viewed.has(path);
  const setAll = (value: boolean) =>
    setOpen(Object.fromEntries(shownFiles.map((file) => [file.path, value])));
  const reveal = (path: string, index: number) => {
    setOpen({ ...open, [path]: true });
    document.getElementById(`change-${index}`)?.scrollIntoView?.({ block: 'start' });
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice(c.copied);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : c.copied);
    }
  };
  const copyAbsolute = async (path: string) => {
    const result = await desktop!.filePath(session.id, path);
    if (result.ok) await copy(result.path);
    else setNotice(result.error);
  };
  const attach = async (path: string) => {
    try {
      await onAttachContext(path);
      setNotice(c.contextAttached);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : c.actionError);
    }
  };
  const run = async (action: Promise<{ ok: boolean; error?: string }>) => {
    const result = await action;
    if (!result.ok) setNotice(result.error ?? c.actionError);
  };

  /** Discards the changes of one file, or of all, after the person confirmed it. */
  const revert = async (path?: string) => {
    const question = path ? t('development.revertFileConfirm', { path }) : c.revertAllConfirm;
    if (!window.confirm(question)) return;
    const result = await desktop!.revertChanges(session.id, baseBranch, path);
    if (!result.ok) return setNotice(result.error ?? c.actionError);
    setNotice(c.reverted);
    setReloads((count) => count + 1);
  };

  const comparedWith = against ?? baseBranch;
  const commitItems = (shownCommits ?? []).map((item) => ({
    key: item.hash,
    label: item.subject,
    detail: item.hash.slice(0, 7),
  }));

  const diffColumn = (
    <div className="h-full min-h-0 min-w-0 flex-1 overflow-auto" aria-busy={pending}>
      <div className="min-w-0 divide-y divide-[var(--border)]">
        {pending ? (
          <DiffSkeleton label={c.loadingChanges} />
        ) : shownFiles.length === 0 ? (
          <p className="p-4 text-sm text-[var(--text-muted)]">{c.noDiff}</p>
        ) : visible.length === 0 ? (
          <p className="p-4 text-sm text-[var(--text-muted)]">{c.noMatches}</p>
        ) : (
          visible.map((file, index) => {
            const { dir, name } = splitPath(file.path);
            const expanded = isOpen(file.path);
            const done = viewed.has(file.path);
            const menuKey = `file:${file.path}`;
            return (
              <div key={file.path} id={`change-${index}`}>
                <div className="relative flex items-center gap-2 px-3 py-1.5">
                  <IconButton
                    size="xs"
                    label={t(expanded ? 'development.collapseFile' : 'development.expandFile', {
                      path: file.path,
                    })}
                    aria-expanded={expanded}
                    icon={
                      <i
                        className={cn('ti', expanded ? 'ti-chevron-down' : 'ti-chevron-right')}
                        aria-hidden="true"
                      />
                    }
                    onClick={() => setOpen({ ...open, [file.path]: !expanded })}
                  />
                  <i
                    className={cn(
                      'ti shrink-0',
                      STATUS_ICONS[file.status],
                      STATUS_TEXT[file.status],
                    )}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate text-sm" title={file.path}>
                    <span className={STATUS_TEXT[file.status]}>{name}</span>{' '}
                    <span className="text-xs text-[var(--text-muted)]">{dir}</span>
                  </span>
                  <span className="shrink-0 font-mono text-xs">
                    <span className="text-green-400">+{file.additions}</span>
                    {file.deletions > 0 && <span className="text-red-400"> -{file.deletions}</span>}
                  </span>
                  <IconButton
                    size="xs"
                    label={done ? c.markNotViewed : c.markViewed}
                    aria-pressed={done}
                    icon={
                      <i
                        className={cn(
                          'ti',
                          done ? 'ti-circle-check-filled text-green-400' : 'ti-circle-check',
                        )}
                        aria-hidden="true"
                      />
                    }
                    onClick={() => markViewed(file.path)}
                  />
                  <IconButton
                    size="xs"
                    label={c.openFile}
                    icon={<i className="ti ti-arrow-up-right" aria-hidden="true" />}
                    onClick={() => onOpenFile(file.path)}
                  />
                  <IconButton
                    size="xs"
                    label={t('development.fileActions', { path: file.path })}
                    aria-haspopup="menu"
                    aria-expanded={menu === menuKey}
                    icon={<i className="ti ti-dots" aria-hidden="true" />}
                    onClick={() => setMenu(menu === menuKey ? null : menuKey)}
                  />
                  {menu === menuKey && (
                    <MenuPanel
                      label={t('development.fileActions', { path: file.path })}
                      align="right"
                      className="w-56"
                      onClose={() => setMenu(null)}
                    >
                      <MenuItem onSelect={() => void attach(file.path)}>{c.attachContext}</MenuItem>
                      <SubMenu label={c.copy}>
                        <MenuItem disabled={!desktop} onSelect={() => void copyAbsolute(file.path)}>
                          {c.copyPath}
                        </MenuItem>
                        <MenuItem onSelect={() => void copy(file.path)}>
                          {c.copyRelativePath}
                        </MenuItem>
                        <MenuItem onSelect={() => void copy(file.patch)}>{c.copyDiff}</MenuItem>
                      </SubMenu>
                      <MenuSeparator />
                      <MenuItem onSelect={() => markViewed(file.path)}>
                        {done ? c.markNotViewed : c.markViewed}
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem onSelect={() => onOpenFile(file.path)}>{c.openFile}</MenuItem>
                      <SubMenu label={c.openIn} disabled={!desktop}>
                        <MenuItem
                          onSelect={() =>
                            void run(desktop!.openFile(session.id, file.path, 'default'))
                          }
                        >
                          {c.openInDefault}
                        </MenuItem>
                        <MenuItem
                          onSelect={() =>
                            void run(desktop!.openFile(session.id, file.path, 'vscode'))
                          }
                        >
                          {c.openInVscode}
                        </MenuItem>
                      </SubMenu>
                      <MenuItem
                        disabled={!desktop}
                        onSelect={() => void run(desktop!.revealFile(session.id, file.path))}
                      >
                        {c.showInExplorer}
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem disabled={!desktop} onSelect={() => void revert(file.path)}>
                        {c.revertFile}
                      </MenuItem>
                    </MenuPanel>
                  )}
                </div>
                {expanded && (
                  <div
                    role="region"
                    aria-label={t('development.diffOf', { path: file.path })}
                    className="max-h-[60vh] overflow-auto bg-[var(--surface-0)] py-1 font-mono text-xs leading-5"
                  >
                    {parsePatch(file.patch).map((row, at) => (
                      <div key={at} className={cn('flex', ROW_TONE[row.kind])}>
                        <span className="w-12 shrink-0 select-none pr-2 text-right text-[var(--text-muted)]">
                          {row.newLine ?? row.oldLine ?? ''}
                        </span>
                        <span className="min-w-0 flex-1 whitespace-pre-wrap break-words px-2">
                          {SIGNS[row.kind]}
                          {row.text}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
  const listColumn = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center justify-between px-3">
          <h3 className="text-xs font-semibold">{c.files}</h3>
          <span className="text-xs text-[var(--text-muted)]">{visible.length}</span>
        </div>
        <ul aria-label={c.files} className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          {pending && <FileListSkeleton />}
          {visible.map((file, index) => {
            const { name } = splitPath(file.path);
            return (
              <li key={file.path}>
                <Button
                  variant="ghost"
                  size="sm"
                  title={file.path}
                  className="flex h-7 w-full justify-start gap-2 px-2 text-left font-normal"
                  onClick={() => reveal(file.path, index)}
                >
                  <i
                    className={cn(
                      'ti shrink-0',
                      STATUS_ICONS[file.status],
                      STATUS_TEXT[file.status],
                    )}
                    aria-hidden="true"
                  />
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-xs',
                      viewed.has(file.path) && 'opacity-60',
                    )}
                  >
                    {name}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-green-400">
                    +{file.additions}
                  </span>
                </Button>
              </li>
            );
          })}
        </ul>
      </div>
      {shownCommits && (
        <section
          aria-label={c.commits}
          className={cn(
            'flex min-h-0 flex-col border-t border-[var(--border)]',
            commitsOpen ? 'flex-1' : 'shrink-0',
          )}
        >
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={commitsOpen}
            className="m-1 flex h-7 shrink-0 items-center justify-between px-2 font-normal"
            onClick={() => setCommitsOpen(!commitsOpen)}
          >
            <span className="flex items-center gap-1.5 text-xs font-semibold">
              <i
                className={cn('ti', commitsOpen ? 'ti-chevron-down' : 'ti-chevron-right')}
                aria-hidden="true"
              />
              {c.commits}
            </span>
            <span className="text-xs text-[var(--text-muted)]">{shownCommits.length}</span>
          </Button>
          {commitsOpen && (
            <ul className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
              <li>
                <Button
                  variant={commit === null ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-pressed={commit === null}
                  className="flex h-8 w-full justify-start px-2 text-left text-xs font-normal"
                  onClick={() => setCommit(null)}
                >
                  {c.allChanges}
                </Button>
              </li>
              {shownCommits.length === 0 && (
                <li className="px-2 text-xs text-[var(--text-muted)]">{c.noCommits}</li>
              )}
              {shownCommits.map((item) => (
                <li key={item.hash}>
                  <Button
                    variant={commit === item.hash ? 'secondary' : 'ghost'}
                    size="sm"
                    aria-pressed={commit === item.hash}
                    disabled={!desktop}
                    className="flex h-auto w-full flex-col items-start gap-0 px-2 py-1 text-left font-normal"
                    onClick={() => setCommit(item.hash)}
                  >
                    <span className="w-full truncate text-xs font-medium">{item.subject}</span>
                    <span className="w-full truncate text-xs text-[var(--text-muted)]">
                      <span className="font-mono">{item.hash.slice(0, 8)}</span> · {item.author} ·{' '}
                      {formatDate(item.date, { dateStyle: 'short' })}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );

  return (
    <ResizableBox
      aria-label={c.panels.changes}
      disabled={maximized}
      fill
      labels={{ width: c.resizeBoxWidth, height: c.resizeBoxHeight, both: c.resizeBoxBoth }}
      className={cn(
        'rounded-lg border border-[var(--border)] bg-[var(--surface-1)]',
        maximized && 'fixed inset-0 z-50 rounded-none border-0',
      )}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
          <div className="relative min-w-0">
            <Button
              variant="ghost"
              size="sm"
              aria-haspopup="menu"
              aria-expanded={menu === 'branch'}
              aria-label={c.comparison}
              className="flex h-8 max-w-full gap-2 font-mono text-xs font-normal"
              onClick={() => setMenu(menu === 'branch' ? null : 'branch')}
            >
              <span className="truncate">{comparedWith}</span>
              <i
                className="ti ti-arrow-right shrink-0 text-[var(--text-muted)]"
                aria-hidden="true"
              />
              <span className="truncate">{branch}</span>
              <i className="ti ti-chevron-down shrink-0" aria-hidden="true" />
            </Button>
            {menu === 'branch' && (
              <MenuPanel label={c.comparison} className="w-72" onClose={() => setMenu(null)}>
                <MenuItem
                  radio
                  checked={commit === null}
                  shortcut={t('development.versusBranch', { branch: comparedWith })}
                  onSelect={() => setCommit(null)}
                >
                  {c.allChanges}
                </MenuItem>
                <SubMenu label={c.compareAgainst} value={comparedWith} disabled={!desktop}>
                  <PickerList
                    placeholder={c.searchBranches}
                    empty={c.noResults}
                    selected={comparedWith}
                    items={branches.map((name) => ({
                      key: name,
                      label: name,
                      ...(name === baseBranch ? { tag: c.defaultTag } : {}),
                    }))}
                    onPick={(name) => {
                      setAgainst(name === baseBranch ? null : name);
                      setCommit(null);
                    }}
                  />
                </SubMenu>
                <SubMenu
                  label={c.commits}
                  value={String(shownCommits?.length ?? 0)}
                  disabled={!desktop || !shownCommits?.length}
                >
                  <PickerList
                    placeholder={c.searchCommits}
                    empty={c.noResults}
                    selected={commit}
                    items={commitItems}
                    onPick={setCommit}
                  />
                </SubMenu>
              </MenuPanel>
            )}
          </div>
          <div className="relative flex shrink-0 items-center gap-1">
            <IconButton
              size="sm"
              label={c.searchChanges}
              aria-pressed={searching}
              className={cn(searching && 'bg-[var(--fill-ghost-selected)]')}
              icon={<i className="ti ti-search" aria-hidden="true" />}
              onClick={() => {
                setSearching(!searching);
                setQuery('');
              }}
            />
            <IconButton
              size="sm"
              label={c.toggleFileList}
              aria-pressed={listVisible}
              className={cn(listVisible && 'bg-[var(--fill-ghost-selected)]')}
              icon={<i className="ti ti-list-details" aria-hidden="true" />}
              onClick={() => setListVisible(!listVisible)}
            />
            <IconButton
              size="sm"
              label={c.changesOptions}
              aria-haspopup="menu"
              aria-expanded={menu === 'options'}
              icon={<i className="ti ti-dots" aria-hidden="true" />}
              onClick={() => setMenu(menu === 'options' ? null : 'options')}
            />
            {menu === 'options' && (
              <MenuPanel
                label={c.changesOptions}
                align="right"
                className="w-56"
                onClose={() => setMenu(null)}
              >
                <MenuItem onSelect={() => setAll(true)}>{c.expandAll}</MenuItem>
                <MenuItem onSelect={() => setAll(false)}>{c.collapseAll}</MenuItem>
                <MenuSeparator />
                <MenuItem
                  disabled={!desktop || shownFiles.length === 0}
                  onSelect={() => void revert()}
                >
                  {c.revertAll}
                </MenuItem>
              </MenuPanel>
            )}
            <IconButton
              size="sm"
              label={maximized ? c.restorePanel : c.expandPanel}
              icon={
                <i
                  className={cn('ti', maximized ? 'ti-minimize' : 'ti-maximize')}
                  aria-hidden="true"
                />
              }
              onClick={onToggleMaximize}
            />
            <IconButton
              size="sm"
              label={c.closePanel}
              icon={<i className="ti ti-x" aria-hidden="true" />}
              onClick={onClose}
            />
          </div>
        </div>
        {searching && (
          <div className="border-b border-[var(--border)] p-2">
            <Input
              autoFocus
              className="h-8 text-xs"
              aria-label={c.searchChanges}
              placeholder={c.searchChanges}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        )}
        {notice && (
          <p role="status" className="border-b border-[var(--border)] px-4 py-1.5 text-xs">
            {notice}
          </p>
        )}
        {error && (
          <p
            role="alert"
            className="border-b border-[var(--border)] px-4 py-2 text-sm text-red-300"
          >
            {error}
          </p>
        )}
        {listVisible ? (
          <SplitLayout
            className="min-h-0 flex-1"
            sidePosition="right"
            defaultWidth={280}
            label={c.resizeChangesList}
            side={listColumn}
          >
            {diffColumn}
          </SplitLayout>
        ) : (
          <div className="flex min-h-0 flex-1">{diffColumn}</div>
        )}
      </div>
    </ResizableBox>
  );
}
