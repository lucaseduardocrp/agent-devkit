/**
 * True inside the desktop app (apps/Desktop), whose preload script sets `window.adkDesktop`.
 * There the API runs the tests on this computer, so the runner, tunnel and "where the tests run"
 * choices have nothing to offer and stay hidden.
 */
export function isDesktopApp(): boolean {
  return Boolean(window.adkDesktop);
}

/** Where a hosted PostgreSQL is, without its password. */
export interface DesktopCloudTarget {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
}

export interface DesktopStorageStatus {
  readonly mode: 'local' | 'cloud';
  readonly target?: DesktopCloudTarget;
  readonly busy: boolean;
}

export interface DesktopCloudInspection {
  readonly kind: 'empty' | 'adk' | 'other';
  readonly users: number;
  readonly unknownMigrations: readonly string[];
  readonly serverVersion: string;
}

export type DesktopOutcome<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Moves the desktop app's data between this computer and a hosted PostgreSQL. Implemented by the
 * Electron main process (apps/Desktop/src/main/index.ts); connect and disconnect restart ADK.
 */
export interface DesktopStorageBridge {
  status(): Promise<DesktopStorageStatus>;
  inspect(
    url: string,
  ): Promise<DesktopOutcome<{ inspection: DesktopCloudInspection; target: DesktopCloudTarget }>>;
  connect(input: {
    url: string;
    copyLocalData: boolean;
    integrationEncryptionKey?: string;
  }): Promise<DesktopOutcome>;
  disconnect(input: { copyCloudData: boolean }): Promise<DesktopOutcome>;
  copyEncryptionKey(): Promise<DesktopOutcome>;
}

/** The storage calls of the desktop app; undefined in a browser or an older desktop build. */
export function desktopStorage(): DesktopStorageBridge | undefined {
  return window.adkDesktop?.storage;
}

/** `safe` lets the agent edit files of the worktree only; `auto` also lets it run commands. */
export type DesktopAutonomy = 'safe' | 'auto';

/** Where a Development session runs on this computer. */
export interface DesktopAssignment {
  readonly repoPath: string;
  readonly autonomy: DesktopAutonomy;
  /** Set once the session's worktree exists on disk. */
  readonly worktreePath: string | null;
}

export interface DesktopFileEntry {
  readonly name: string;
  /** Relative to the worktree, with forward slashes. */
  readonly path: string;
  readonly kind: 'directory' | 'file';
}

export type DesktopFileContent =
  | { readonly kind: 'text'; readonly content: string; readonly truncated: boolean }
  | { readonly kind: 'binary' };

export interface DesktopDiffFile {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted';
  readonly additions: number;
  readonly deletions: number;
  readonly patch: string;
}

export interface DesktopCommit {
  readonly hash: string;
  readonly author: string;
  readonly date: string;
  readonly subject: string;
}

export interface DesktopContentMatch {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

export type DesktopTerminalEvent =
  | { readonly type: 'output'; readonly text: string }
  | { readonly type: 'exit'; readonly code: number; readonly cwd: string };

/**
 * Development > Code in the desktop app: the app executes the sessions itself (no `devkit
 * develop`) and reads each session's worktree. Implemented by the Electron main process
 * (apps/Desktop/src/main/development-ipc.ts).
 */
export interface DesktopDevelopmentBridge {
  /** Signs the runner in as the person using the app; null signs it out. */
  connect(
    credentials: { token: string; workspaceId: string | null } | null,
  ): Promise<DesktopOutcome>;
  preferences(): Promise<
    DesktopOutcome<{ lastRepoPath: string | null; autonomy: DesktopAutonomy }>
  >;
  /** Asks for a repository folder; `path` is null when the person gave up. */
  pickFolder(): Promise<DesktopOutcome<{ path: string | null }>>;
  assign(
    sessionId: string,
    input: { repoPath: string; autonomy: DesktopAutonomy },
  ): Promise<DesktopOutcome<{ assignment: DesktopAssignment }>>;
  assignment(sessionId: string): Promise<DesktopOutcome<{ assignment: DesktopAssignment | null }>>;
  listFiles(
    sessionId: string,
    folder: string,
  ): Promise<DesktopOutcome<{ entries: DesktopFileEntry[] }>>;
  readFile(sessionId: string, path: string): Promise<DesktopOutcome<{ file: DesktopFileContent }>>;
  /** Saves a text file of the worktree. */
  writeFile(sessionId: string, path: string, content: string): Promise<DesktopOutcome>;
  /** Every file of the worktree, for going to a file by name. */
  fileIndex(sessionId: string): Promise<DesktopOutcome<{ files: string[] }>>;
  /** The lines of the worktree's files that hold a text. */
  searchFiles(
    sessionId: string,
    query: string,
  ): Promise<DesktopOutcome<{ matches: DesktopContentMatch[] }>>;
  /** The absolute path of a file of the worktree on this computer. */
  filePath(sessionId: string, path: string): Promise<DesktopOutcome<{ path: string }>>;
  revealFile(sessionId: string, path: string): Promise<DesktopOutcome>;
  openFile(sessionId: string, path: string, target: 'default' | 'vscode'): Promise<DesktopOutcome>;
  /** The branches of the repository, to compare the session against. */
  branches(sessionId: string): Promise<DesktopOutcome<{ branches: string[] }>>;
  /** The changes of the session against its base branch, or against another branch or one commit. */
  changes(
    sessionId: string,
    baseBranch: string,
    choice?: { against?: string; commit?: string },
  ): Promise<DesktopOutcome<{ files: DesktopDiffFile[]; commits: DesktopCommit[] }>>;
  /** Discards the changes against the base branch: of one file, or of all when no path is given. */
  revertChanges(sessionId: string, baseBranch: string, path?: string): Promise<DesktopOutcome>;
  terminalFolder(sessionId: string): Promise<DesktopOutcome<{ cwd: string }>>;
  runInTerminal(sessionId: string, line: string): Promise<DesktopOutcome<{ started: boolean }>>;
  stopTerminal(sessionId: string): Promise<DesktopOutcome>;
  /** Follows the terminals' output; returns what stops following. */
  onTerminalEvent(listener: (sessionId: string, event: DesktopTerminalEvent) => void): () => void;
}

/** The Development calls of the desktop app; undefined in a browser or an older desktop build. */
export function desktopDevelopment(): DesktopDevelopmentBridge | undefined {
  return window.adkDesktop?.development;
}

declare global {
  interface Window {
    /** Set by the desktop app's preload script (apps/Desktop); absent in a browser. */
    readonly adkDesktop?: {
      /** Address of the API the desktop app started on this computer. */
      readonly apiUrl: string;
      /** Moves the data to a hosted PostgreSQL and back (Integrations > Storage). */
      readonly storage?: DesktopStorageBridge;
      /** Executes Development sessions on this computer (Development > Code). */
      readonly development?: DesktopDevelopmentBridge;
    };
  }
}
