import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  NotificationsView,
  type NotificationsViewProps,
} from '../src/features/notifications/NotificationsView.js';
import type {
  NotificationChannelDto,
  NotificationPersonDto,
} from '../src/features/notifications/notification-types.js';

const channels: NotificationChannelDto[] = [
  { id: 'email', label: 'E-mail', available: true },
  { id: 'teams', label: 'Teams', available: false },
];
const person = (
  userId: string,
  name: string,
  contacts: Record<string, string> = {},
): NotificationPersonDto => ({
  userId,
  name,
  email: `${name.toLowerCase()}@adk.com`,
  contacts,
});

/** Answers like the server: finds by name or e-mail, then gives the page asked for. */
const serverOf = (everyone: readonly NotificationPersonDto[]) =>
  vi.fn(async (query: { search: string; offset: number; limit: number }) => {
    const text = query.search.toLowerCase();
    const found = everyone.filter(
      (one) => !text || one.name.toLowerCase().includes(text) || one.email.includes(text),
    );
    return { total: found.length, people: found.slice(query.offset, query.offset + query.limit) };
  });

const ana = person('u-ana', 'Ana', { email: 'ana@work.com' });
const ben = person('u-ben', 'Ben');

function client(overrides: Record<string, unknown> = {}) {
  return {
    getNotificationChannels: vi.fn().mockResolvedValue(channels),
    getNotificationEvents: vi.fn().mockResolvedValue([]),
    getNotificationRules: vi.fn().mockResolvedValue([]),
    saveNotificationRule: vi.fn(),
    deleteNotificationRule: vi.fn(),
    sendTestNotification: vi.fn(),
    getNotificationPeople: serverOf([ana, ben]),
    saveNotificationContacts: vi.fn(async (_userId: string, changes: Record<string, string>) =>
      Object.entries(changes)
        .filter(([, address]) => address)
        .map(([channel, address]) => ({ userId: 'u-ana', channel, address })),
    ),
    ...overrides,
  };
}

function view(apiClient = client(), props: Partial<NotificationsViewProps> = {}) {
  render(
    <NotificationsView
      apiClient={apiClient as unknown as NotificationsViewProps['apiClient']}
      workspaceId="ws"
      canManage
      {...props}
    />,
  );
  return apiClient;
}

const row = (id: string) => screen.findByTestId(`contact-row-${id}`);
const asked = (api: ReturnType<typeof client>) =>
  (api.getNotificationPeople as ReturnType<typeof serverOf>).mock.calls.map((call) => call[0]);

describe('the people of the notifications screen', () => {
  it('lists the people, with the channels each one has an address on', async () => {
    view();
    const first = await row('u-ana');
    expect(first).toHaveTextContent('Ana');
    expect(first).toHaveTextContent('ana@adk.com');
    expect(within(first).getByText('E-mail')).toBeInTheDocument();
    // Nobody set Ben's addresses, so his row shows no channel at all.
    expect(within(await row('u-ben')).queryByText('E-mail')).toBeNull();
  });

  it('draws no initials next to the names', async () => {
    view();
    expect((await row('u-ana')).querySelector('[aria-hidden="true"]:not(i)')).toBeNull();
  });

  it('offers a search only when the list is long enough to need one', async () => {
    view();
    await row('u-ana');
    expect(screen.queryByTestId('contacts-search')).toBeNull();
  });

  it('asks the server for the search, once the typing pauses, and says when nobody matches', async () => {
    const many = [
      ana,
      ben,
      ...['Cai', 'Dora', 'Eli', 'Fay'].map((name) => person(`u-${name}`, name)),
    ];
    const api = view(client({ getNotificationPeople: serverOf(many) }));
    await row('u-ana');
    const search = screen.getByTestId('contacts-search');
    fireEvent.change(search, { target: { value: 'B' } });
    fireEvent.change(search, { target: { value: 'BEN@' } });
    await waitFor(() => expect(screen.queryByTestId('contact-row-u-ana')).toBeNull());
    expect(screen.getByTestId('contact-row-u-ben')).toBeInTheDocument();
    // The keys typed too fast to count did not each cost a request.
    expect(asked(api).map((query) => query.search)).toEqual(['', 'BEN@']);

    fireEvent.change(search, { target: { value: 'nobody' } });
    expect(await screen.findByText('Ninguém corresponde à busca.')).toBeInTheDocument();
    expect(screen.queryByTestId('contacts-list')).toBeNull();
    // The box stays, so the search can be fixed or cleared.
    expect(screen.getByTestId('contacts-search')).toBeInTheDocument();
  });

  it('says so when the workspace has no people', async () => {
    view(client({ getNotificationPeople: serverOf([]) }));
    expect(await screen.findByText('Ainda não há pessoas neste workspace.')).toBeInTheDocument();
    expect(screen.queryByTestId('contacts-search')).toBeNull();
  });

  it('opens the person with the name and e-mail they have in ADK, and one field per channel', async () => {
    view();
    fireEvent.click(await screen.findByRole('button', { name: /Ana/ }));

    const modal = await screen.findByTestId('notification-contacts-modal');
    expect(within(modal).getByTestId('adk-name')).toHaveTextContent('Ana');
    expect(within(modal).getByTestId('adk-email')).toHaveTextContent('ana@adk.com');
    expect((within(modal).getByTestId('contact-email') as HTMLInputElement).value).toBe(
      'ana@work.com',
    );
    expect((within(modal).getByTestId('contact-teams') as HTMLInputElement).value).toBe('');
    expect(modal.textContent).not.toMatch(/^A\s/);
  });

  it('saves only what changed, and shows the new address on the list', async () => {
    const api = view();
    fireEvent.click(await screen.findByRole('button', { name: /Ana/ }));
    const modal = await screen.findByTestId('notification-contacts-modal');
    const emailField = modal.querySelector('input[type="email"]') as HTMLInputElement;
    expect(emailField.value).toBe('ana@work.com');
    fireEvent.change(emailField, { target: { value: ' ana@new.com ' } });
    fireEvent.change(within(modal).getByTestId('contact-teams'), { target: { value: '@ana' } });
    fireEvent.click(within(modal).getByTestId('contacts-save'));

    await waitFor(() => expect(screen.queryByTestId('notification-contacts-modal')).toBeNull());
    expect(api.saveNotificationContacts).toHaveBeenCalledWith('u-ana', {
      email: 'ana@new.com',
      teams: '@ana',
    });
    expect(await row('u-ana')).toHaveTextContent('Teams');
    // The list was not asked for again: the saved person was updated where they are.
    expect(asked(api)).toHaveLength(1);
  });

  it('closes without calling the server when nothing changed, and on cancel', async () => {
    const api = view();
    fireEvent.click(await screen.findByRole('button', { name: /Ana/ }));
    fireEvent.click(await screen.findByTestId('contacts-save'));
    await waitFor(() => expect(screen.queryByTestId('notification-contacts-modal')).toBeNull());
    expect(api.saveNotificationContacts).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole('button', { name: /Ben/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancelar' }));
    await waitFor(() => expect(screen.queryByTestId('notification-contacts-modal')).toBeNull());
  });

  it('removes an address by emptying it', async () => {
    const api = view();
    fireEvent.click(await screen.findByRole('button', { name: /Ana/ }));
    const modal = await screen.findByTestId('notification-contacts-modal');
    fireEvent.change(modal.querySelector('input[type="email"]')!, { target: { value: '' } });
    fireEvent.click(within(modal).getByTestId('contacts-save'));
    await waitFor(() => expect(screen.queryByTestId('notification-contacts-modal')).toBeNull());
    expect(api.saveNotificationContacts).toHaveBeenCalledWith('u-ana', { email: '' });
    expect(within(await row('u-ana')).queryByText('E-mail')).toBeNull();
  });

  it('keeps the modal open and says why when the server refuses an address', async () => {
    view(
      client({
        saveNotificationContacts: vi.fn().mockRejectedValue(new Error('Enter a valid e-mail.')),
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: /Ben/ }));
    const modal = await screen.findByTestId('notification-contacts-modal');
    fireEvent.change(modal.querySelector('input[type="email"]')!, { target: { value: 'nope' } });
    fireEvent.click(within(modal).getByTestId('contacts-save'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a valid e-mail.');
    expect(screen.getByTestId('notification-contacts-modal')).toBeInTheDocument();
  });

  it('uses a generic message when the failure has no text', async () => {
    view(client({ saveNotificationContacts: vi.fn().mockRejectedValue('boom') }));
    fireEvent.click(await screen.findByRole('button', { name: /Ben/ }));
    const modal = await screen.findByTestId('notification-contacts-modal');
    fireEvent.change(within(modal).getByTestId('contact-teams'), { target: { value: 'x' } });
    fireEvent.click(within(modal).getByTestId('contacts-save'));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('says when there is no channel to set an address on', async () => {
    view(client({ getNotificationChannels: vi.fn().mockResolvedValue([]) }));
    fireEvent.click(await screen.findByRole('button', { name: /Ben/ }));
    expect(await screen.findByText('Nenhum canal está disponível ainda.')).toBeInTheDocument();
  });

  it('warns when the people cannot be loaded', async () => {
    view(client({ getNotificationPeople: vi.fn().mockRejectedValue(new Error('403')) }));
    expect(await screen.findByText('Não foi possível carregar as pessoas.')).toBeInTheDocument();
    expect(screen.queryByText('Ainda não há pessoas neste workspace.')).toBeNull();
  });

  it('only lets managers open a person', async () => {
    view(client({ getNotificationPeople: serverOf([person('u-ana', 'Ana')]) }), {
      canManage: false,
    });
    expect(await row('u-ana')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ana/ })).toBeNull();
  });

  it('forgets an answer that arrives after the search changed', async () => {
    const many = [
      ana,
      ben,
      ...['Cai', 'Dora', 'Eli', 'Fay'].map((name) => person(`u-${name}`, name)),
    ];
    const slow = vi.fn(
      (query: { search: string; offset: number; limit: number }, signal?: AbortSignal) =>
        new Promise<{ total: number; people: NotificationPersonDto[] }>((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
          const found = many.filter((one) => one.name.toLowerCase().includes(query.search));
          // The answer about 'cai' never comes: only the abort ends it.
          if (query.search !== 'cai')
            setTimeout(() => resolve({ total: found.length, people: found }), 0);
        }),
    );
    view(client({ getNotificationPeople: slow }));
    await row('u-ana');
    const search = screen.getByTestId('contacts-search');
    fireEvent.change(search, { target: { value: 'cai' } });
    await waitFor(() => expect(slow).toHaveBeenCalledTimes(2));
    fireEvent.change(search, { target: { value: 'dora' } });
    await waitFor(() => expect(screen.queryByTestId('contact-row-u-Cai')).toBeNull());
    expect(await row('u-Dora')).toBeInTheDocument();
    // The one that was cut short is not taken for a failure.
    expect(screen.queryByText('Não foi possível carregar as pessoas.')).toBeNull();
  });

  describe('in a workspace with a lot of people', () => {
    const crowd = Array.from({ length: 60 }, (_, index) =>
      person(`u-${index + 1}`, `Person${String(index + 1).padStart(2, '0')}`),
    );
    const crowded = () => view(client({ getNotificationPeople: serverOf(crowd) }));
    const rows = () => screen.getAllByTestId(/^contact-row-/);

    it('asks for one page of people at a time, and moves between pages', async () => {
      const api = crowded();
      await row('u-1');
      expect(rows()).toHaveLength(25);
      expect(screen.getByTestId('pagination')).toHaveTextContent('1–25');
      expect(screen.getByTestId('pagination')).toHaveTextContent('60');
      expect(asked(api)).toEqual([{ search: '', offset: 0, limit: 25 }]);

      fireEvent.click(screen.getByRole('button', { name: /página 2|page 2/i }));
      expect(await row('u-26')).toBeInTheDocument();
      expect(rows()).toHaveLength(25);
      expect(screen.queryByTestId('contact-row-u-1')).toBeNull();
      expect(asked(api).at(-1)).toEqual({ search: '', offset: 25, limit: 25 });
    });

    it('starts the search over from the first page', async () => {
      const api = crowded();
      await row('u-1');
      fireEvent.click(screen.getByRole('button', { name: /página 3|page 3/i }));
      expect(await row('u-51')).toBeInTheDocument();

      fireEvent.change(screen.getByTestId('contacts-search'), { target: { value: 'person5' } });
      // Person50 to Person59: ten people, all on the first page, so no paging.
      await waitFor(() => expect(screen.queryByTestId('pagination')).toBeNull());
      expect(rows()).toHaveLength(10);
      expect(asked(api).at(-1)).toEqual({ search: 'person5', offset: 0, limit: 25 });
    });

    it('opens the right person from any page', async () => {
      crowded();
      await row('u-1');
      fireEvent.click(screen.getByRole('button', { name: /página 2|page 2/i }));
      fireEvent.click(await screen.findByRole('button', { name: /Person30/ }));
      expect(await screen.findByTestId('adk-name')).toHaveTextContent('Person30');
    });

    it('keeps the scroll mode it was left in, without asking twice for the first batch', async () => {
      localStorage.setItem(
        'notifications.people.paging',
        JSON.stringify({ mode: 'scroll', pageSize: 25 }),
      );
      try {
        const api = crowded();
        await row('u-1');
        await waitFor(() => expect(screen.getByTestId('pagination')).toHaveTextContent('60'));
        expect(asked(api)).toEqual([{ search: '', offset: 0, limit: 25 }]);
      } finally {
        localStorage.removeItem('notifications.people.paging');
      }
    });

    it('adds the next people below as the list is scrolled, instead of by page', async () => {
      const api = crowded();
      await row('u-1');
      fireEvent.click(screen.getByRole('button', { name: /rolagem|scroll/i }));
      await waitFor(() => expect(rows()).toHaveLength(25));
      fireEvent.click(screen.getByRole('button', { name: /mais|more/i }));
      await waitFor(() => expect(rows()).toHaveLength(50));
      // Only the new batch was asked for, after the people already shown.
      expect(asked(api).at(-1)).toEqual({ search: '', offset: 25, limit: 25 });
      expect(screen.getByTestId('contact-row-u-1')).toBeInTheDocument();
      expect(screen.getByTestId('contact-row-u-50')).toBeInTheDocument();
    });
  });
});
