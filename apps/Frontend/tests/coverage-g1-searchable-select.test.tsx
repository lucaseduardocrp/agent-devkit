import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SearchableSelect } from '../src/components/ui/searchable-select.js';

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta', className: 'text-red-500' },
  { value: 'c', label: 'Gamma' },
];

function Pick({
  value = '',
  onChange = vi.fn(),
  ...rest
}: {
  value?: string;
  onChange?: (value: string) => void;
} & Partial<React.ComponentProps<typeof SearchableSelect>>) {
  return (
    <div>
      <SearchableSelect
        options={options}
        value={value}
        onChange={onChange}
        label="Letra"
        placeholder="Escolha"
        emptyMessage="Nada"
        {...rest}
      />
      <button type="button">outside</button>
    </div>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SearchableSelect as a plain picker (searchable=false)', () => {
  it('opens from the button, picks an option and shows the picked label with its class', () => {
    const onChange = vi.fn();
    const view = render(<Pick searchable={false} onChange={onChange} />);
    const field = screen.getByRole('combobox', { name: 'Letra' });
    expect(field).toHaveTextContent('Escolha');
    fireEvent.click(field);
    expect(screen.getByRole('listbox', { name: 'Letra' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Beta' }));
    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('listbox')).toBeNull();

    view.rerender(<Pick searchable={false} onChange={onChange} value="b" />);
    expect(screen.getByRole('combobox', { name: 'Letra' })).toHaveTextContent('Beta');
    expect(screen.getByRole('combobox', { name: 'Letra' }).className).toContain('text-red-500');
  });

  it('toggles the list with the button and closes it when focus leaves', () => {
    render(<Pick searchable={false} />);
    const field = screen.getByRole('combobox', { name: 'Letra' });
    fireEvent.click(field);
    expect(field).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(field);
    expect(field).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(field);
    const option = screen.getByRole('option', { name: 'Alpha' });
    // Focus moving into the portaled list keeps it open.
    fireEvent.blur(field, { relatedTarget: option });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.blur(field, { relatedTarget: screen.getByRole('button', { name: 'outside' }) });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('is driven from the keyboard', () => {
    const onChange = vi.fn();
    render(<Pick searchable={false} onChange={onChange} value="b" />);
    const field = screen.getByRole('combobox', { name: 'Letra' });

    // Escape while closed does nothing special.
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();

    // Arrow opens at the selected option.
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(field.getAttribute('aria-activedescendant')).toMatch(/-1$/);
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(field.getAttribute('aria-activedescendant')).toMatch(/-2$/);
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    expect(field.getAttribute('aria-activedescendant')).toMatch(/-1$/);
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    expect(field.getAttribute('aria-activedescendant')).toMatch(/-0$/);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(onChange).toHaveBeenLastCalledWith('a');
    expect(screen.queryByRole('listbox')).toBeNull();

    // Space opens, then picks; ArrowUp also opens; Escape closes.
    fireEvent.keyDown(field, { key: ' ' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(field, { key: ' ' });
    expect(onChange).toHaveBeenLastCalledWith('b');
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();

    // Any other key is ignored; Enter on an empty list only opens it.
    fireEvent.keyDown(field, { key: 'x' });
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('does not open while disabled', () => {
    render(<Pick searchable={false} disabled />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Letra' }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('keeps the first option highlighted when the list has none', () => {
    render(<Pick searchable={false} options={[]} />);
    const field = screen.getByRole('combobox', { name: 'Letra' });
    fireEvent.click(field);
    expect(field).not.toHaveAttribute('aria-activedescendant');
    expect(screen.getByText('Nada')).toBeInTheDocument();
  });
});

describe('SearchableSelect placement and extras', () => {
  const rect = (top: number, bottom: number) =>
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top,
      bottom,
      left: 10,
      right: 210,
      width: 200,
      height: bottom - top,
      x: 10,
      y: top,
      toJSON: () => ({}),
    });

  it('opens upward when there is no room below and when asked to', () => {
    rect(700, 730);
    render(<Pick />);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Letra' }));
    const list = screen.getByRole('listbox');
    expect(list.style.bottom).not.toBe('');
    expect(list.style.top).toBe('');
  });

  it('opens downward with room below, and upward when placement is top', () => {
    rect(100, 130);
    const view = render(<Pick />);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Letra' }));
    expect(screen.getByRole('listbox').style.top).toBe('134px');
    view.unmount();

    render(<Pick placement="top" />);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Letra' }));
    expect(screen.getByRole('listbox').style.bottom).not.toBe('');
  });

  it('repositions on page scroll and resize but not when the list itself scrolls', () => {
    rect(100, 130);
    render(<Pick />);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Letra' }));
    const list = screen.getByRole('listbox');
    rect(200, 230);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(list.style.top).toBe('234px');
    rect(300, 330);
    // Scrolling the list itself leaves it where it is.
    fireEvent.scroll(list);
    expect(list.style.top).toBe('234px');
    // Scrolling anything else moves it with the field.
    fireEvent.scroll(document.body);
    expect(list.style.top).toBe('334px');
  });

  it('offers what is typed as a custom option and shows an outside value as typed', () => {
    const onChange = vi.fn();
    const view = render(
      <Pick onChange={onChange} customOptionLabel={(typed) => `Usar "${typed}"`} />,
    );
    const field = screen.getByRole('combobox', { name: 'Letra' });
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'Zeta' } });
    fireEvent.click(screen.getByRole('option', { name: 'Usar "Zeta"' }));
    expect(onChange).toHaveBeenCalledWith('Zeta');

    // An exact match does not add the custom row.
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'alpha' } });
    expect(screen.queryByRole('option', { name: /Usar/ })).toBeNull();

    view.rerender(
      <Pick value="Zeta" onChange={onChange} customOptionLabel={(typed) => `Usar "${typed}"`} />,
    );
    fireEvent.keyDown(field, { key: 'Escape' });
    expect((field as HTMLInputElement).value).toBe('Zeta');
  });

  it('shows the picked label and class in the field and clears the value on typing', () => {
    const onChange = vi.fn();
    render(<Pick value="b" onChange={onChange} />);
    const field = screen.getByRole('combobox', { name: 'Letra' }) as HTMLInputElement;
    expect(field.value).toBe('Beta');
    expect(field.className).toContain('text-red-500');
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'ga' } });
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('ignores a search source that filters by itself and reports what is typed', () => {
    const onQueryChange = vi.fn();
    render(<Pick localFilter={false} onQueryChange={onQueryChange} />);
    const field = screen.getByRole('combobox', { name: 'Letra' });
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: 'zzz' } });
    expect(screen.getAllByRole('option')).toHaveLength(3);
    expect(onQueryChange).toHaveBeenCalledWith('zzz');
  });

  it('fills a list too short to scroll by asking for the next page', () => {
    const clientHeight = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(100);
    const onLoadMore = vi.fn();
    render(<Pick hasMore onLoadMore={onLoadMore} />);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Letra' }));
    expect(onLoadMore).toHaveBeenCalled();
    clientHeight.mockRestore();
  });

  it('shows only the loading row while the first page loads', () => {
    render(<Pick options={[]} loadingMore />);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Letra' }));
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByText('Nada')).toBeNull();
  });
});

describe('SearchableSelect typing field', () => {
  it('moves through the matches with the arrow keys and keeps the highlight in view', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      const onChange = vi.fn();
      render(<Pick onChange={onChange} />);
      const field = screen.getByRole('combobox', { name: 'Letra' });
      fireEvent.focus(field);
      fireEvent.keyDown(field, { key: 'ArrowDown' });
      fireEvent.keyDown(field, { key: 'ArrowDown' });
      fireEvent.keyDown(field, { key: 'ArrowDown' });
      fireEvent.keyDown(field, { key: 'ArrowUp' });
      expect(field.getAttribute('aria-activedescendant')).toMatch(/-1$/);
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(onChange).toHaveBeenCalledWith('b');

      // Closed with Escape, an arrow reopens the list.
      fireEvent.focus(field);
      fireEvent.keyDown(field, { key: 'Escape' });
      expect(screen.queryByRole('listbox')).toBeNull();
      fireEvent.keyDown(field, { key: 'ArrowDown' });
      expect(screen.getByRole('listbox')).toBeInTheDocument();
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('keeps the highlight at the top when there are no options and ignores a disabled field', () => {
    const view = render(<Pick options={[]} />);
    const field = screen.getByRole('combobox', { name: 'Letra' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(field.getAttribute('aria-activedescendant')).toBeNull();
    view.rerender(<Pick options={[]} disabled />);
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Letra' }), { key: 'ArrowDown' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('does not take focus away from the field when an option is pressed', () => {
    render(<Pick />);
    fireEvent.focus(screen.getByRole('combobox', { name: 'Letra' }));
    const notPrevented = fireEvent.mouseDown(screen.getByRole('option', { name: 'Alpha' }));
    expect(notPrevented).toBe(false);
  });
});

describe('SearchableSelect page size', () => {
  it('draws only a page of options at a time', () => {
    render(
      <Pick
        pageSize={3}
        options={[...options, { value: 'd', label: 'Delta' }, { value: 'e', label: 'Epsilon' }]}
      />,
    );
    fireEvent.focus(screen.getByRole('combobox', { name: 'Letra' }));
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });
});
