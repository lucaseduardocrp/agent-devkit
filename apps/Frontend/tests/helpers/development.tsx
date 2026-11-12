import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, vi } from 'vitest';
import type { ApiClient } from '../../src/lib/api-client.js';
import type {
  DesktopAssignment,
  DesktopDevelopmentBridge,
  DesktopTerminalEvent,
} from '../../src/lib/desktop.js';
import { DevelopmentView } from '../../src/features/development/DevelopmentView.js';
import type {
  DevChange,
  DevelopmentStreamEvent,
  DevSession,
} from '../../src/features/development/development-types.js';

export const session = (fields: Partial<DevSession> = {}): DevSession => ({
  id: 's1',
  changeId: null,
  title: 'Implement login',
  prompt: 'Do it',
  cli: 'claude',
  status: 'waiting_review',
  attempt: 1,
  worktree: { branch: 'adk/add-login-1a2b3c4d', baseBranch: 'main', path: null },
  context: { windowTokens: 200000, usedTokens: 50000, compactAtPercent: 80, compactions: 0 },
  maxSubagents: 3,
  subagents: [],
  events: [],
  diff: [],
  comments: [],
  summary: '',
  error: null,
  runner: null,
  updatedAt: '2026-11-10T10:00:00.000Z',
  ...fields,
});

/** The API of the Development screens, with a stream the test can push events through. */
export function mockClient(sessions: DevSession[] = [], changes: DevChange[] = []) {
  const stream: {
    ready: () => void;
    event: (event: DevelopmentStreamEvent) => void;
    signal: AbortSignal | null;
    opened: number;
  } = { ready: () => {}, event: () => {}, signal: null, opened: 0 };
  const api = {
    getToken: vi.fn().mockReturnValue('tok'),
    getDevelopmentChanges: vi.fn().mockResolvedValue(changes),
    getAgents: vi.fn().mockResolvedValue([]),
    getDevelopmentRepositories: vi.fn().mockResolvedValue([]),
    getDevelopmentBranches: vi.fn().mockResolvedValue([]),
    getDevelopmentSessions: vi.fn().mockResolvedValue(sessions),
    getDevelopmentSession: vi.fn(),
    getDevelopmentChange: vi.fn(),
    getDevelopmentPipeline: vi
      .fn()
      .mockResolvedValue({ spec: [], approval: [], code: [], review: [], done: [] }),
    createDevelopmentSession: vi.fn().mockResolvedValue(session({ id: 's-new' })),
    changeDevelopmentSession: vi.fn().mockResolvedValue(session()),
    addDevelopmentComment: vi.fn().mockResolvedValue(session()),
    deleteDevelopmentSession: vi.fn().mockResolvedValue(undefined),
    streamDevelopmentEvents: vi.fn(
      (
        handlers: { onReady: () => void; onRun: (event: DevelopmentStreamEvent) => void },
        signal: AbortSignal,
      ) => {
        stream.ready = handlers.onReady;
        stream.event = handlers.onRun;
        stream.signal = signal;
        stream.opened += 1;
        return new Promise<void>(() => undefined);
      },
    ),
  };
  return { api, stream };
}

export type MockApi = ReturnType<typeof mockClient>['api'];

/** The Development calls of the desktop app, as its preload script puts them on the window. */
export function desktopApp() {
  let listener: (id: string, event: DesktopTerminalEvent) => void = () => {};
  const unsubscribe = vi.fn();
  const mock = {
    connect: vi.fn().mockResolvedValue({ ok: true }),
    preferences: vi
      .fn()
      .mockResolvedValue({ ok: true, lastRepoPath: 'D:\\Work\\shop', autonomy: 'auto' }),
    pickFolder: vi.fn().mockResolvedValue({ ok: true, path: null }),
    assign: vi.fn((_id: string, input: { repoPath: string; autonomy: 'safe' | 'auto' }) =>
      Promise.resolve<{ ok: boolean; assignment?: DesktopAssignment; error?: string }>({
        ok: true,
        assignment: { ...input, worktreePath: null },
      }),
    ),
    assignment: vi.fn().mockResolvedValue({ ok: true, assignment: null }),
    listFiles: vi.fn().mockResolvedValue({ ok: true, entries: [] }),
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue({ ok: true }),
    fileIndex: vi.fn().mockResolvedValue({ ok: true, files: [] }),
    searchFiles: vi.fn().mockResolvedValue({ ok: true, matches: [] }),
    filePath: vi.fn().mockResolvedValue({ ok: true, path: 'D:\\wt\\s1\\a.txt' }),
    revealFile: vi.fn().mockResolvedValue({ ok: true }),
    openFile: vi.fn().mockResolvedValue({ ok: true }),
    branches: vi.fn().mockResolvedValue({ ok: true, branches: ['develop', 'main'] }),
    changes: vi.fn().mockResolvedValue({ ok: true, files: [], commits: [] }),
    revertChanges: vi.fn().mockResolvedValue({ ok: true }),
    terminalFolder: vi.fn().mockResolvedValue({ ok: true, cwd: 'D:\\wt\\s1' }),
    runInTerminal: vi.fn().mockResolvedValue({ ok: true, started: true }),
    stopTerminal: vi.fn().mockResolvedValue({ ok: true }),
    onTerminalEvent: vi.fn((given: typeof listener) => {
      listener = given;
      return unsubscribe;
    }),
  };
  Object.defineProperty(window, 'adkDesktop', {
    value: { apiUrl: 'http://127.0.0.1:3000', development: mock },
    configurable: true,
  });
  const emit = (id: string, event: DesktopTerminalEvent) => act(() => listener(id, event));
  return {
    mock: mock as unknown as Record<keyof DesktopDevelopmentBridge, ReturnType<typeof vi.fn>>,
    emit,
    unsubscribe,
  };
}

export function renderView(
  api: MockApi,
  options: { readOnly?: boolean; workspaceId?: string | null; section?: 'code' | 'artifacts' } = {},
) {
  return render(
    <DevelopmentView
      apiClient={api as unknown as ApiClient}
      workspaceId={options.workspaceId === undefined ? 'ws' : options.workspaceId}
      section={options.section ?? 'code'}
      onSelectSection={vi.fn()}
      isReadOnly={options.readOnly ?? false}
    />,
  );
}

export async function show(
  api: MockApi,
  options: { readOnly?: boolean; workspaceId?: string | null; section?: 'code' | 'artifacts' } = {},
) {
  const view = render(
    <DevelopmentView
      apiClient={api as unknown as ApiClient}
      workspaceId={options.workspaceId === undefined ? 'ws' : options.workspaceId}
      section={options.section ?? 'code'}
      onSelectSection={vi.fn()}
      isReadOnly={options.readOnly ?? false}
    />,
  );
  await waitFor(() => expect(view.container.querySelector('.animate-pulse')).toBeNull());
  return view;
}

export const button = (name: string | RegExp) =>
  screen.getByRole<HTMLButtonElement>('button', { name });
export const click = (name: string | RegExp) => fireEvent.click(button(name));
export const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
export const field = (label: string) => screen.getByLabelText<HTMLInputElement>(label);

/** A worktree on this computer for the session `s1`. */
export const worktree: DesktopAssignment = {
  repoPath: 'D:\\Work\\shop',
  autonomy: 'safe',
  worktreePath: 'D:\\wt\\s1',
};
