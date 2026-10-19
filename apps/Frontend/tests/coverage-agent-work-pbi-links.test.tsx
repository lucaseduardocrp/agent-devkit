import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../src/lib/api-client.js';
import { PbiLinks } from '../src/features/pbi/PbiLinks.js';
import type { PbiItem, PbiRelation } from '../src/features/pbi/pbi-types.js';

const item: PbiItem = {
  id: 'item-1',
  workspaceId: 'ws',
  parentId: null,
  kind: 'pbi',
  title: 'Origem',
  description: '',
  status: 'Active',
  position: 1,
  sourceData: {},
  links: [],
  createdAt: '2026-10-07T00:00:00.000Z',
  updatedAt: '2026-10-07T00:00:00.000Z',
};
const many: PbiItem[] = Array.from({ length: 25 }, (_, index) => ({
  ...item,
  id: `card-${index}`,
  title: `Cartão ${index}`,
}));
const summary = (entry: PbiItem): NonNullable<PbiRelation['item']> => ({
  id: entry.id,
  title: entry.title,
  kind: entry.kind,
  status: entry.status,
  type: 'Task',
  links: [],
});

describe('PbiLinks edge cases', () => {
  it('limits search results, keeps selections of items that left the board and removes children', async () => {
    const child = many[0]!;
    const api = {
      getPbiRelations: vi.fn().mockResolvedValue([
        { type: 'child', origin: 'adk', item: summary(child) },
        { type: 'related', origin: 'linear', item: null, externalId: 'LIN-7' },
      ]),
      removePbiRelation: vi.fn().mockResolvedValue([]),
    };
    const onChanged = vi.fn().mockResolvedValue(undefined);
    const props = {
      apiClient: api as unknown as ApiClient,
      item,
      onOpenItem: vi.fn(),
      onChanged,
    };
    const view = render(<PbiLinks {...props} items={[item, ...many]} />);
    const section = screen.getByRole('region', { name: 'Links' });
    expect(await within(section).findByText('Filho (1)')).toBeInTheDocument();
    // Providers without a known display name show their identifier.
    const origin = within(section).getByText('linear');
    expect(origin).toHaveAttribute('title', 'Lido de linear');

    fireEvent.click(within(section).getByRole('button', { name: /Adicionar link/ }));
    fireEvent.click(within(section).getByRole('menuitem', { name: 'Item existente' }));
    const form = within(section).getByRole('form', { name: 'Item existente' });
    fireEvent.change(within(form).getByRole('textbox', { name: 'Buscar itens por ID ou título' }), {
      target: { value: 'cartao' },
    });
    const options = within(within(form).getByRole('listbox')).getAllByRole('option');
    expect(options).toHaveLength(20);
    fireEvent.click(within(options[3]!).getByRole('button'));
    expect(
      within(form).getByRole('button', { name: 'Remover seleção: Cartão 3' }),
    ).toBeInTheDocument();

    // The selected item disappears from the board: the selection falls back to its ID.
    view.rerender(<PbiLinks {...props} items={[item]} />);
    const fallback = within(form).getByRole('button', { name: 'Remover seleção: card-3' });
    expect(within(form).getByText('card-3')).toBeInTheDocument();
    fireEvent.click(fallback);
    expect(within(form).queryByText('card-3')).not.toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Cancelar' }));

    fireEvent.click(within(section).getByRole('button', { name: 'Remover link: Cartão 0' }));
    await waitFor(() =>
      expect(api.removePbiRelation).toHaveBeenCalledWith('item-1', 'child', 'card-0'),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(await within(section).findByText('Nenhum link neste item.')).toBeInTheDocument();
  });
});
