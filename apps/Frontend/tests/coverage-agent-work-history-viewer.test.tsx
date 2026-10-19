import { fireEvent, render, within } from '@testing-library/react';
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

const event: AuditHistoryPage['items'][number] = {
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
  before: null,
  after: null,
};

describe('History viewer snapshot summaries', () => {
  it('summarizes snapshots without a usable title and versions without content', async () => {
    const client = new ApiClient();
    vi.spyOn(client, 'getAuditHistory').mockResolvedValue({
      total: 2,
      page: 1,
      totalPages: 1,
      items: [
        // A blank title falls back to the readable content of every field, including empty ones.
        {
          ...event,
          id: 'untitled',
          after: { status: null, title: '   ', priority: 'Alta' },
        },
        // Neither version has content: the summary line stays empty.
        { ...event, id: 'nothing', before: null, after: null },
      ],
    });
    const view = render(
      <HistoryViewer entityId="d" apiClient={client} entityType="document" workspaceId="w" />,
    );
    fireEvent.click(view.getByRole('button', { name: 'Histórico' }));
    const dialog = within(await view.findByRole('dialog'));
    const entries = await dialog.findAllByRole('listitem');
    expect(entries).toHaveLength(2);
    const summary = entries[0]!.querySelector('p.truncate');
    expect(summary).toHaveTextContent('status:');
    expect(entries[1]!.querySelector('p.truncate')!.textContent).toBe('');
    expect(within(entries[1]!).getAllByText('Não existe')).toHaveLength(2);
    fireEvent.click(within(entries[0]!).getByText('Ver alterações'));
    expect(within(entries[0]!).getByText('Alta')).toBeInTheDocument();
  });
});
