import { useEffect, useRef, useState } from 'react';
import type { AgentRunEvent } from '../issues/issue-types.js';

/** `live` once the server confirmed the stream; `offline` until it can be reached again. */
export type LiveStatus = 'connecting' | 'live' | 'offline';

export interface RunStreamHandlers<Event = AgentRunEvent> {
  readonly onReady: () => void;
  readonly onRun: (run: Event) => void;
}

interface UseRunStreamOptions<Event> {
  readonly enabled: boolean;
  /** Opens the stream; resolves when the server closes it and rejects when it cannot be opened. */
  readonly connect: (handlers: RunStreamHandlers<Event>, signal: AbortSignal) => Promise<void>;
  readonly onRun: (run: Event) => void;
  /** The stream is open: load the current state, then let the events keep it up to date. */
  readonly onReady: () => void;
}

const FIRST_RETRY_MS = 1_000;
const LAST_RETRY_MS = 30_000;

/**
 * Keeps a live stream open while `enabled`, reconnecting with a growing delay when it drops. Every
 * connection starts with `onReady`, so a client that missed events while offline reloads its state.
 */
export function useRunStream<Event = AgentRunEvent>({
  enabled,
  connect,
  onRun,
  onReady,
}: UseRunStreamOptions<Event>): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  // The callbacks change on every render; the connection must not restart because of that.
  const latest = useRef({ connect, onRun, onReady });
  latest.current = { connect, onRun, onReady };

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let retries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const open = async () => {
      try {
        await latest.current.connect(
          {
            onReady: () => {
              retries = 0;
              setStatus('live');
              latest.current.onReady();
            },
            onRun: (run) => latest.current.onRun(run),
          },
          controller.signal,
        );
      } catch {
        // Unreachable or refused: handled like a closed stream, by trying again below.
      }
      if (controller.signal.aborted) return;
      setStatus('offline');
      timer = setTimeout(() => void open(), Math.min(LAST_RETRY_MS, FIRST_RETRY_MS * 2 ** retries));
      retries += 1;
    };
    void open();

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [enabled]);

  return status;
}
