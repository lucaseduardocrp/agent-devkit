import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MultiSelectOption } from '../src/components/ui/multi-select.js';
import { RemoteMultiSelect } from '../src/components/ui/remote-multi-select.js';
import type { RemotePage } from '../src/components/ui/remote-select.js';
import { I18nProvider } from '../src/lib/i18n/index.js';

interface Row {
  id: string;
  name: string;
}
const ROWS: Row[] = ['Alpha', 'Beta', 'Gamma', 'Delta'].map((name) => ({
  id: name.toLowerCase(),
  name,
}));
const toOption = (row: Row): MultiSelectOption => ({ value: row.id, label: row.name });

/** A source that searches by name and pages, like the API. */
function source() {
  return vi.fn(
    (
      { q, page, pageSize }: { q: string; page: number; pageSize: number },
      _signal: AbortSignal,
    ): Promise<RemotePage<Row>> => {
      const matches = ROWS.filter((row) => row.name.toLowerCase().includes(q.toLowerCase()));
      return Promise.resolve({
        items: matches.slice((page - 1) * pageSize, page * pageSize),
        total: matches.length,
      });
    },
  );
}

function Harness({
  fetchPage,
  known,
  onChange,
}: {
  fetchPage: ReturnType<typeof source>;
  known?: Map<string, MultiSelectOption>;
  onChange?: (values: string[]) => void;
}) {
  const [values, setValues] = useState<string[]>([]);
  return (
    <I18nProvider>
      <RemoteMultiSelect
        id="items"
        label="Items"
        values={values}
        onChange={(next) => {
          setValues(next);
          onChange?.(next);
        }}
        fetchPage={fetchPage}
        toOption={toOption}
        placeholder="Search items"
        emptyMessage="Nothing found"
        errorMessage="Could not load"
        pageSize={2}
        {...(known ? { known } : {})}
      />
    </I18nProvider>
  );
}

const field = () => screen.getByRole('combobox', { name: 'Items' });
const open = () => fireEvent.focus(field());

describe('RemoteMultiSelect', () => {
  it('loads only the first page and then the next one as the list is scrolled', async () => {
    const fetchPage = source();
    render(<Harness fetchPage={fetchPage} />);
    open();
    expect(await screen.findByRole('option', { name: 'Alpha' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Gamma' })).not.toBeInTheDocument();
    fireEvent.scroll(screen.getByRole('listbox'));
    expect(await screen.findByRole('option', { name: 'Gamma' })).toBeInTheDocument();
    expect(fetchPage).toHaveBeenLastCalledWith(
      { q: '', page: 2, pageSize: 2 },
      expect.any(AbortSignal),
    );
    // Everything is held: scrolling again asks for nothing more.
    const calls = fetchPage.mock.calls.length;
    fireEvent.scroll(screen.getByRole('listbox'));
    expect(fetchPage.mock.calls.length).toBe(calls);
  });

  it('searches in the source, once per pause in typing', async () => {
    const fetchPage = source();
    render(<Harness fetchPage={fetchPage} />);
    open();
    await screen.findByRole('option', { name: 'Alpha' });
    fireEvent.change(field(), { target: { value: 'g' } });
    fireEvent.change(field(), { target: { value: ' gam ' } });
    await waitFor(() =>
      expect(fetchPage).toHaveBeenLastCalledWith(
        { q: 'gam', page: 1, pageSize: 2 },
        expect.any(AbortSignal),
      ),
    );
    expect(fetchPage.mock.calls.filter(([request]) => request.q === 'g')).toHaveLength(0);
    expect(await screen.findByRole('option', { name: 'Gamma' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Alpha' })).not.toBeInTheDocument();
    fireEvent.change(field(), { target: { value: 'zzz' } });
    expect(await screen.findByText('Nothing found')).toBeInTheDocument();
  });

  it('keeps the name of what was picked when a new search no longer lists it', async () => {
    const onChange = vi.fn();
    render(<Harness fetchPage={source()} onChange={onChange} />);
    open();
    fireEvent.change(field(), { target: { value: 'bet' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Beta' }));
    expect(onChange).toHaveBeenLastCalledWith(['beta']);
    // Picking clears the search, so the first page (without Beta) comes back.
    await screen.findByRole('option', { name: 'Alpha' });
    expect(screen.getByRole('button', { name: /Beta/ })).toBeInTheDocument();
  });

  it('keeps the names in the parent store, so they outlive the field', async () => {
    const known = new Map<string, MultiSelectOption>();
    const first = render(<Harness fetchPage={source()} known={known} />);
    open();
    await screen.findByRole('option', { name: 'Alpha' });
    expect(known.get('alpha')).toEqual({ value: 'alpha', label: 'Alpha' });
    first.unmount();
  });

  it('shows the error message when the source fails, and recovers on the next search', async () => {
    const fetchPage = source();
    fetchPage.mockRejectedValueOnce(new Error('down'));
    render(<Harness fetchPage={fetchPage} />);
    open();
    expect(await screen.findByText('Could not load')).toBeInTheDocument();
    fireEvent.change(field(), { target: { value: 'alp' } });
    expect(await screen.findByRole('option', { name: 'Alpha' })).toBeInTheDocument();
    expect(screen.queryByText('Could not load')).not.toBeInTheDocument();
  });

  it('keeps what it had when a later page fails', async () => {
    const fetchPage = source();
    render(<Harness fetchPage={fetchPage} />);
    open();
    await screen.findByRole('option', { name: 'Alpha' });
    fetchPage.mockRejectedValueOnce(new Error('down'));
    fireEvent.scroll(screen.getByRole('listbox'));
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('option', { name: 'Alpha' })).toBeInTheDocument();
  });

  it('keeps pages that overlap from repeating an option, and ignores a late answer', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [ROWS[0], ROWS[1]], total: 3 })
      .mockResolvedValueOnce({ items: [ROWS[1], ROWS[2]], total: 3 });
    const { unmount } = render(
      <Harness fetchPage={fetchPage as unknown as ReturnType<typeof source>} />,
    );
    open();
    await screen.findByRole('option', { name: 'Alpha' });
    fireEvent.scroll(screen.getByRole('listbox'));
    await screen.findByRole('option', { name: 'Gamma' });
    expect(screen.getAllByRole('option', { name: 'Beta' })).toHaveLength(1);
    unmount();

    // Leaving while a request is in flight, and an older answer arriving after a newer one.
    let release: (page: RemotePage<Row>) => void = () => undefined;
    const slow = new Promise<RemotePage<Row>>((resolve) => (release = resolve));
    const racing = vi
      .fn()
      .mockReturnValueOnce(slow)
      .mockResolvedValue({ items: [ROWS[2]], total: 1 });
    const second = render(<Harness fetchPage={racing as unknown as ReturnType<typeof source>} />);
    open();
    fireEvent.change(field(), { target: { value: 'gam' } });
    expect(await screen.findByRole('option', { name: 'Gamma' })).toBeInTheDocument();
    release({ items: [ROWS[0]!], total: 1 });
    await Promise.resolve();
    expect(screen.queryByRole('option', { name: 'Alpha' })).not.toBeInTheDocument();
    second.unmount();
  });
});
