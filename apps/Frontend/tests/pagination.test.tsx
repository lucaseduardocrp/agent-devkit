import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Pagination,
  PagingSentinel,
  pageWindow,
  usePaging,
} from '../src/components/ui/pagination.js';

function List({ total, filter = '' }: { total: number; filter?: string }) {
  const items = Array.from({ length: total }, (_, index) => `Item ${index + 1}`);
  const paging = usePaging(items.length, { storageKey: 'test-paging', resetKey: filter });
  return (
    <div>
      <ul>
        {items.slice(paging.start, paging.end).map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <PagingSentinel paging={paging} />
      <Pagination paging={paging} perPageLabel="Itens por página" />
    </div>
  );
}

const shown = () => screen.queryAllByRole('listitem').map((item) => item.textContent);

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe('pageWindow', () => {
  it('keeps the first, last and neighbouring pages, filling single gaps', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(1, 4)).toEqual([1, 2, 3, 4]);
    expect(pageWindow(5, 10)).toEqual([1, null, 4, 5, 6, null, 10]);
    expect(pageWindow(3, 10)).toEqual([1, 2, 3, 4, null, 10]);
  });
});

describe('Pagination', () => {
  it('navigates pages by number, neighbours and ends, and returns to page 1 on a filter change', () => {
    const view = render(<List total={130} />);
    expect(shown()).toHaveLength(25);
    expect(screen.getByText(/Exibindo 1–25 de 130/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Primeira página' })).toHaveProperty(
      'disabled',
      true,
    );
    // Page 1 of 6 offers 1, 2 … 6; the neighbours follow the current page.
    expect(screen.queryByRole('button', { name: 'Ir para a página 3' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ir para a página 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ir para a página 3' }));
    expect(shown()[0]).toBe('Item 51');
    expect(screen.getByRole('button', { name: 'Ir para a página 3' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByText('Página 3 de 6')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Última página' }));
    expect(shown()).toEqual(['Item 126', 'Item 127', 'Item 128', 'Item 129', 'Item 130']);
    expect(screen.getByRole('button', { name: 'Próxima página' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'Página anterior' }));
    expect(shown()[0]).toBe('Item 101');
    view.rerender(<List total={130} filter="search" />);
    expect(shown()[0]).toBe('Item 1');
  });

  it('loads batches while scrolling and remembers the mode and page size', () => {
    let notify: (entries: { isIntersecting: boolean }[]) => void = () => undefined;
    const observe = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: typeof notify) {
          notify = callback;
        }
        observe = observe;
        disconnect = vi.fn();
      },
    );
    const view = render(<List total={60} />);
    fireEvent.click(screen.getByRole('button', { name: /Rolagem contínua/ }));
    expect(screen.getByRole('button', { name: /Rolagem contínua/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByRole('navigation', { name: 'Paginação' })).toBeNull();
    expect(shown()).toHaveLength(25);
    act(() => notify([{ isIntersecting: true }]));
    expect(shown()).toHaveLength(50);
    act(() => notify([{ isIntersecting: false }]));
    expect(shown()).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: /Carregar mais/ }));
    expect(shown()).toHaveLength(60);
    expect(screen.getByText('Todos os itens foram exibidos.')).toBeInTheDocument();
    expect(observe).toHaveBeenCalled();

    fireEvent.change(screen.getByRole('combobox', { name: 'Itens por página' }), {
      target: { value: '50' },
    });
    expect(shown()).toHaveLength(50);
    view.unmount();
    // The choice survives a reload of the list.
    render(<List total={60} />);
    expect(shown()).toHaveLength(50);
    expect(screen.getByRole('button', { name: /Carregar mais/ })).toBeInTheDocument();
  });

  it('ignores unreadable saved preferences', () => {
    localStorage.setItem('test-paging', '{broken');
    render(<List total={30} />);
    expect(shown()).toHaveLength(25);
    localStorage.setItem('test-paging', JSON.stringify({ mode: 'other', pageSize: 7 }));
    render(<List total={30} />);
    expect(screen.getAllByText(/Exibindo 1–25 de 30/)).toHaveLength(2);
  });

  it('shows an empty range without a sentinel', () => {
    localStorage.setItem('test-paging', JSON.stringify({ mode: 'scroll', pageSize: 25 }));
    render(<List total={0} />);
    expect(screen.getByText(/Exibindo 0–0 de 0/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Carregar mais/ })).toBeNull();
  });
});
