import { useCallback, useState } from 'react';

/** Where the file tree sits: `auto` is beside the file on a wide pane and under it on a narrow one. */
export type TreePosition = 'auto' | 'left' | 'right';

export interface FilePrefs {
  readonly treeVisible: boolean;
  readonly treePosition: TreePosition;
  /** A file opened with one click replaces the previous such tab instead of adding another. */
  readonly previewTabs: boolean;
  readonly autoSave: boolean;
  /** Tab inserts an indent instead of moving the focus. */
  readonly tabIndents: boolean;
  readonly wordWrap: boolean;
  readonly indentGuides: boolean;
  readonly showWhitespace: boolean;
  readonly scrollPastEnd: boolean;
  readonly tabSize: 2 | 4 | 8;
}

export const DEFAULT_PREFS: FilePrefs = {
  treeVisible: true,
  treePosition: 'auto',
  previewTabs: true,
  autoSave: true,
  tabIndents: true,
  wordWrap: false,
  indentGuides: true,
  showWhitespace: false,
  scrollPastEnd: false,
  tabSize: 4,
};

export const TAB_SIZES = [2, 4, 8] as const;
export const TREE_POSITIONS: readonly TreePosition[] = ['auto', 'left', 'right'];
const STORAGE_KEY = 'adk.development.files';

/** What was saved, kept only where it has the right type; the rest falls back to the default. */
export function readPrefs(raw: string | null): FilePrefs {
  let saved: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? '');
    if (typeof parsed === 'object' && parsed !== null) saved = parsed as Record<string, unknown>;
  } catch {
    // Nothing saved yet, or damaged: the defaults.
  }
  const flag = (key: keyof FilePrefs): boolean => {
    const value = saved[key];
    return typeof value === 'boolean' ? value : (DEFAULT_PREFS[key] as boolean);
  };
  const size = TAB_SIZES.find((item) => item === saved['tabSize']);
  const position = TREE_POSITIONS.find((item) => item === saved['treePosition']);
  return {
    treeVisible: flag('treeVisible'),
    treePosition: position ?? DEFAULT_PREFS.treePosition,
    previewTabs: flag('previewTabs'),
    autoSave: flag('autoSave'),
    tabIndents: flag('tabIndents'),
    wordWrap: flag('wordWrap'),
    indentGuides: flag('indentGuides'),
    showWhitespace: flag('showWhitespace'),
    scrollPastEnd: flag('scrollPastEnd'),
    tabSize: size ?? DEFAULT_PREFS.tabSize,
  };
}

function load(): FilePrefs {
  try {
    return readPrefs(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage can be blocked (private windows): the defaults, kept for this visit only.
    return DEFAULT_PREFS;
  }
}

/** The editor preferences of the Files panel, remembered between visits. */
export function useFilePrefs(): readonly [FilePrefs, (changes: Partial<FilePrefs>) => void] {
  const [prefs, setPrefs] = useState<FilePrefs>(load);
  const update = useCallback((changes: Partial<FilePrefs>) => {
    setPrefs((current) => {
      const next = { ...current, ...changes };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Not remembered, still applied.
      }
      return next;
    });
  }, []);
  return [prefs, update];
}

/** The files of a session a person marked as viewed in Changes, remembered between visits. */
export function useViewedFiles(
  sessionId: string,
): readonly [ReadonlySet<string>, (path: string) => void] {
  const key = `adk.development.viewed.${sessionId}`;
  const [viewed, setViewed] = useState<ReadonlySet<string>>(() => {
    try {
      const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? '[]');
      return new Set(
        Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [],
      );
    } catch {
      return new Set();
    }
  });
  const toggle = useCallback(
    (path: string) =>
      setViewed((current) => {
        const next = new Set(current);
        if (!next.delete(path)) next.add(path);
        try {
          window.localStorage.setItem(key, JSON.stringify([...next]));
        } catch {
          // Not remembered, still applied.
        }
        return next;
      }),
    [key],
  );
  return [viewed, toggle];
}
