import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MultiSelect } from '../src/components/ui/multi-select.js';
import {
  SearchableSelect,
  type SearchableSelectOption,
} from '../src/components/ui/searchable-select.js';
import { I18nProvider } from '../src/lib/i18n/index.js';

const items = (count: number): SearchableSelectOption[] =>
  Array.from({ length: count }, (_, index) => ({
    value: `v${index + 1}`,
    label: `Item ${index + 1}`,
  }));

const shown = (name: string) =>
  within(screen.getByRole('listbox', { name })).queryAllByRole('option');

/** jsdom has no layout: say the list is scrolled to within 64px of its end. */
const scrollToEnd = (name: string) => {
  const list = screen.getByRole('listbox', { name });
  Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(list, 'clientHeight', { value: 200, configurable: true });
  Object.defineProperty(list, 'scrollTop', { value: 760, configurable: true, writable: true });
  fireEvent.scroll(list);
};

type Extra = Partial<React.ComponentProps<typeof SearchableSelect>>;

function Single({ count = 120, ...extra }: { count?: number } & Extra) {
  const [value, setValue] = useState('');
  return (
    <SearchableSelect
      label="Pick"
      placeholder="Pick one"
      emptyMessage="Nothing"
      options={items(count)}
      value={value}
      onChange={setValue}
      {...extra}
    />
  );
}

const open = () => fireEvent.focus(screen.getByRole('combobox', { name: 'Pick' }));

describe('SearchableSelect infinite scroll', () => {
  it('draws only the first page and adds a page each time the list is scrolled to its end', () => {
    render(<Single />);
    open();
    expect(shown('Pick')).toHaveLength(50);
    scrollToEnd('Pick');
    expect(shown('Pick')).toHaveLength(100);
    scrollToEnd('Pick');
    expect(shown('Pick')).toHaveLength(120);
    scrollToEnd('Pick');
    expect(shown('Pick')).toHaveLength(120);
  });

  it('does not load while the user is far from the end', () => {
    render(<Single />);
    open();
    const list = screen.getByRole('listbox', { name: 'Pick' });
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 200, configurable: true });
    Object.defineProperty(list, 'scrollTop', { value: 100, configurable: true });
    fireEvent.scroll(list);
    expect(shown('Pick')).toHaveLength(50);
  });

  it('honours the page size', () => {
    render(<Single pageSize={10} />);
    open();
    expect(shown('Pick')).toHaveLength(10);
    scrollToEnd('Pick');
    expect(shown('Pick')).toHaveLength(20);
  });

  it('goes back to the first page when the search changes', () => {
    render(<Single />);
    open();
    scrollToEnd('Pick');
    expect(shown('Pick')).toHaveLength(100);
    fireEvent.change(screen.getByRole('combobox', { name: 'Pick' }), {
      target: { value: 'Item 1' },
    });
    // "Item 1", 10-19 and 100-120 match: 32 options, all on the first page.
    expect(shown('Pick')).toHaveLength(32);
    fireEvent.change(screen.getByRole('combobox', { name: 'Pick' }), { target: { value: 'item' } });
    expect(shown('Pick')).toHaveLength(50);
  });

  it('brings the next page in before the keyboard reaches the end of the page', () => {
    render(<Single />);
    open();
    const field = screen.getByRole('combobox', { name: 'Pick' });
    for (let press = 0; press < 48; press += 1) fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(shown('Pick')).toHaveLength(100);
  });

  it('asks for more only once the options it holds are all shown, once per page held', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<Single count={60} hasMore onLoadMore={onLoadMore} />);
    open();
    scrollToEnd('Pick');
    expect(shown('Pick')).toHaveLength(60);
    expect(onLoadMore).not.toHaveBeenCalled();
    scrollToEnd('Pick');
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    scrollToEnd('Pick');
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    // The parent answers with the next page, and the end asks again.
    rerender(<Single count={120} hasMore onLoadMore={onLoadMore} />);
    scrollToEnd('Pick');
    expect(shown('Pick')).toHaveLength(120);
    scrollToEnd('Pick');
    expect(onLoadMore).toHaveBeenCalledTimes(2);
  });

  it('never asks for more without a next page, or while one is loading', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<Single count={10} onLoadMore={onLoadMore} />);
    open();
    scrollToEnd('Pick');
    expect(onLoadMore).not.toHaveBeenCalled();
    rerender(<Single count={10} hasMore loadingMore onLoadMore={onLoadMore} />);
    scrollToEnd('Pick');
    expect(onLoadMore).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('Loading…');
  });

  it('shows a loading row, with its own text, while the first page of a source arrives', () => {
    render(<Single count={0} hasMore loadingMore loadingMessage="Fetching…" />);
    open();
    expect(screen.getByRole('status')).toHaveTextContent('Fetching…');
    expect(screen.queryByText('Nothing')).not.toBeInTheDocument();
  });

  it('asks an empty source for its first page', () => {
    const onLoadMore = vi.fn();
    render(<Single count={0} hasMore onLoadMore={onLoadMore} />);
    open();
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('tells a source what is typed and shows what it sends without filtering again', () => {
    const onQueryChange = vi.fn();
    render(<Single count={5} localFilter={false} onQueryChange={onQueryChange} />);
    open();
    fireEvent.change(screen.getByRole('combobox', { name: 'Pick' }), { target: { value: 'zzz' } });
    expect(onQueryChange).toHaveBeenCalledWith('zzz');
    // The source decides what matches: nothing is hidden locally.
    expect(shown('Pick')).toHaveLength(5);
  });

  it('keeps picking working on a later page', () => {
    const onChange = vi.fn();
    render(<Single onChange={onChange} />);
    open();
    scrollToEnd('Pick');
    fireEvent.click(screen.getByRole('option', { name: 'Item 99' }));
    expect(onChange).toHaveBeenCalledWith('v99');
  });
});

function Multi({
  count = 120,
  ...extra
}: { count?: number } & Partial<Parameters<typeof MultiSelect>[0]>) {
  const [values, setValues] = useState<string[]>([]);
  return (
    <I18nProvider initialLocale="en-US">
      <MultiSelect
        label="Many"
        placeholder="Pick"
        emptyMessage="Nothing"
        options={items(count)}
        values={values}
        onChange={setValues}
        {...extra}
      />
    </I18nProvider>
  );
}

describe('MultiSelect infinite scroll', () => {
  it('loads pages as the list is scrolled, and keeps what was picked on any of them', () => {
    render(<Multi />);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Many' }));
    expect(shown('Many')).toHaveLength(50);
    scrollToEnd('Many');
    expect(shown('Many')).toHaveLength(100);
    fireEvent.click(screen.getByRole('option', { name: /Item 99/ }));
    expect(screen.getByText('Item 99', { selector: 'span[title]' })).toBeInTheDocument();
  });

  it('asks the source for more once everything it holds is shown, and shows the loading row', () => {
    const onLoadMore = vi.fn();
    const { rerender } = render(<Multi count={20} hasMore onLoadMore={onLoadMore} />);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Many' }));
    scrollToEnd('Many');
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    scrollToEnd('Many');
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    rerender(
      <Multi count={20} hasMore loadingMore onLoadMore={onLoadMore} loadingMessage="More…" />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('More…');
  });

  it('goes back to the first page on a new search', () => {
    render(<Multi />);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Many' }));
    scrollToEnd('Many');
    fireEvent.change(screen.getByRole('combobox', { name: 'Many' }), { target: { value: 'item' } });
    expect(shown('Many')).toHaveLength(50);
  });
});
