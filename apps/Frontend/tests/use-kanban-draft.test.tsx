import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useKanbanDraft } from '../src/lib/use-kanban-draft.js';

const KEY = 'adk:kanban-draft:test';
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value });
}

function setup(
  overrides: {
    save?: (id: string, to: string) => Promise<void>;
    onSaved?: () => void;
    storageKey?: string | null;
    delayMs?: number;
  } = {},
) {
  const save = overrides.save ?? vi.fn().mockResolvedValue(undefined);
  const onSaved = overrides.onSaved ?? vi.fn();
  const hook = renderHook(
    (props: { storageKey: string | null }) =>
      useKanbanDraft({
        storageKey: props.storageKey,
        save,
        onSaved,
        delayMs: overrides.delayMs,
      }),
    {
      initialProps: {
        storageKey: overrides.storageKey === undefined ? KEY : overrides.storageKey,
      },
    },
  );
  return {
    ...hook,
    save: save as ReturnType<typeof vi.fn>,
    onSaved: onSaved as ReturnType<typeof vi.fn>,
  };
}

const flushTimers = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  setOnline(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  setOnline(true);
});

describe('useKanbanDraft batching', () => {
  it('keeps moves as a draft and sends them once the user pauses', async () => {
    const { result, save, onSaved } = setup();
    act(() => result.current.move('a', 'todo', 'doing'));
    act(() => result.current.move('b', 'todo', 'done'));
    expect(result.current.draft).toEqual({
      a: { from: 'todo', to: 'doing' },
      b: { from: 'todo', to: 'done' },
    });
    expect(stored()).toEqual(result.current.draft);
    await flushTimers(1000);
    expect(save).not.toHaveBeenCalled();
    // Moving again restarts the quiet time and keeps the first origin.
    act(() => result.current.move('a', 'doing', 'done'));
    expect(result.current.draft['a']).toEqual({ from: 'todo', to: 'done' });
    await flushTimers(1000);
    expect(save).not.toHaveBeenCalled();
    await flushTimers(600);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledWith('a', 'done');
    expect(save).toHaveBeenCalledWith('b', 'done');
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(result.current.draft).toEqual({});
    expect(result.current.saving.size).toBe(0);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('drops a move that goes back to where the card started', async () => {
    const { result, save } = setup();
    act(() => result.current.move('a', 'todo', 'doing'));
    act(() => result.current.move('a', 'doing', 'todo'));
    expect(result.current.draft).toEqual({});
    await flushTimers(5000);
    expect(save).not.toHaveBeenCalled();
  });

  it('sends right away on demand and ignores an empty draft', async () => {
    const { result, save } = setup({ delayMs: 60_000 });
    await act(() => result.current.flush());
    expect(save).not.toHaveBeenCalled();
    act(() => result.current.move('a', 'todo', 'doing'));
    await act(() => result.current.flush());
    expect(save).toHaveBeenCalledWith('a', 'doing');
  });

  it('shows the cards being sent and queues what is moved meanwhile', async () => {
    let release: () => void = () => undefined;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = setup({ save });
    act(() => result.current.move('a', 'todo', 'doing'));
    let first!: Promise<void>;
    await act(async () => {
      first = result.current.flush();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.saving.has('a')).toBe(true);
    // Dropped again, and then back to where it started, while the first save is in flight.
    act(() => result.current.move('a', 'todo', 'done'));
    act(() => result.current.move('a', 'done', 'todo'));
    expect(result.current.draft['a']).toEqual({ from: 'todo', to: 'todo' });
    await act(async () => {
      release();
      await first;
    });
    // The server holds "doing", so the card still has to go to "todo".
    expect(result.current.draft['a']).toEqual({ from: 'doing', to: 'todo' });
    await flushTimers(1600);
    expect(save).toHaveBeenLastCalledWith('a', 'todo');
    await act(async () => release());
    await flushTimers(10);
    expect(result.current.draft).toEqual({});
  });

  it('deletes the entry when the card ends where the server has it', async () => {
    let release: () => void = () => undefined;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = setup({ save });
    act(() => result.current.move('a', 'todo', 'doing'));
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.flush();
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => result.current.move('a', 'todo', 'doing'));
    await act(async () => {
      release();
      await pending;
    });
    expect(result.current.draft).toEqual({});
  });

  it('runs a flush asked during another one after it', async () => {
    let release: () => void = () => undefined;
    const save = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const { result } = setup({ save });
    act(() => result.current.move('a', 'todo', 'doing'));
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = result.current.flush();
      await vi.advanceTimersByTimeAsync(0);
      result.current.move('b', 'todo', 'doing');
      second = result.current.flush();
    });
    await act(async () => {
      release();
      await Promise.all([first, second]);
    });
    expect(save).toHaveBeenCalledWith('b', 'doing');
  });
});

describe('useKanbanDraft in flight', () => {
  it('keeps nothing for a card whose draft was discarded while it was being sent', async () => {
    let release: () => void = () => undefined;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = setup({ save });
    act(() => result.current.move('a', 'todo', 'doing'));
    let pending!: Promise<void>;
    await act(async () => {
      pending = result.current.flush();
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => result.current.discard());
    await act(async () => {
      release();
      await pending;
    });
    expect(result.current.draft).toEqual({});
    expect(result.current.saving.size).toBe(0);
  });

  it('treats a save that throws at once like a failed request', async () => {
    const save = vi.fn(() => {
      throw new Error('Offline client');
    });
    const { result } = setup({ save: save as never });
    act(() => result.current.move('a', 'todo', 'doing'));
    await act(() => result.current.flush());
    expect(result.current.error).toBe('Offline client');
    expect(result.current.draft['a']).toBeDefined();
  });
});

describe('useKanbanDraft failures', () => {
  it('keeps the draft, shows the error and retries with a growing pause', async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('Server down'))
      .mockRejectedValueOnce('plain failure')
      .mockResolvedValue(undefined);
    const { result, onSaved } = setup({ save });
    act(() => result.current.move('a', 'todo', 'doing'));
    await act(() => result.current.flush());
    expect(result.current.error).toBe('Server down');
    expect(result.current.draft['a']).toEqual({ from: 'todo', to: 'doing' });
    expect(stored()['a']).toBeDefined();
    expect(onSaved).not.toHaveBeenCalled();
    await flushTimers(5000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(result.current.error).toBe('Could not save the move.');
    await flushTimers(15_000);
    expect(save).toHaveBeenCalledTimes(3);
    expect(result.current.error).toBeNull();
    expect(result.current.draft).toEqual({});
  });

  it('stops retrying by itself after a few attempts and lets the user try again or discard', async () => {
    const save = vi.fn().mockRejectedValue(new Error('Forbidden'));
    const { result } = setup({ save });
    act(() => result.current.move('a', 'todo', 'doing'));
    await act(() => result.current.flush());
    await flushTimers(5000);
    await flushTimers(15_000);
    await flushTimers(45_000);
    expect(save).toHaveBeenCalledTimes(4);
    await flushTimers(600_000);
    expect(save).toHaveBeenCalledTimes(4);
    expect(result.current.error).toBe('Forbidden');
    act(() => result.current.discard());
    expect(result.current.draft).toEqual({});
    expect(result.current.error).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    await flushTimers(1000);
    expect(save).toHaveBeenCalledTimes(4);
  });
});

describe('useKanbanDraft connection and tab changes', () => {
  it('waits while offline and sends when the connection returns', async () => {
    setOnline(false);
    const { result, save } = setup();
    expect(result.current.offline).toBe(true);
    act(() => result.current.move('a', 'todo', 'doing'));
    await act(() => result.current.flush());
    expect(save).not.toHaveBeenCalled();
    expect(result.current.offline).toBe(true);
    expect(stored()['a']).toBeDefined();
    setOnline(true);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.offline).toBe(false);
    expect(save).toHaveBeenCalledWith('a', 'doing');
  });

  it('notices when the connection drops', () => {
    const { result } = setup();
    expect(result.current.offline).toBe(false);
    act(() => void window.dispatchEvent(new Event('offline')));
    expect(result.current.offline).toBe(true);
  });

  it('sends the draft when the tab is hidden or the page is left', async () => {
    const { result, save } = setup({ delayMs: 60_000 });
    act(() => result.current.move('a', 'todo', 'doing'));
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(save).not.toHaveBeenCalled();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(save).toHaveBeenCalledWith('a', 'doing');
    act(() => result.current.move('b', 'todo', 'doing'));
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(save).toHaveBeenCalledWith('b', 'doing');
  });

  it('warns before the page closes only while there is something unsent', async () => {
    const { result, save } = setup({ delayMs: 60_000 });
    const idle = new Event('beforeunload', { cancelable: true });
    act(() => void window.dispatchEvent(idle));
    expect(idle.defaultPrevented).toBe(false);
    act(() => result.current.move('a', 'todo', 'doing'));
    const event = new Event('beforeunload', { cancelable: true });
    await act(async () => {
      window.dispatchEvent(event);
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(save).toHaveBeenCalledWith('a', 'doing');
  });
});

describe('useKanbanDraft storage', () => {
  it('restores a saved draft on load and sends it', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        a: { from: 'todo', to: 'doing' },
        same: { from: 'x', to: 'x' },
        bad: { from: 1, to: 'y' },
        nothing: null,
      }),
    );
    const { result, save, onSaved } = setup();
    expect(result.current.draft).toEqual({ a: { from: 'todo', to: 'doing' } });
    await flushTimers(10);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('a', 'doing');
    expect(onSaved).toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it.each([['not json'], ['[]'], ['null']])('ignores a damaged draft (%s)', (value) => {
    localStorage.setItem(KEY, value);
    const { result } = setup();
    expect(result.current.draft).toEqual({});
  });

  it('works in memory when the storage is unavailable or there is no workspace', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const blocked = setup();
    act(() => blocked.result.current.move('a', 'todo', 'doing'));
    await act(() => blocked.result.current.flush());
    expect(blocked.save).toHaveBeenCalledWith('a', 'doing');
    vi.restoreAllMocks();
    const none = setup({ storageKey: null });
    act(() => none.result.current.move('a', 'todo', 'doing'));
    expect(localStorage.length).toBe(0);
    await act(() => none.result.current.flush());
    expect(none.save).toHaveBeenCalledWith('a', 'doing');
  });

  it('sends what is left when the screen closes', async () => {
    const { result, save, unmount } = setup({ delayMs: 60_000 });
    act(() => result.current.move('a', 'todo', 'doing'));
    unmount();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledWith('a', 'doing');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('keeps each workspace draft apart and still sends the one left behind', async () => {
    let release: () => void = () => undefined;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { result, rerender } = setup({ save, delayMs: 60_000 });
    act(() => result.current.move('a', 'todo', 'doing'));
    await act(async () => {
      rerender({ storageKey: 'adk:kanban-draft:other' });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.draft).toEqual({});
    expect(save).toHaveBeenCalledWith('a', 'doing');
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
    // The first workspace is clean again and the new one was not touched.
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(result.current.draft).toEqual({});
  });

  it('keeps a move made in a workspace that was left while it was being sent', async () => {
    let release: () => void = () => undefined;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { result, rerender } = setup({ save, delayMs: 60_000 });
    act(() => result.current.move('a', 'todo', 'doing'));
    rerender({ storageKey: 'adk:kanban-draft:other' });
    act(() => result.current.move('z', 'todo', 'done'));
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.draft).toEqual({ z: { from: 'todo', to: 'done' } });
  });

  it('does not update a screen that is gone', async () => {
    let release: () => void = () => undefined;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { result, unmount } = setup({ save });
    act(() => result.current.move('a', 'todo', 'doing'));
    await act(async () => {
      void result.current.flush();
      await vi.advanceTimersByTimeAsync(0);
    });
    unmount();
    await act(async () => {
      release();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
