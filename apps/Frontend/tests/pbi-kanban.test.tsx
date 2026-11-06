import { createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api-client.js';
import { PbiView } from '../src/features/pbi/PbiView.js';
import type { PbiItem } from '../src/features/pbi/pbi-types.js';

const base: PbiItem = {
  id: 'root',
  workspaceId: 'ws',
  parentId: null,
  kind: 'pbi',
  title: 'Release PBI',
  description: '',
  status: 'New',
  position: 1,
  sourceData: {},
  links: [],
  createdAt: '2026-09-30T00:00:00.000Z',
  updatedAt: '2026-09-30T00:00:00.000Z',
};
const item = (patch: Partial<PbiItem>): PbiItem => ({ ...base, ...patch });
const items = [
  base,
  item({ id: 'late', title: 'Late card', position: 9 }),
  item({ id: 'd1', title: 'Done first', status: 'Done', position: 0 }),
  item({ id: 'd2', title: 'Done tie', status: 'Done', position: 1 }),
  item({ id: 'd3', title: 'Done last', status: 'Done', position: 5 }),
  item({
    id: 'owned',
    title: 'Owned card',
    status: 'Active',
    position: 2,
    sourceData: { adkAssigneeUserId: 'user-1' },
  }),
  ...Array.from({ length: 41 }, (_, index) =>
    item({ id: `bulk-${index}`, title: `Bulk ${index}`, status: 'Closed', position: index }),
  ),
];

function mockClient() {
  return {
    getPbiItems: vi.fn().mockResolvedValue(items),
    getPbiProviders: vi.fn().mockResolvedValue([]),
    getPbiCurrentIteration: vi.fn().mockResolvedValue(null),
    getAgents: vi.fn().mockResolvedValue([]),
    getWorkspaceMembers: vi.fn().mockResolvedValue([
      {
        id: 'm1',
        workspaceId: 'ws',
        userId: 'user-1',
        role: 'MEMBER',
        permissions: {},
        createdAt: '',
        user: { id: 'user-1', name: 'Ana Souza', email: 'ana@example.test' },
      },
    ]),
    getWorkItemTypes: vi.fn().mockResolvedValue([]),
    updatePbiItem: vi.fn().mockResolvedValue(base),
    getPbiContext: vi.fn().mockResolvedValue({ item: base, descendants: [] }),
    getPbiComments: vi.fn().mockResolvedValue([]),
    getPbiRelations: vi.fn().mockResolvedValue([]),
  };
}

function setup() {
  localStorage.setItem('adk:pbi-view:ws', 'kanban');
  const api = mockClient();
  render(<PbiView apiClient={api as unknown as ApiClient} workspaceId="ws" />);
  return api;
}

const store = new Map<string, string>();
const dataTransfer = {
  setData: (type: string, value: string) => store.set(type, value),
  getData: (type: string) => store.get(type) ?? '',
};
const column = (name: string) => screen.getByRole('region', { name });
const cardOf = (title: string) => screen.getByText(title).closest('[draggable]') as HTMLElement;
const titles = (name: string) =>
  within(column(name))
    .getAllByRole('button')
    .map((button) => button.textContent);
const slots = (name: string) =>
  Array.from(column(name).querySelectorAll('article,[data-testid="kanban-drop-placeholder"]'));

beforeEach(() => {
  localStorage.clear();
  store.clear();
});

describe('PbiView Kanban cards', () => {
  it('shows the assignee, opens a card and pages long columns', async () => {
    const api = setup();
    await screen.findByText('Owned card');
    expect(within(column('Active')).getByText('Ana Souza')).toBeInTheDocument();
    expect(within(column('Closed')).getAllByRole('article')).toHaveLength(40);
    fireEvent.click(screen.getByRole('button', { name: 'Mostrar mais (1)' }));
    expect(within(column('Closed')).getAllByRole('article')).toHaveLength(41);
    expect(screen.queryByRole('button', { name: /Mostrar mais/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Owned card' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(api.getPbiItems).toHaveBeenCalled();
  });
});

describe('PbiView Kanban drag and drop', () => {
  it('shows where the card will land according to its position in the column', async () => {
    setup();
    await screen.findByText('Late card');
    const placeholder = () => screen.queryByTestId('kanban-drop-placeholder');

    // The landing slot repeats the title of the card, so keep the card elements.
    const release = cardOf('Release PBI');
    const late = cardOf('Late card');
    fireEvent.dragStart(release, { dataTransfer });
    fireEvent.dragOver(column('New'), { dataTransfer });
    expect(placeholder()).not.toBeInTheDocument();
    fireEvent.dragOver(column('Done'), { dataTransfer });
    // Position 1 lands after "Done first" and "Done tie" (same position, earlier title).
    expect(
      slots('Done').findIndex(
        (node) => node.getAttribute('data-testid') === 'kanban-drop-placeholder',
      ),
    ).toBe(2);
    expect(placeholder()).toHaveTextContent('Mover para Done');
    const inside = createEvent.dragLeave(column('Done'));
    Object.defineProperty(inside, 'relatedTarget', { value: screen.getByText('Done first') });
    fireEvent(column('Done'), inside);
    expect(placeholder()).toBeInTheDocument();
    fireEvent.dragLeave(column('Done'));
    expect(placeholder()).not.toBeInTheDocument();
    fireEvent.dragEnd(release);

    // A card after every item of the column lands at the end.
    fireEvent.dragStart(late, { dataTransfer });
    fireEvent.dragOver(column('Done'), { dataTransfer });
    expect(slots('Done').at(-1)).toHaveAttribute('data-testid', 'kanban-drop-placeholder');
    fireEvent.dragEnd(late);
    expect(placeholder()).not.toBeInTheDocument();
  });

  it('keeps moves as a draft, sends them together and lets the user discard them', async () => {
    const api = setup();
    await screen.findByText('Late card');
    fireEvent.dragStart(cardOf('Release PBI'), { dataTransfer });
    fireEvent.drop(column('Done'), { dataTransfer });
    fireEvent.dragStart(cardOf('Late card'), { dataTransfer });
    fireEvent.drop(column('Done'), { dataTransfer });
    expect(api.updatePbiItem).not.toHaveBeenCalled();
    expect(screen.getAllByTestId('kanban-card-pending')).toHaveLength(2);
    expect(screen.getByTestId('kanban-draft-bar')).toHaveTextContent('2 movimento(s) pendente(s)');
    expect(titles('Done')).toContain('Release PBI');

    fireEvent.click(screen.getByRole('button', { name: 'Descartar' }));
    expect(screen.queryByTestId('kanban-draft-bar')).not.toBeInTheDocument();
    expect(titles('Done')).not.toContain('Release PBI');

    fireEvent.dragStart(cardOf('Release PBI'), { dataTransfer });
    fireEvent.drop(column('Done'), { dataTransfer });
    fireEvent.dragStart(cardOf('Late card'), { dataTransfer });
    fireEvent.drop(column('Done'), { dataTransfer });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar agora' }));
    await waitFor(() => expect(api.updatePbiItem).toHaveBeenCalledTimes(2));
    expect(api.updatePbiItem).toHaveBeenCalledWith('root', { status: 'Done' });
    expect(api.updatePbiItem).toHaveBeenCalledWith('late', { status: 'Done' });
    await waitFor(() => expect(screen.queryByTestId('kanban-draft-bar')).not.toBeInTheDocument());
    expect(titles('Done')).toContain('Release PBI');
  });

  it('ignores drops of unknown cards or onto the column the card is in', async () => {
    const api = setup();
    await screen.findByText('Late card');
    fireEvent.drop(column('Done'), { dataTransfer });
    store.set('text/plain', 'missing');
    fireEvent.drop(column('Done'), { dataTransfer });
    fireEvent.dragStart(cardOf('Release PBI'), { dataTransfer });
    fireEvent.drop(column('New'), { dataTransfer });
    expect(screen.queryByTestId('kanban-draft-bar')).not.toBeInTheDocument();
    expect(api.updatePbiItem).not.toHaveBeenCalled();
  });

  it('keeps a failed move in the draft and shows why', async () => {
    const api = setup();
    api.updatePbiItem.mockRejectedValueOnce(new Error('Sem permissão'));
    await screen.findByText('Late card');
    fireEvent.dragStart(cardOf('Late card'), { dataTransfer });
    fireEvent.drop(column('Done'), { dataTransfer });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar agora' }));
    expect(await screen.findByText(/Não foi possível salvar: Sem permissão/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() => expect(api.updatePbiItem).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId('kanban-draft-bar')).not.toBeInTheDocument());
  });
});
