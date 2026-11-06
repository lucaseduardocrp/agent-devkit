import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useKanbanDraft } from '../src/lib/use-kanban-draft.js';

const KEY = 'adk:kanban-draft:gap';

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value });
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

describe('useKanbanDraft gaps', () => {
  it('sends again a card that was moved while it was being saved', async () => {
    let finish: () => void = () => undefined;
    const save = vi
      .fn<(id: string, to: string) => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((resolve) => (finish = resolve)))
      .mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useKanbanDraft({ storageKey: KEY, save, onSaved: vi.fn(), delayMs: 100 }),
    );
    act(() => result.current.move('a', 'todo', 'doing'));
    await flushTimers(100);
    expect(save).toHaveBeenCalledTimes(1);
    act(() => result.current.move('a', 'todo', 'done'));
    await flushTimers(100);
    await act(async () => {
      finish();
      await Promise.resolve();
    });
    await flushTimers(1000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith('a', 'done');
  });

  it('does not touch state when it goes offline after unmounting', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { result, unmount } = renderHook(() =>
      useKanbanDraft({ storageKey: KEY, save, onSaved: vi.fn(), delayMs: 1000 }),
    );
    act(() => result.current.move('a', 'todo', 'doing'));
    setOnline(false);
    unmount();
    await flushTimers(10);
    expect(save).not.toHaveBeenCalled();
  });
});
