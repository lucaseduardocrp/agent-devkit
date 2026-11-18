import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import type {
  DesktopAssignment,
  DesktopCommit,
  DesktopDevelopmentBridge,
} from '../../lib/desktop.js';
import { useI18n } from '../../lib/i18n/index.js';
import { cn } from '../../lib/utils.js';
import { ChangesPane } from './ChangesPane.js';
import { ChatPane } from './ChatPane.js';
import { ResizableBox } from './ResizableBox.js';
import { SplitLayout } from './SplitLayout.js';
import { FilesPane } from './FilesPane.js';
import { SessionSidebar } from './SessionSidebar.js';
import { TerminalPane } from './TerminalPane.js';
import { TimelineList } from './TimelineList.js';
import type { DevSession, DiffFile } from './development-types.js';
import { Hint, Panel, SessionBadge, type SectionActions } from './development-ui.js';

interface Props extends SectionActions {
  readonly apiClient: ApiClient;
  readonly session: DevSession;
  /** The desktop app, which executes the session and reads its worktree; absent in a browser. */
  readonly desktop?: DesktopDevelopmentBridge;
  readonly onOpenReview: (sessionId: string) => void;
  /** Back to the list of sessions. */
  readonly onBack: () => void;
  readonly onDelete: (session: DevSession) => void;
}

/** Pulled narrower than this, the chat closes (and its button is released): a few words per line cannot be read. */
const CHAT_MIN_WIDTH = 220;

interface WorktreeChanges {
  readonly files: readonly DiffFile[];
  readonly commits: readonly DesktopCommit[];
}

/**
 * One coding session, laid out like a coding agent's workspace: where it runs and how full its
 * context is on the side, the timeline or the files in the middle, and the changes or a terminal
 * below, opened from the toolbar. It follows the session live: every report of the agent reaches
 * it through the stream of the screen and the files and changes are read again.
 */
export function SessionWorkspace({
  apiClient,
  session,
  desktop,
  onOpenReview,
  onBack,
  onDelete,
  busy,
  readOnly,
  canDelete,
  run,
}: Props) {
  const { t, messages } = useI18n();
  const c = messages.development;
  const [assignment, setAssignment] = useState<DesktopAssignment | null>(null);
  const [changes, setChanges] = useState<WorktreeChanges | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The agent's summary is read on demand, not always in the way of the work.
  const [showSummary, setShowSummary] = useState(false);
  const [view, setView] = useState<'timeline' | 'files'>('timeline');
  const [bottom, setBottom] = useState<'changes' | 'terminal' | null>(null);
  const [maximized, setMaximized] = useState(false);
  const [chatOpen, setChatOpen] = useState(true);
  const [openRequest, setOpenRequest] = useState<{ path: string } | null>(null);

  // The worktree appears while the session runs: ask again each time the session reports.
  useEffect(() => {
    if (!desktop) return;
    void desktop
      .assignment(session.id)
      .then((result) => setAssignment(result.ok ? result.assignment : null));
  }, [desktop, session.id, session.updatedAt]);

  // Only a session with a worktree on this computer can be read from disk.
  const local = desktop && assignment?.worktreePath ? desktop : undefined;
  const { baseBranch } = session.worktree;
  const refreshChanges = useCallback(async () => {
    if (!local) return;
    const result = await local.changes(session.id, baseBranch);
    if (!result.ok) return setNotice(result.error);
    setChanges({ files: result.files, commits: result.commits });
    setNotice(null);
  }, [local, session.id, baseBranch]);
  // The agent writes while it works, and every report of it moves updatedAt.
  useEffect(() => {
    void refreshChanges();
  }, [refreshChanges, session.status, session.updatedAt]);
  // Files are also changed outside the app (an editor, a terminal): read them again on coming back
  // to the window and when the changes are opened.
  useEffect(() => {
    const again = () => void refreshChanges();
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  }, [refreshChanges]);
  useEffect(() => {
    if (bottom === 'changes') void refreshChanges();
  }, [bottom, refreshChanges]);

  const chooseFolder = async (bridge: DesktopDevelopmentBridge) => {
    const picked = await bridge.pickFolder();
    if (!picked.ok) return setNotice(picked.error);
    if (!picked.path) return;
    const result = await bridge.assign(session.id, { repoPath: picked.path, autonomy: 'safe' });
    if (!result.ok) return setNotice(result.error);
    setAssignment(result.assignment);
    setNotice(null);
  };

  const files = changes?.files ?? session.diff;
  const toggle = (panel: 'changes' | 'terminal') => {
    setBottom(bottom === panel ? null : panel);
    setMaximized(false);
  };
  const tool = (pressed: boolean) => cn(pressed && 'bg-[var(--fill-ghost-selected)]');
  // A file asked for from Changes opens in the Files panel.
  const openFile = (path: string) => {
    setView('files');
    setOpenRequest({ path });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold">{session.title}</h2>
            <SessionBadge status={session.status} />
          </div>
          <p className="text-sm text-[var(--text-muted)]">
            {session.cli} · {t('development.attempt', { attempt: session.attempt })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={onBack}>
            <i className="ti ti-list" aria-hidden="true" /> {c.backToSessions}
          </Button>
          {session.summary && (
            <Button
              variant="outline"
              aria-pressed={showSummary}
              onClick={() => setShowSummary(!showSummary)}
            >
              <i className="ti ti-file-text" aria-hidden="true" />{' '}
              {showSummary ? c.hideSummary : c.viewSummary}
            </Button>
          )}
          {session.status === 'waiting_review' && (
            <Button variant="outline" onClick={() => onOpenReview(session.id)}>
              <i className="ti ti-git-pull-request" aria-hidden="true" /> {c.openReview}
            </Button>
          )}
          {!readOnly &&
            (session.status === 'failed' || session.status === 'cancelled' ? (
              <Button
                variant="outline"
                disabled={busy}
                onClick={() =>
                  void run(() => apiClient.changeDevelopmentSession(session.id, 'retry'))
                }
              >
                {c.retry}
              </Button>
            ) : (
              session.status !== 'approved' && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(() => apiClient.changeDevelopmentSession(session.id, 'cancel'))
                  }
                >
                  {c.cancelSession}
                </Button>
              )
            ))}
          {canDelete && session.status !== 'running' && (
            <Button variant="destructive" disabled={busy} onClick={() => onDelete(session)}>
              {c.delete}
            </Button>
          )}
          <div
            role="toolbar"
            aria-label={c.panels.files}
            className="flex items-center gap-1 rounded-md border border-[var(--border)] p-1"
          >
            <IconButton
              size="sm"
              label={c.panels.chat}
              aria-pressed={chatOpen}
              className={tool(chatOpen)}
              icon={<i className="ti ti-message" aria-hidden="true" />}
              onClick={() => setChatOpen(!chatOpen)}
            />
            <IconButton
              size="sm"
              label={c.panels.timeline}
              aria-pressed={view === 'timeline'}
              className={tool(view === 'timeline')}
              icon={<i className="ti ti-list-details" aria-hidden="true" />}
              onClick={() => setView('timeline')}
            />
            <IconButton
              size="sm"
              label={c.panels.terminal}
              title={
                local ? c.panels.terminal : desktop ? c.terminalUnavailable : c.terminalDesktopOnly
              }
              aria-pressed={bottom === 'terminal'}
              className={tool(bottom === 'terminal')}
              disabled={!local}
              icon={<i className="ti ti-terminal-2" aria-hidden="true" />}
              onClick={() => toggle('terminal')}
            />
            <IconButton
              size="sm"
              label={c.panels.changes}
              aria-pressed={bottom === 'changes'}
              className={tool(bottom === 'changes')}
              icon={<i className="ti ti-file-diff" aria-hidden="true" />}
              onClick={() => toggle('changes')}
            />
            <IconButton
              size="sm"
              label={c.panels.files}
              aria-pressed={view === 'files'}
              className={tool(view === 'files')}
              icon={<i className="ti ti-folder" aria-hidden="true" />}
              onClick={() => setView('files')}
            />
          </div>
        </div>
      </div>

      {(session.error ?? notice) && (
        <div
          role="alert"
          className="rounded-md border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-300"
        >
          {session.error ?? notice}
        </div>
      )}
      {session.status === 'queued' && (
        <Hint>{desktop ? (assignment ? c.startingHere : c.folderHint) : c.waitingRunner}</Hint>
      )}

      <SplitLayout
        plain
        className="min-h-0 flex-1"
        defaultWidth={480}
        label={t('common.resizeSidebar')}
        side={
          <SessionSidebar
            session={session}
            assignment={assignment}
            files={files}
            {...(desktop && !assignment && !readOnly
              ? { onChooseFolder: () => void chooseFolder(desktop) }
              : {})}
            onViewChanges={() => setBottom('changes')}
          />
        }
      >
        <SplitLayout
          plain
          className="h-full min-h-0"
          defaultWidth={380}
          collapsed={!chatOpen}
          minWidth={CHAT_MIN_WIDTH}
          onCollapse={() => setChatOpen(false)}
          label={c.resizeChat}
          side={
            <ChatPane
              session={session}
              readOnly={readOnly}
              busy={busy}
              onSend={async (body) => {
                let sent = true;
                await run(async () => {
                  try {
                    await apiClient.addDevelopmentComment(session.id, body);
                  } catch (error) {
                    sent = false;
                    throw error;
                  }
                });
                return sent;
              }}
            />
          }
        >
          <div className="flex h-full min-h-0 min-w-0 flex-col gap-4 overflow-y-auto">
            {session.summary && showSummary && (
              <Panel title={c.summary}>
                <p className="whitespace-pre-wrap text-sm">{session.summary}</p>
              </Panel>
            )}
            {view === 'files' ? (
              <FilesPane
                sessionId={session.id}
                diff={files}
                {...(local ? { desktop: local } : {})}
                refreshKey={session.updatedAt}
                openRequest={openRequest}
                onSaved={() => void refreshChanges()}
              />
            ) : (
              <ResizableBox
                aria-label={c.events}
                axes="y"
                fill
                minHeight={140}
                labels={{
                  width: c.resizeBoxWidth,
                  height: c.resizeBoxHeight,
                  both: c.resizeBoxBoth,
                }}
                className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)]"
              >
                <div className="h-full overflow-y-auto p-4">
                  <TimelineList events={session.events} />
                </div>
              </ResizableBox>
            )}
            {bottom === 'changes' && (
              <ChangesPane
                session={session}
                files={files}
                commits={changes ? changes.commits : null}
                refreshKey={session.updatedAt}
                maximized={maximized}
                onToggleMaximize={() => setMaximized(!maximized)}
                onClose={() => {
                  setBottom(null);
                  setMaximized(false);
                }}
                onOpenFile={openFile}
                onAttachContext={async (path) => {
                  await apiClient.addDevelopmentComment(
                    session.id,
                    t('development.contextComment', { path }),
                    path,
                  );
                }}
                {...(local ? { desktop: local } : {})}
              />
            )}
            {bottom === 'terminal' && local && (
              <TerminalPane sessionId={session.id} desktop={local} />
            )}
          </div>
        </SplitLayout>
      </SplitLayout>
    </div>
  );
}
