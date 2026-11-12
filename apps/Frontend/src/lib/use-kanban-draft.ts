import { useCallback, useEffect, useRef, useState } from 'react';
import { getMessages } from './i18n/index.js';

/** A card moved by the user: the status the server knows (`from`) and where it was dropped. */
export interface KanbanDraftEntry {
  from: string;
  to: string;
}
export type KanbanDraftMap = Readonly<Record<string, KanbanDraftEntry>>;

export interface KanbanDraftOptions {
  /** Where the draft survives reloads; null disables saving (no workspace yet). */
  storageKey: string | null;
  /** Persists one move on the server. Must update the caller's own copy of the card. */
  save: (id: string, to: string) => Promise<void>;
  /** Runs once after a batch saved at least one move. */
  onSaved?: () => void;
  /** Quiet time after the last move before the batch is sent. */
  delayMs?: number;
}

export interface KanbanDraft {
  /** Moves not yet confirmed by the server, by card id. */
  draft: KanbanDraftMap;
  /** Cards whose move is being sent right now. */
  saving: ReadonlySet<string>;
  /** The browser has no connection, so the draft waits in storage. */
  offline: boolean;
  /** Message of the last failed batch; the draft is kept and retried. */
  error: string | null;
  move: (id: string, from: string, to: string) => void;
  /** Sends the draft now instead of waiting for the quiet time. */
  flush: () => Promise<void>;
  /** Drops the unsent moves; the cards go back to the server state. */
  discard: () => void;
}

const RETRY_BASE_MS = 5000;
const MAX_AUTOMATIC_RETRIES = 3;

function readDraft(key: string | null): KanbanDraftMap {
  if (!key) return {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, KanbanDraftEntry] => {
        const value = entry[1] as Partial<KanbanDraftEntry> | null;
        return (
          !!value &&
          typeof value.from === 'string' &&
          typeof value.to === 'string' &&
          value.from !== value.to
        );
      },
    );
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function writeDraft(key: string | null, draft: KanbanDraftMap): void {
  if (!key) return;
  try {
    if (Object.keys(draft).length) localStorage.setItem(key, JSON.stringify(draft));
    else localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in private browsing; the draft still lives in memory.
  }
}

/**
 * Keeps card moves of a Kanban as a draft and sends them in one batch once the user pauses, so
 * reorganising many cards does not hit the API for each drop. The draft is mirrored in the
 * browser storage and sent again when the tab is hidden or closed, the connection returns or the
 * page is opened later, so no move is lost.
 */
export function useKanbanDraft(options: KanbanDraftOptions): KanbanDraft {
  const { storageKey, delayMs = 1500 } = options;
  const [draft, setDraft] = useState<KanbanDraftMap>(() => readDraft(storageKey));
  const [saving, setSaving] = useState<ReadonlySet<string>>(new Set());
  const [offline, setOffline] = useState(
    () => typeof navigator !== 'undefined' && navigator.onLine === false,
  );
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef<KanbanDraftMap>(draft);
  const savingRef = useRef<Set<string>>(new Set());
  const keyRef = useRef(storageKey);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const attempts = useRef(0);
  const running = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const latest = useRef(options);
  latest.current = options;

  /** Stores a new draft for the key it belongs to, even if the screen moved on meanwhile. */
  const commit = useCallback((next: KanbanDraftMap, key: string | null) => {
    writeDraft(key, next);
    if (keyRef.current !== key) return;
    draftRef.current = next;
    if (mounted.current) setDraft(next);
  }, []);

  const clearTimer = () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  };

  /**
   * Sends a draft. `scope` is what the screen held when the flush was asked for; it matters when
   * the workspace changes right after, because then the draft left behind is still sent.
   */
  const run = useCallback(
    async (scope: { key: string | null; draft: KanbanDraftMap }) => {
      const key = scope.key;
      const source = keyRef.current === key ? draftRef.current : scope.draft;
      const entries = Object.entries(source).filter(([id]) => !savingRef.current.has(id));
      if (!entries.length) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        if (mounted.current) setOffline(true);
        return;
      }
      if (mounted.current) {
        setOffline(false);
        setError(null);
      }
      for (const [id] of entries) savingRef.current.add(id);
      if (mounted.current) setSaving(new Set(savingRef.current));
      const results = await Promise.allSettled(
        entries.map(async ([id, entry]) => latest.current.save(id, entry.to)),
      );
      const next: Record<string, KanbanDraftEntry> =
        keyRef.current === key ? { ...draftRef.current } : { ...readDraft(key) };
      let saved = 0;
      let failure: string | null = null;
      results.forEach((result, index) => {
        const [id, entry] = entries[index]!;
        savingRef.current.delete(id);
        if (result.status === 'rejected') {
          const reason: unknown = result.reason;
          failure = reason instanceof Error ? reason.message : getMessages().common.moveSaveFailed;
          return;
        }
        saved += 1;
        const current = next[id];
        if (!current) return;
        // Moved again while it was being sent: the server now holds `entry.to`.
        if (current.to === entry.to) delete next[id];
        else next[id] = { from: entry.to, to: current.to };
      });
      commit(next, key);
      if (mounted.current) setSaving(new Set(savingRef.current));
      if (saved) latest.current.onSaved?.();
      if (failure !== null) {
        if (mounted.current) setError(failure);
        attempts.current += 1;
        if (attempts.current <= MAX_AUTOMATIC_RETRIES)
          timer.current = setTimeout(
            () => void flush(),
            RETRY_BASE_MS * 3 ** (attempts.current - 1),
          );
        return;
      }
      attempts.current = 0;
      if (Object.keys(next).length) timer.current = setTimeout(() => void flush(), delayMs);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [commit, delayMs],
  );

  const flush = useCallback((): Promise<void> => {
    clearTimer();
    // Batches never overlap: a flush asked during one runs right after it.
    const scope = { key: keyRef.current, draft: draftRef.current };
    const chain = (running.current ?? Promise.resolve()).then(() => run(scope));
    running.current = chain;
    return chain;
  }, [run]);

  const move = useCallback(
    (id: string, from: string, to: string) => {
      const origin = draftRef.current[id]?.from ?? from;
      const next = { ...draftRef.current };
      // A card being sent keeps its entry even when dropped back where it started, because the
      // server is about to hold the other status.
      if (origin === to && !savingRef.current.has(id)) delete next[id];
      else next[id] = { from: origin, to };
      commit(next, keyRef.current);
      clearTimer();
      if (Object.keys(next).length) timer.current = setTimeout(() => void flush(), delayMs);
    },
    [commit, delayMs, flush],
  );

  const discard = useCallback(() => {
    clearTimer();
    attempts.current = 0;
    commit({}, keyRef.current);
    setError(null);
  }, [commit]);

  // Another workspace brings its own draft; what was left behind is still sent.
  useEffect(() => {
    mounted.current = true;
    keyRef.current = storageKey;
    const restored = readDraft(storageKey);
    draftRef.current = restored;
    setDraft(restored);
    if (Object.keys(restored).length) timer.current = setTimeout(() => void flush(), 0);
    return () => {
      void flush();
      clearTimer();
      mounted.current = false;
    };
  }, [storageKey, flush]);

  useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') void flush();
    };
    const onPageHide = () => void flush();
    const onOnline = () => {
      setOffline(false);
      attempts.current = 0;
      void flush();
    };
    const onOffline = () => setOffline(true);
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!Object.keys(draftRef.current).length) return;
      void flush();
      // The draft is also in storage, but the browser can still warn about unsent moves.
      event.preventDefault();
    };
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [flush]);

  return { draft, saving, offline, error, move, flush, discard };
}
