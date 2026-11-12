import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRunStream, type RunStreamHandlers } from '../src/features/agents/use-run-stream.js';
import type { AgentRunEvent } from '../src/features/issues/issue-types.js';

type Connect = (handlers: RunStreamHandlers, signal: AbortSignal) => Promise<void>;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const flush = () => act(async () => void (await Promise.resolve()));
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const hold = () => new Promise<void>(() => undefined);

describe('useRunStream', () => {
  it('does not connect while disabled', () => {
    const connect = vi.fn<Connect>(hold);
    renderHook(() => useRunStream({ enabled: false, connect, onRun: vi.fn(), onReady: vi.fn() }));
    expect(connect).not.toHaveBeenCalled();
  });

  it('goes live when the server confirms the stream and forwards runs', () => {
    let handlers!: RunStreamHandlers;
    const connect = vi.fn<Connect>((given) => {
      handlers = given;
      return hold();
    });
    const onRun = vi.fn();
    const onReady = vi.fn();
    const { result } = renderHook(() => useRunStream({ enabled: true, connect, onRun, onReady }));
    expect(result.current).toBe('connecting');

    act(() => handlers.onReady());
    expect(result.current).toBe('live');
    expect(onReady).toHaveBeenCalledOnce();

    const event = { id: 'r1' } as AgentRunEvent;
    act(() => handlers.onRun(event));
    expect(onRun).toHaveBeenCalledWith(event);
  });

  it('reconnects with a growing delay after the stream drops, and reloads once live', async () => {
    const handlers: RunStreamHandlers[] = [];
    const outcomes: ('fail' | 'hold')[] = ['fail', 'fail', 'hold'];
    const connect = vi.fn<Connect>((given) => {
      handlers.push(given);
      return outcomes.shift() === 'fail' ? Promise.reject(new Error('unreachable')) : hold();
    });
    const onReady = vi.fn();
    const { result } = renderHook(() =>
      useRunStream({ enabled: true, connect, onRun: vi.fn(), onReady }),
    );

    await flush();
    expect(result.current).toBe('offline');
    expect(connect).toHaveBeenCalledTimes(1);

    await advance(999);
    expect(connect).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(connect).toHaveBeenCalledTimes(2);

    // The second failure waits twice as long.
    await advance(1_999);
    expect(connect).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(connect).toHaveBeenCalledTimes(3);

    act(() => handlers[2]!.onReady());
    expect(result.current).toBe('live');
    expect(onReady).toHaveBeenCalledOnce();
  });

  it('starts the delay over after a connection that worked', async () => {
    const connect = vi.fn<Connect>((given) => {
      given.onReady();
      return Promise.resolve();
    });
    renderHook(() => useRunStream({ enabled: true, connect, onRun: vi.fn(), onReady: vi.fn() }));
    await flush();
    // Closed right after being ready: every retry waits the first delay, not a longer one.
    await advance(1_000);
    expect(connect).toHaveBeenCalledTimes(2);
    await advance(1_000);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('never waits more than thirty seconds between attempts', async () => {
    const connect = vi.fn<Connect>(() => Promise.reject(new Error('down')));
    renderHook(() => useRunStream({ enabled: true, connect, onRun: vi.fn(), onReady: vi.fn() }));
    await flush();
    await advance(200_000);
    const afterBackoff = connect.mock.calls.length;
    await advance(30_000);
    expect(connect.mock.calls.length).toBe(afterBackoff + 1);
  });

  it('closes the stream and stops retrying when disabled or unmounted', async () => {
    let signal!: AbortSignal;
    const connect = vi.fn<Connect>((_handlers, given) => {
      signal = given;
      return new Promise<void>((_resolve, reject) =>
        given.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    });
    const { rerender, unmount } = renderHook(
      ({ enabled }) => useRunStream({ enabled, connect, onRun: vi.fn(), onReady: vi.fn() }),
      { initialProps: { enabled: true } },
    );
    expect(signal.aborted).toBe(false);
    rerender({ enabled: false });
    expect(signal.aborted).toBe(true);
    await flush();
    await advance(60_000);
    expect(connect).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('uses the latest callbacks without reconnecting', () => {
    let handlers!: RunStreamHandlers;
    const connect = vi.fn<Connect>((given) => {
      handlers = given;
      return hold();
    });
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = renderHook(
      ({ onRun }) => useRunStream({ enabled: true, connect, onRun, onReady: vi.fn() }),
      { initialProps: { onRun: first } },
    );
    rerender({ onRun: second });
    act(() => handlers.onRun({ id: 'r1' } as AgentRunEvent));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledTimes(1);
  });
});
