import { act, fireEvent, render, waitFor, within } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { HistoryViewer } from '../src/features/audit/HistoryViewer.js';
import { ApiClient, type AuditHistoryPage } from '../src/lib/api-client.js';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
});
const result: AuditHistoryPage = {
  total: 21,
  page: 1,
  totalPages: 2,
  items: [
    {
      id: 'event',
      entityType: 'document',
      entityId: 'd',
      action: 'update',
      actorId: 'alice',
      actorName: 'Alice Silva',
      actorEmail: 'alice@example.com',
      requestId: 'r',
      operation: 'PUT /knowledge',
      occurredAt: '2026-09-16T12:00:00Z',
      before: {
        title: 'Old',
        content: '<script>evil()</script>',
        sections: [{ id: 'section', title: 'Scope', content: 'Requirement' }],
      },
      after: { title: 'New', content: 'Edited', enabled: true, count: 2, unknown: null, empty: [] },
    },
  ],
};
describe('History viewer', () => {
  it('identifies documents and templates by their content/title and handles empty snapshots', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getAuditHistory').mockResolvedValue({
      ...result,
      items: [
        {
          ...result.items[0]!,
          id: 'doc',
          before: null,
          after: { pageId: 'internal-id', content: '# Document heading\nBody' },
        },
        {
          ...result.items[0]!,
          id: 'template',
          before: null,
          after: { title: '', name: 'Template name' },
        },
        { ...result.items[0]!, id: 'empty', before: null, after: {} },
        { ...result.items[0]!, id: 'array', before: null, after: ['First line', 'Second line'] },
        { ...result.items[0]!, id: 'blank', before: null, after: '' },
      ],
    });
    const view = render(
      <HistoryViewer
        entityId="selected-id"
        apiClient={client}
        entityType="document"
        workspaceId="w"
      />,
    );
    fireEvent.click(view.getByRole('button', { name: 'Histórico' }));
    expect(await view.findByText('Document heading')).toBeInTheDocument();
    expect(view.getByText('Template name', { selector: 'p' })).toBeInTheDocument();
    expect(view.getByText('First line', { selector: 'p' })).toBeInTheDocument();
  });
  it('loads on demand, shows versions safely, paginates, refreshes and closes', async () => {
    const client = new ApiClient();
    const load = vi.spyOn(client, 'getAuditHistory').mockResolvedValue(result);
    const view = render(
      <HistoryViewer
        entityId="selected-id"
        apiClient={client}
        entityType="document"
        workspaceId="w"
      />,
    );
    expect(load).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Histórico' }));
    expect(await view.findByText('Alice Silva (alice@example.com)')).toBeInTheDocument();
    const dialog = within(view.getByRole('dialog'));
    fireEvent.click(dialog.getByText('Ver alterações'));
    expect(dialog.getByText(/<script>evil/)).toBeInTheDocument();
    expect(view.container.querySelector('script')).toBeNull();
    fireEvent.click(dialog.getByRole('button', { name: 'Próxima' }));
    await waitFor(() =>
      expect(load).toHaveBeenLastCalledWith('document', 2, expect.any(AbortSignal), 'selected-id'),
    );
    await view.findByText('Alice Silva (alice@example.com)');
    fireEvent.click(dialog.getByRole('button', { name: 'Anterior' }));
    await waitFor(() =>
      expect(load).toHaveBeenLastCalledWith('document', 1, expect.any(AbortSignal), 'selected-id'),
    );
    fireEvent.click(dialog.getByRole('button', { name: 'Atualizar' }));
    await waitFor(() => expect(load).toHaveBeenCalledTimes(4));
    fireEvent.click(dialog.getByRole('button', { name: 'Fechar' }));
    expect(view.queryByRole('dialog')).toBeNull();
  });
  it('handles loading, errors, retry, empty results, templates and native dismissal', async () => {
    const client = new ApiClient();
    const load = vi
      .spyOn(client, 'getAuditHistory')
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ items: [], total: 0, page: 1, totalPages: 0 });
    const view = render(
      <HistoryViewer
        entityId="selected-id"
        apiClient={client}
        entityType="specification"
        workspaceId="w"
      />,
    );
    fireEvent.click(view.getByRole('button', { name: 'Histórico' }));
    expect(view.getByRole('status')).toBeInTheDocument();
    expect(await view.findByRole('alert')).toHaveTextContent('Não foi possível carregar');
    fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
    expect(await view.findByText('Nenhuma alteração registrada.')).toBeInTheDocument();
    expect(load).toHaveBeenLastCalledWith(
      'specification',
      1,
      expect.any(AbortSignal),
      'selected-id',
    );
    expect(view.queryByRole('combobox')).toBeNull();
    fireEvent(view.getByRole('dialog'), new Event('cancel'));
    expect(view.queryByRole('dialog')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Histórico' }));
    fireEvent(view.getByRole('dialog'), new Event('close'));
    expect(view.queryByRole('dialog')).toBeNull();
  });
  it('discards stale responses after workspace changes and shows deleted versions', async () => {
    const client = new ApiClient();
    let finish!: (page: AuditHistoryPage) => void;
    const load = vi
      .spyOn(client, 'getAuditHistory')
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({
        ...result,
        items: [
          {
            ...result.items[0]!,
            actorId: null,
            actorName: null,
            actorEmail: null,
            action: 'delete',
            before: 'Deleted text',
            after: null,
          },
        ],
      });
    const view = render(
      <HistoryViewer
        entityId="selected-id"
        apiClient={client}
        entityType="testplan"
        workspaceId="w"
      />,
    );
    fireEvent.click(view.getByRole('button', { name: 'Histórico' }));
    view.rerender(
      <HistoryViewer
        entityId="selected-id"
        apiClient={client}
        entityType="testplan"
        workspaceId="other"
      />,
    );
    await act(async () => finish(result));
    expect(view.queryByText('alice')).toBeNull();
    expect(load.mock.calls[0]![2]!.aborted).toBe(true);
    fireEvent.click(view.getByRole('button', { name: 'Histórico' }));
    expect(await view.findByText('Sistema')).toBeInTheDocument();
    expect(view.getByText('Não existe')).toBeInTheDocument();
  });
  it('uses authenticated API requests, handles empty responses and errors', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(result)))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response('{}', { status: 403 }));
    const client = new ApiClient({ fetcher });
    expect(
      await client.getAuditHistory('document', 2, undefined, '["app://local?title=A&B","doc-1"]'),
    ).toEqual(result);
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.get('entityId')).toBe('["app://local?title=A&B","doc-1"]');
    expect(String(fetcher.mock.calls[0]![0])).toContain('entityType=document&page=2&pageSize=20');
    expect((await client.getAuditHistory('template')).items).toEqual([]);
    await expect(client.getAuditHistory('testplan')).rejects.toBeDefined();
  });
});
