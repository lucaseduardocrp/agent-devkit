import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { HistoryViewer } from '../src/features/audit/HistoryViewer.js';
import { HealthStatus } from '../src/features/health/HealthStatus.js';
import { MediaImage, MediaProvider } from '../src/features/shared/media.js';
import { WorkspaceMembersModal } from '../src/features/workspaces/WorkspaceMembersModal.js';
import { ApiClient, type AuditHistoryPage, type HealthResponse } from '../src/lib/api-client.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

function deferred<T>() {
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((_done, fail) => {
    reject = fail;
  });
  return { promise, reject };
}

describe('HistoryViewer', () => {
  it('shows no error for a history request that fails after the viewer closed', async () => {
    const client = new ApiClient();
    const page = deferred<AuditHistoryPage>();
    vi.spyOn(client, 'getAuditHistory').mockReturnValue(page.promise);
    const view = render(
      <HistoryViewer entityId="doc-1" apiClient={client} entityType="document" workspaceId="w" />,
    );
    fireEvent.click(view.getByRole('button', { name: 'Histórico' }));
    await waitFor(() => expect(client.getAuditHistory).toHaveBeenCalled());
    view.unmount();
    await act(async () => page.reject(new Error('offline')));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('HealthStatus', () => {
  it('cancels the status request when it is removed and ignores the abort', async () => {
    const client = new ApiClient();
    const health = deferred<HealthResponse>();
    let signal: AbortSignal | undefined;
    vi.spyOn(client, 'getHealth').mockImplementation((value?: AbortSignal) => {
      signal = value;
      return health.promise;
    });
    const view = render(<HealthStatus client={client} />);
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => health.reject(new DOMException('aborted', 'AbortError')));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('MediaImage', () => {
  it('shows the placeholder when the server cannot load a provider image either', async () => {
    const client = new ApiClient({ baseUrl: 'http://api.test' });
    const getMedia = vi.spyOn(client, 'getMedia').mockRejectedValue(new Error('403'));
    render(
      <MediaProvider apiClient={client}>
        <MediaImage src="https://cdn.example.com/private.png" alt="private" />
      </MediaProvider>,
    );
    fireEvent.error(screen.getByRole('img', { name: 'private' }));
    expect(await screen.findByTitle('private')).toHaveTextContent('private');
    expect(getMedia).toHaveBeenCalledWith('https://cdn.example.com/private.png');
  });
});

describe('WorkspaceMembersModal', () => {
  it('does not close on Escape while it is hidden', () => {
    const onClose = vi.fn();
    render(
      <WorkspaceMembersModal
        isOpen={false}
        onClose={onClose}
        workspaceId="ws-1"
        workspaceName="Workspace Test"
        currentUserId="u-1"
        apiClient={new ApiClient()}
        onDeleteWorkspace={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
