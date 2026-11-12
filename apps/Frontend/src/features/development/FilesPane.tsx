import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Input } from '../../components/ui/input.js';
import type { DesktopDevelopmentBridge } from '../../lib/desktop.js';
import { useI18n } from '../../lib/i18n/index.js';
import { cn } from '../../lib/utils.js';
import { MenuItem, MenuPanel, MenuSeparator, SubMenu } from './development-menu.js';
import { diffTree, filterTree, type FileTree, type TreeEntry } from './development-files.js';
import type { DiffFile } from './development-types.js';
import { FileEditor } from './FileEditor.js';
import { ResizableBox } from './ResizableBox.js';
import { SplitLayout } from './SplitLayout.js';
import { TAB_SIZES, TREE_POSITIONS, useFilePrefs } from './files-prefs.js';

interface Props {
  readonly sessionId: string;
  readonly diff: readonly DiffFile[];
  /** Given once the session has a worktree on this computer: files are then read and saved there. */
  readonly desktop?: DesktopDevelopmentBridge;
  /** Changes whenever the session moved; the tree and the open files are read again. */
  readonly refreshKey: string;
  /** A file another panel asked to see; each request has its own object. */
  readonly openRequest: { readonly path: string } | null;
  /** A file was written to the worktree: what is built from the disk (the changes) is stale. */
  readonly onSaved?: () => void;
}

interface OpenTab {
  readonly path: string;
  readonly kind: 'text' | 'binary' | 'patch';
  /** What the editor holds. */
  readonly text: string;
  /** What the disk holds. */
  readonly saved: string;
  /** Replaced by the next file opened with one click, until it is edited or opened twice. */
  readonly preview: boolean;
  readonly readOnly: boolean;
  readonly note: string | null;
}

interface SearchHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

const AUTO_SAVE_MS = 800;
const SEARCH_MS = 250;
const MAX_QUICK_RESULTS = 50;
const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** The text after the "?" of a search of file contents; '' for anything else. */
const contentQuery = (query: string) => (query.startsWith('?') ? query.slice(1).trim() : '');

/** The lines of the files that hold a text, found after a short pause in typing. */
function useContentSearch(query: string, run: (text: string) => Promise<SearchHit[]>) {
  const needle = contentQuery(query);
  const [state, setState] = useState<{ hits: SearchHit[]; loading: boolean }>({
    hits: [],
    loading: false,
  });
  useEffect(() => {
    if (!needle) return setState({ hits: [], loading: false });
    let active = true;
    setState((current) => ({ ...current, loading: true }));
    const timer = window.setTimeout(() => {
      void run(needle).then((hits) => active && setState({ hits, loading: false }));
    }, SEARCH_MS);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [needle, run]);
  return { ...state, searching: needle !== '' };
}

/**
 * The files of a session: tabs and an editor on one side, the tree on the other. In the desktop
 * app the tree is the session's worktree and files can be edited and saved; in a browser it shows
 * the files of the diff, read only.
 */
export function FilesPane({ sessionId, diff, desktop, refreshKey, openRequest, onSaved }: Props) {
  const { t, messages } = useI18n();
  const c = messages.development;
  const [prefs, setPrefs] = useFilePrefs();
  const [loaded, setLoaded] = useState<FileTree>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [tabs, setTabs] = useState<readonly OpenTab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [menu, setMenu] = useState(false);
  const [quick, setQuick] = useState<string | null>(null);
  const [index, setIndex] = useState<readonly string[]>([]);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // Read when a save finishes, so a new callback each render does not restart the auto-save.
  const savedRef = useRef(onSaved);
  savedRef.current = onSaved;
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  const loadFolder = useCallback(
    async (folder: string) => {
      if (!desktop) return;
      const result = await desktop.listFiles(sessionId, folder);
      if (!result.ok) return setError(result.error);
      setLoaded((current) => ({ ...current, [folder]: result.entries }));
      setError(null);
    },
    [desktop, sessionId],
  );
  useEffect(() => {
    void loadFolder('');
  }, [loadFolder]);

  const tree = useMemo(() => (desktop ? loaded : diffTree(diff)), [desktop, loaded, diff]);

  // The agent keeps writing: read the folders and the files that are open again.
  const seen = useRef(refreshKey);
  useEffect(() => {
    if (seen.current === refreshKey) return;
    seen.current = refreshKey;
    if (!desktop) return;
    for (const folder of Object.keys(loadedRef.current)) void loadFolder(folder);
    for (const tab of tabsRef.current) {
      if (tab.kind !== 'text' || tab.text !== tab.saved) continue;
      void desktop.readFile(sessionId, tab.path).then((result) => {
        if (!result.ok || result.file.kind !== 'text') return;
        const content = result.file.content;
        setTabs((current) =>
          current.map((item) =>
            item.path === tab.path && item.text === item.saved
              ? { ...item, text: content, saved: content }
              : item,
          ),
        );
      });
    }
  }, [refreshKey, desktop, sessionId, loadFolder]);

  const tabOf = (path: string | null) => tabs.find((item) => item.path === path);
  const current = tabOf(active);
  const dirty = (tab: OpenTab) => tab.text !== tab.saved;

  const openFile = async (path: string, pin: boolean) => {
    const existing = tabOf(path);
    if (existing) {
      setActive(path);
      if (pin)
        setTabs(tabs.map((item) => (item.path === path ? { ...item, preview: false } : item)));
      return;
    }
    const asPreview = prefs.previewTabs && !pin;
    let tab: OpenTab;
    if (!desktop) {
      // The tree is the diff's own files, so this is always exactly one patch.
      const patch = diff
        .filter((item) => item.path === path)
        .map((item) => item.patch)
        .join('\n');
      tab = {
        path,
        kind: 'patch',
        text: patch,
        saved: patch,
        preview: asPreview,
        readOnly: true,
        note: c.changedFilesOnly,
      };
    } else {
      const result = await desktop.readFile(sessionId, path);
      if (!result.ok) return setError(result.error);
      const file = result.file;
      tab =
        file.kind === 'binary'
          ? {
              path,
              kind: 'binary',
              text: '',
              saved: '',
              preview: asPreview,
              readOnly: true,
              note: c.binaryFile,
            }
          : {
              path,
              kind: 'text',
              text: file.content,
              saved: file.content,
              preview: asPreview,
              // Saving a cut file would erase the rest of it.
              readOnly: file.truncated,
              note: file.truncated ? c.truncatedFile : null,
            };
    }
    setError(null);
    setTabs((open) =>
      open.some((item) => item.path === path)
        ? open.map((item) =>
            item.path === path && !tab.preview ? { ...item, preview: false } : item,
          )
        : [...(tab.preview ? open.filter((item) => !item.preview || dirty(item)) : open), tab],
    );
    setActive(path);
  };
  const openRef = useRef(openFile);
  openRef.current = openFile;
  useEffect(() => {
    if (openRequest) void openRef.current(openRequest.path, true);
  }, [openRequest]);

  const save = useCallback(
    async (path: string) => {
      const tab = tabsRef.current.find((item) => item.path === path);
      if (!desktop || !tab || tab.kind !== 'text' || tab.text === tab.saved) return;
      const text = tab.text;
      const result = await desktop.writeFile(sessionId, path, text);
      if (!result.ok) return setError(result.error);
      setError(null);
      setTabs((open) => open.map((item) => (item.path === path ? { ...item, saved: text } : item)));
      savedRef.current?.();
    },
    [desktop, sessionId],
  );

  // The open file with something unsaved, if any.
  const unsavedPath = current && dirty(current) ? current.path : null;
  useEffect(() => {
    if (!prefs.autoSave || unsavedPath === null) return;
    const timer = window.setTimeout(() => void save(unsavedPath), AUTO_SAVE_MS);
    return () => window.clearTimeout(timer);
  }, [prefs.autoSave, unsavedPath, tabs, save]);

  const edit = (path: string, text: string) =>
    setTabs((open) =>
      open.map((item) => (item.path === path ? { ...item, text, preview: false } : item)),
    );

  const closeTab = (tab: OpenTab) => {
    if (dirty(tab)) {
      if (prefs.autoSave) void save(tab.path);
      else if (!window.confirm(t('development.discardChanges', { path: tab.path }))) return;
    }
    const at = tabs.findIndex((item) => item.path === tab.path);
    const rest = tabs.filter((item) => item.path !== tab.path);
    setTabs(rest);
    if (active === tab.path) setActive((rest[Math.min(at, rest.length - 1)] ?? null)?.path ?? null);
  };

  const toggle = (path: string) => {
    const next = new Set(expanded);
    if (!next.delete(path)) {
      next.add(path);
      if (!tree[path]) void loadFolder(path);
    }
    setExpanded(next);
  };

  const searchLines = useCallback(
    async (text: string): Promise<SearchHit[]> => {
      if (desktop) {
        const result = await desktop.searchFiles(sessionId, text);
        if (result.ok) return result.matches;
        setError(result.error);
        return [];
      }
      const needle = text.toLowerCase();
      return diff.flatMap((file) =>
        file.patch
          .split('\n')
          .flatMap((line, at) =>
            line.toLowerCase().includes(needle)
              ? [{ path: file.path, line: at + 1, text: line.trim().slice(0, 300) }]
              : [],
          ),
      );
    },
    [desktop, sessionId, diff],
  );
  const treeSearch = useContentSearch(filter, searchLines);
  const quickSearch = useContentSearch(quick ?? '', searchLines);

  const openQuick = async () => {
    setQuick('');
    setMenu(false);
    if (!desktop) return setIndex(diff.map((item) => item.path));
    const result = await desktop.fileIndex(sessionId);
    if (result.ok) setIndex(result.files);
    else setError(result.error);
  };
  const quickResults: SearchHit[] =
    quick === null
      ? []
      : quickSearch.searching
        ? quickSearch.hits.slice(0, MAX_QUICK_RESULTS)
        : index
            .filter((path) => path.toLowerCase().includes(quick.trim().toLowerCase()))
            .slice(0, MAX_QUICK_RESULTS)
            .map((path) => ({ path, line: 0, text: '' }));
  const pickQuick = (hit: SearchHit) => {
    setQuick(null);
    void openFile(hit.path, true);
  };

  const shortcut = (event: KeyboardEvent<HTMLElement>) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === 'p' && !event.shiftKey) {
      event.preventDefault();
      void openQuick();
    } else if (key === 'y' && event.shiftKey) {
      event.preventDefault();
      setPrefs({ treeVisible: !prefs.treeVisible });
    }
  };

  const row = (entry: TreeEntry, depth: number, label: string): ReactNode => {
    const folder = entry.kind === 'directory';
    const isOpen = expanded.has(entry.path);
    return (
      <li key={entry.path}>
        <Button
          variant={active === entry.path ? 'secondary' : 'ghost'}
          size="sm"
          aria-expanded={folder ? isOpen : undefined}
          className="flex h-7 w-full justify-start gap-1.5 px-2 text-left font-normal"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => (folder ? toggle(entry.path) : void openFile(entry.path, false))}
          onDoubleClick={() => !folder && void openFile(entry.path, true)}
        >
          <i
            className={cn(
              'ti shrink-0 text-[var(--text-muted)]',
              folder ? (isOpen ? 'ti-chevron-down' : 'ti-chevron-right') : 'ti-file',
            )}
            aria-hidden="true"
          />
          <span className="min-w-0 truncate text-xs">{label}</span>
        </Button>
        {folder && isOpen && <ul>{rows(entry.path, depth + 1)}</ul>}
      </li>
    );
  };
  const rows = (folder: string, depth: number): ReactNode =>
    (tree[folder] ?? []).map((entry) => row(entry, depth, entry.name));

  const filtered = !treeSearch.searching && filter.trim() ? filterTree(tree, filter) : null;
  const empty = filtered ? filtered.length === 0 : (tree[''] ?? []).length === 0;
  const editable = Boolean(desktop) && current?.kind === 'text' && !current.readOnly;

  // The tree is a card of its own beside the file, with a gap, and its edge can be dragged.
  const treeLeft = prefs.treePosition === 'left';

  const mainColumn = (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {current ? (
        <>
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-1.5">
            <span className="min-w-0 truncate font-mono text-xs text-[var(--text-secondary)]">
              {current.path.split('/').join(' \\ ')}
            </span>
            {desktop && unsavedPath !== null && !prefs.autoSave && (
              <Button size="sm" variant="outline" onClick={() => void save(current.path)}>
                {c.saveFile}
              </Button>
            )}
          </div>
          {current.note && (
            <p className="shrink-0 px-4 py-2 text-xs text-[var(--text-muted)]">{current.note}</p>
          )}
          {current.kind !== 'binary' && (
            <div className="min-h-0 flex-1">
              <FileEditor
                key={current.path}
                path={current.path}
                value={current.text}
                editable={editable}
                prefs={prefs}
                preview={preview}
                label={t('development.editorFor', { path: current.path })}
                onChange={(text) => edit(current.path, text)}
                onSave={() => void save(current.path)}
              />
            </div>
          )}
        </>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 p-6 text-center">
          <i className="ti ti-folder text-2xl text-[var(--text-muted)]" aria-hidden="true" />
          <p className="text-sm font-medium">{c.filesEmptyTitle}</p>
          <p className="text-xs text-[var(--text-muted)]">{c.filesEmptyHint}</p>
        </div>
      )}
    </div>
  );
  const treeColumn = (
    <nav
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden p-2"
      aria-label={c.fileTree}
    >
      <Input
        className="h-8 text-xs"
        aria-label={c.filterFiles}
        placeholder={c.filterPlaceholder}
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      {treeSearch.searching ? (
        <ul className="min-h-0 flex-1 overflow-auto" aria-label={c.quickOpenResults}>
          {treeSearch.loading && (
            <li className="px-2 text-xs text-[var(--text-muted)]">{c.searching}</li>
          )}
          {!treeSearch.loading && treeSearch.hits.length === 0 && (
            <li className="px-2 text-xs text-[var(--text-muted)]">{c.noResults}</li>
          )}
          {treeSearch.hits.map((hit) => (
            <li key={`${hit.path}:${hit.line}`}>
              <Button
                variant="ghost"
                size="sm"
                className="flex h-auto w-full flex-col items-start gap-0 px-2 py-1 text-left font-normal"
                onClick={() => void openFile(hit.path, false)}
              >
                <span className="w-full truncate font-mono text-xs">
                  {hit.path}:{hit.line}
                </span>
                <span className="w-full truncate text-xs text-[var(--text-muted)]">{hit.text}</span>
              </Button>
            </li>
          ))}
        </ul>
      ) : empty ? (
        <p className="px-2 text-xs text-[var(--text-muted)]">{c.noFiles}</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto">
          {filtered ? filtered.map((entry) => row(entry, 0, entry.path)) : rows('', 0)}
        </ul>
      )}
    </nav>
  );

  return (
    <ResizableBox
      aria-label={c.panels.files}
      axes="y"
      fill
      minHeight={140}
      onKeyDown={shortcut}
      labels={{ width: c.resizeBoxWidth, height: c.resizeBoxHeight, both: c.resizeBoxBoth }}
      className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)]"
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-2 py-1.5">
          <h2 className="sr-only">{c.panels.files}</h2>
          {tabs.length === 0 ? (
            <span className="px-2 text-sm font-semibold" aria-hidden="true">
              {c.panels.files}
            </span>
          ) : (
            <div
              role="tablist"
              aria-label={c.openTabs}
              className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
            >
              {tabs.map((tab) => (
                <div
                  key={tab.path}
                  className={cn(
                    'flex shrink-0 items-center rounded-md border',
                    tab.path === active
                      ? 'border-[var(--border-strong)] bg-[var(--surface-2)]'
                      : 'border-transparent',
                  )}
                >
                  <Button
                    variant="ghost"
                    size="sm"
                    role="tab"
                    aria-selected={tab.path === active}
                    title={tab.path}
                    className={cn('h-7 gap-1.5 px-2 font-normal', tab.preview && 'italic')}
                    onClick={() => setActive(tab.path)}
                    onDoubleClick={() => void openFile(tab.path, true)}
                  >
                    {nameOf(tab.path)}
                    {dirty(tab) && (
                      <span
                        role="img"
                        aria-label={c.unsavedChanges}
                        className="h-1.5 w-1.5 rounded-full bg-[var(--fill-accent)]"
                      />
                    )}
                  </Button>
                  <IconButton
                    size="xs"
                    label={t('development.closeTab', { name: nameOf(tab.path) })}
                    icon={<i className="ti ti-x" aria-hidden="true" />}
                    onClick={() => closeTab(tab)}
                  />
                </div>
              ))}
            </div>
          )}
          <div className="relative flex shrink-0 items-center gap-1">
            {current && (
              <IconButton
                size="sm"
                label={preview ? c.viewSource : c.viewPreview}
                aria-pressed={preview}
                className={cn(preview && 'bg-[var(--fill-ghost-selected)]')}
                disabled={current.kind === 'binary'}
                icon={<i className={cn('ti', preview ? 'ti-code' : 'ti-eye')} aria-hidden="true" />}
                onClick={() => setPreview(!preview)}
              />
            )}
            <IconButton
              size="sm"
              label={c.showFileTree}
              aria-pressed={prefs.treeVisible}
              className={cn(prefs.treeVisible && 'bg-[var(--fill-ghost-selected)]')}
              icon={<i className="ti ti-list-tree" aria-hidden="true" />}
              onClick={() => setPrefs({ treeVisible: !prefs.treeVisible })}
            />
            <IconButton
              size="sm"
              label={c.fileOptions}
              aria-haspopup="menu"
              aria-expanded={menu}
              icon={<i className="ti ti-dots" aria-hidden="true" />}
              onClick={() => setMenu(!menu)}
            />
            {menu && (
              <MenuPanel
                label={c.fileOptions}
                align="right"
                className="w-72"
                onClose={() => setMenu(false)}
              >
                <MenuItem shortcut="Ctrl+P" onSelect={() => void openQuick()}>
                  {c.goToFile}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  checked={prefs.treeVisible}
                  shortcut="Ctrl+Shift+Y"
                  keepOpen
                  onSelect={() => setPrefs({ treeVisible: !prefs.treeVisible })}
                >
                  {c.showFileTree}
                </MenuItem>
                <SubMenu label={c.fileTreePosition} value={c.treePositions[prefs.treePosition]}>
                  {TREE_POSITIONS.map((position) => (
                    <MenuItem
                      key={position}
                      radio
                      checked={prefs.treePosition === position}
                      onSelect={() => setPrefs({ treePosition: position })}
                    >
                      {c.treePositions[position]}
                    </MenuItem>
                  ))}
                </SubMenu>
                <MenuSeparator />
                <MenuItem disabled={expanded.size === 0} onSelect={() => setExpanded(new Set())}>
                  {c.collapseFolders}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  checked={prefs.previewTabs}
                  keepOpen
                  onSelect={() => setPrefs({ previewTabs: !prefs.previewTabs })}
                >
                  {c.previewTabs}
                </MenuItem>
                <MenuItem
                  checked={prefs.autoSave}
                  keepOpen
                  onSelect={() => setPrefs({ autoSave: !prefs.autoSave })}
                >
                  {c.autoSave}
                </MenuItem>
                <MenuItem
                  checked={prefs.tabIndents}
                  keepOpen
                  onSelect={() => setPrefs({ tabIndents: !prefs.tabIndents })}
                >
                  {c.tabKeyIndents}
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  checked={prefs.wordWrap}
                  keepOpen
                  onSelect={() => setPrefs({ wordWrap: !prefs.wordWrap })}
                >
                  {c.wordWrap}
                </MenuItem>
                <MenuItem
                  checked={prefs.indentGuides}
                  keepOpen
                  onSelect={() => setPrefs({ indentGuides: !prefs.indentGuides })}
                >
                  {c.indentGuides}
                </MenuItem>
                <MenuItem
                  checked={prefs.showWhitespace}
                  keepOpen
                  onSelect={() => setPrefs({ showWhitespace: !prefs.showWhitespace })}
                >
                  {c.showWhitespace}
                </MenuItem>
                <MenuItem
                  checked={prefs.scrollPastEnd}
                  keepOpen
                  onSelect={() => setPrefs({ scrollPastEnd: !prefs.scrollPastEnd })}
                >
                  {c.scrollPastEnd}
                </MenuItem>
                <SubMenu label={c.tabSize} value={String(prefs.tabSize)}>
                  {TAB_SIZES.map((size) => (
                    <MenuItem
                      key={size}
                      radio
                      checked={prefs.tabSize === size}
                      onSelect={() => setPrefs({ tabSize: size })}
                    >
                      {String(size)}
                    </MenuItem>
                  ))}
                </SubMenu>
              </MenuPanel>
            )}
          </div>
        </div>

        {quick !== null && (
          <div
            role="dialog"
            aria-label={c.goToFile}
            className="absolute left-1/2 top-12 z-30 w-[min(32rem,90%)] -translate-x-1/2 rounded-md border border-[var(--border-strong)] bg-[var(--surface-2)] shadow-xl"
            onKeyDown={(event) => event.key === 'Escape' && setQuick(null)}
          >
            <div className="border-b border-[var(--border)] p-2">
              <Input
                autoFocus
                className="h-8 text-xs"
                aria-label={c.quickOpenPlaceholder}
                placeholder={c.quickOpenPlaceholder}
                value={quick}
                onChange={(event) => setQuick(event.target.value)}
                onKeyDown={(event) => {
                  const first = quickResults[0];
                  if (event.key === 'Enter' && first) pickQuick(first);
                }}
              />
            </div>
            <ul className="max-h-72 overflow-y-auto py-1" aria-label={c.quickOpenResults}>
              {quickSearch.searching && quickSearch.loading && (
                <li className="px-3 py-2 text-xs text-[var(--text-muted)]">{c.searching}</li>
              )}
              {!quickSearch.loading && quickResults.length === 0 && (
                <li className="px-3 py-2 text-xs text-[var(--text-muted)]">{c.noResults}</li>
              )}
              {quickResults.map((hit) => (
                <li key={`${hit.path}:${hit.line}`}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="flex h-auto w-full justify-start gap-2 px-3 py-1 text-left font-normal"
                    onClick={() => pickQuick(hit)}
                  >
                    <span className="min-w-0 truncate font-mono text-xs">{hit.path}</span>
                    {hit.line > 0 && (
                      <span className="min-w-0 truncate text-xs text-[var(--text-muted)]">
                        :{hit.line} {hit.text}
                      </span>
                    )}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="border-b border-[var(--border)] px-4 py-2 text-sm text-red-300"
          >
            {error}
          </p>
        )}
        {prefs.treeVisible ? (
          <SplitLayout
            className="min-h-0 flex-1"
            sidePosition={treeLeft ? 'left' : 'right'}
            defaultWidth={260}
            label={c.resizeFileTree}
            side={treeColumn}
          >
            {mainColumn}
          </SplitLayout>
        ) : (
          <div className="min-h-0 flex-1 overflow-hidden">{mainColumn}</div>
        )}
      </div>
    </ResizableBox>
  );
}
