// Runs in the sandboxed page before the web app: hands it the address of the API on this computer,
// the calls that move ADK's data to a hosted PostgreSQL (Integrations > Storage) and the ones that
// execute Development sessions on this computer (Development > Code).
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

const development = (channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke(`adk:dev-${channel}`, ...args);

contextBridge.exposeInMainWorld('adkDesktop', {
  apiUrl: ipcRenderer.sendSync('adk:api-url') as string,
  storage: {
    status: () => ipcRenderer.invoke('adk:storage-status'),
    inspect: (url: string) => ipcRenderer.invoke('adk:storage-inspect', url),
    connect: (input: { url: string; copyLocalData: boolean; integrationEncryptionKey?: string }) =>
      ipcRenderer.invoke('adk:storage-connect', input),
    disconnect: (input: { copyCloudData: boolean }) =>
      ipcRenderer.invoke('adk:storage-disconnect', input),
    copyEncryptionKey: () => ipcRenderer.invoke('adk:storage-copy-key'),
  },
  development: {
    connect: (credentials: { token: string; workspaceId: string | null } | null) =>
      development('connect', credentials),
    preferences: () => development('preferences'),
    pickFolder: () => development('pick-folder'),
    assign: (sessionId: string, input: { repoPath: string; autonomy: 'safe' | 'auto' }) =>
      development('assign', sessionId, input),
    assignment: (sessionId: string) => development('assignment', sessionId),
    listFiles: (sessionId: string, folder: string) => development('files-list', sessionId, folder),
    readFile: (sessionId: string, path: string) => development('files-read', sessionId, path),
    writeFile: (sessionId: string, path: string, content: string) =>
      development('files-write', sessionId, path, content),
    fileIndex: (sessionId: string) => development('files-index', sessionId),
    searchFiles: (sessionId: string, query: string) =>
      development('files-search', sessionId, query),
    filePath: (sessionId: string, path: string) => development('files-path', sessionId, path),
    revealFile: (sessionId: string, path: string) => development('files-reveal', sessionId, path),
    openFile: (sessionId: string, path: string, target: 'default' | 'vscode') =>
      development('files-open', sessionId, path, target),
    branches: (sessionId: string) => development('branches', sessionId),
    changes: (
      sessionId: string,
      baseBranch: string,
      choice?: { against?: string; commit?: string },
    ) => development('changes', sessionId, baseBranch, choice),
    /** Discards the session's changes against its base branch: one file, or all without a path. */
    revertChanges: (sessionId: string, baseBranch: string, path?: string) =>
      development('revert', sessionId, baseBranch, path ?? ''),
    terminalFolder: (sessionId: string) => development('terminal-folder', sessionId),
    runInTerminal: (sessionId: string, line: string) =>
      development('terminal-run', sessionId, line),
    stopTerminal: (sessionId: string) => development('terminal-stop', sessionId),
    /** Follows the output of every session's terminal; returns what stops following. */
    onTerminalEvent: (listener: (sessionId: string, event: unknown) => void) => {
      const handler = (_event: IpcRendererEvent, sessionId: string, event: unknown) =>
        listener(sessionId, event);
      ipcRenderer.on('adk:dev-terminal', handler);
      return () => ipcRenderer.removeListener('adk:dev-terminal', handler);
    },
  },
});
