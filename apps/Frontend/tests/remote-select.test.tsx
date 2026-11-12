import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RemoteSelect, type RemotePage } from '../src/components/ui/remote-select.js';
import { I18nProvider } from '../src/lib/i18n/index.js';

interface Row {
  id: string;
  name: string;
}
const ROWS: Row[] = ['Alpha', 'Beta', 'Gamma', 'Delta'].map((name) => ({
  id: name.toLowerCase(),
  name,
}));
const toOption = (row: Row) => ({ value: row.id, label: row.name });

/** A source that searches by name and pages, like the API. */
function source(rows: readonly Row[] = ROWS) {
  return vi.fn(
    (
      { q, page, pageSize }: { q: string; page: number; pageSize: number },
      _signal: AbortSignal,
    ): Promise<RemotePage<Row>> => {
      const matches = rows.filter((row) => row.name.toLowerCase().includes(q.toLowerCase()));
      return Promise.resolve({
        items: matches.slice((page - 1) * pageSize, page * pageSize),
        total: matches.length,
      });
    },
  );
}

function Harness({
  fetchPage,
  pageSize = 2,
  onPick,
}: {
  fetchPage: ReturnType<typeof source>;
  pageSize?: number;
  onPick?: (value: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <I18nProvider>
      <RemoteSelect
        label="Item"
        value={value}
        onChange={(next) => {
          setValue(next);
          onPick?.(next);
        }}
        fetchPage={fetchPage}
        toOption={toOption}
        placeholder="Search items"
        emptyMessage="Nothing found"
        errorMessage="Could not load"
        pageSize={pageSize}
      />
      <button type="button" onClick={() => setValue('')}>
        reset
      </button>
    </I18nProvider>
  );
}

const field = () => screen.getByRole('combobox', { name: 'Item' });
const open = () => fireEvent.focus(field());

describe('RemoteSelect', () => {
  it('loads only the first page and picks an option', async () => {
    const fetchPage = source();
    const onPick = vi.fn();
    render(<Harness fetchPage={fetchPage} onPick={onPick} />);
    await waitFor(() =>
      expect(fetchPage).toHaveBeenCalledWith(
        { q: '', page: 1, pageSize: 2 },
        expect.any(AbortSignal),
      ),
    );
    open();
    expect(await screen.findByRole('option', { name: 'Alpha' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Gamma' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Beta' }));
    expect(onPick).toHaveBeenCalledWith('beta');
    expect((field() as HTMLInputElement).value).toBe('Beta');
  });

  it('asks the source for the next page when the list is scrolled to its end', async () => {
    const fetchPage = source();
    render(<Harness fetchPage={fetchPage} />);
    open();
    await screen.findByRole('option', { name: 'Alpha' });
    fireEvent.scroll(screen.getByRole('listbox'));
    expect(await screen.findByRole('option', { name: 'Gamma' })).toBeInTheDocument();
    expect(fetchPage).toHaveBeenLastCalledWith(
      { q: '', page: 2, pageSize: 2 },
      expect.any(AbortSignal),
    );
    // Everything is held now: scrolling again asks for nothing more.
    const calls = fetchPage.mock.calls.length;
    fireEvent.scroll(screen.getByRole('listbox'));
    fireEvent.scroll(screen.getByRole('listbox'));
    expect(screen.getByRole('option', { name: 'Delta' })).toBeInTheDocument();
    expect(fetchPage.mock.calls.length).toBe(calls);
  });

  it('keeps pages that overlap from repeating an option', async () => {
    const fetchPage = vi
      .fn()
      .mockResolvedValueOnce({ items: [ROWS[0], ROWS[1]], total: 3 })
      .mockResolvedValueOnce({ items: [ROWS[1], ROWS[2]], total: 3 });
    render(<Harness fetchPage={fetchPage as unknown as ReturnType<typeof source>} />);
    open();
    await screen.findByRole('option', { name: 'Alpha' });
    fireEvent.scroll(screen.getByRole('listbox'));
    await screen.findByRole('option', { name: 'Gamma' });
    expect(screen.getAllByRole('option', { name: 'Beta' })).toHaveLength(1);
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
  });

  it('says so when the search finds nothing', async () => {
    render(<Harness fetchPage={source()} />);
    open();
    await screen.findByRole('option', { name: 'Alpha' });
    fireEvent.change(field(), { target: { value: 'zzz' } });
    expect(await screen.findByText('Nothing found')).toBeInTheDocument();
  });

  it('keeps showing the picked option when the list goes back to a page that lacks it', async () => {
    const fetchPage = source();
    render(<Harness fetchPage={fetchPage} pageSize={1} />);
    open();
    await screen.findByRole('option', { name: 'Alpha' });
    fireEvent.change(field(), { target: { value: 'bet' } });
    await waitFor(() =>
      expect(fetchPage).toHaveBeenCalledWith(
        { q: 'bet', page: 1, pageSize: 1 },
        expect.any(AbortSignal),
      ),
    );
    fireEvent.click(await screen.findByRole('option', { name: 'Beta' }));
    // Choosing clears the search, so the first page (Alpha alone) comes back without Beta.
    await waitFor(() =>
      expect(fetchPage).toHaveBeenLastCalledWith(
        { q: '', page: 1, pageSize: 1 },
        expect.any(AbortSignal),
      ),
    );
    await waitFor(() => expect((field() as HTMLInputElement).value).toBe('Beta'));
    open();
    expect(await screen.findByRole('option', { name: 'Beta' })).toBeInTheDocument();
  });

  it('forgets the picked option when typing clears it or the parent resets the value', async () => {
    const onPick = vi.fn();
    render(<Harness fetchPage={source()} pageSize={1} onPick={onPick} />);
    open();
    fireEvent.click(await screen.findByRole('option', { name: 'Alpha' }));
    expect((field() as HTMLInputElement).value).toBe('Alpha');
    // Typing over a picked option clears it (the select's own behavior).
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: 'x' } });
    expect(onPick).toHaveBeenLastCalledWith('');

    fireEvent.change(field(), { target: { value: '' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Alpha' }));
    fireEvent.click(screen.getByRole('button', { name: 'reset' }));
    expect((field() as HTMLInputElement).value).toBe('');
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

  it('ignores an answer that arrives after a newer search and after unmounting', async () => {
    let release: (page: RemotePage<Row>) => void = () => undefined;
    const slow = new Promise<RemotePage<Row>>((resolve) => (release = resolve));
    const fetchPage = vi
      .fn()
      .mockReturnValueOnce(slow)
      .mockResolvedValue({ items: [ROWS[2]], total: 1 });
    const { unmount } = render(
      <Harness fetchPage={fetchPage as unknown as ReturnType<typeof source>} />,
    );
    open();
    fireEvent.change(field(), { target: { value: 'gam' } });
    expect(await screen.findByRole('option', { name: 'Gamma' })).toBeInTheDocument();
    release({ items: [ROWS[0]!], total: 1 });
    await Promise.resolve();
    expect(screen.queryByRole('option', { name: 'Alpha' })).not.toBeInTheDocument();
    unmount();

    // A request still in flight when the field goes away.
    const hanging = vi.fn().mockRejectedValue(new Error('aborted'));
    const second = render(<Harness fetchPage={hanging as unknown as ReturnType<typeof source>} />);
    second.unmount();
    await Promise.resolve();
  });
});
