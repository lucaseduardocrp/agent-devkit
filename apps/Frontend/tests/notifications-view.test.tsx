import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NotificationActionEditor } from '../src/features/notifications/NotificationActionEditor.js';
import { NotificationRuleModal } from '../src/features/notifications/NotificationRuleModal.js';
import {
  NotificationsView,
  type NotificationsViewProps,
} from '../src/features/notifications/NotificationsView.js';
import type {
  NotificationChannelDto,
  NotificationEventDto,
  NotificationNodeConfig,
  NotificationRuleDto,
} from '../src/features/notifications/notification-types.js';
import type { WorkspaceMember } from '../src/features/workspaces/workspace-types.js';

const channels: NotificationChannelDto[] = [
  { id: 'email', label: 'E-mail', available: true },
  { id: 'teams', label: 'Teams', available: false },
];
const events: NotificationEventDto[] = [
  {
    key: 'issue.assigned',
    label: 'Issue assigned to a person',
    description: 'An issue is assigned to a member.',
    subjectLabel: 'The person it was assigned to',
    placeholders: ['issue.title', 'actor.name'],
    defaultSubject: 'Issue #{{issue.number}} was assigned to you',
    defaultMessage: '{{actor.name}} assigned you {{issue.title}}.',
  },
  {
    key: 'system.alert',
    label: 'System alert',
    description: 'Something nobody caused.',
    placeholders: [],
    defaultSubject: 'Alert',
    defaultMessage: 'Something happened.',
  },
];
const member = (userId: string, name: string): WorkspaceMember => ({
  id: `m-${userId}`,
  workspaceId: 'ws',
  userId,
  role: 'MEMBER',
  permissions: {},
  createdAt: '',
  user: { id: userId, name, email: `${name.toLowerCase()}@example.com` },
});
const members = [member('u-ana', 'Ana'), member('u-ben', 'Ben'), member('u-carol', 'Carol')];
const rule = (patch: Partial<NotificationRuleDto> = {}): NotificationRuleDto => ({
  id: 'r1',
  name: 'Tell the assignee',
  enabled: true,
  event: 'issue.assigned',
  channels: ['email'],
  recipients: { subject: true, userIds: ['u-ben'] },
  subject: '',
  message: '',
  ...patch,
});

function client(overrides: Record<string, unknown> = {}) {
  return {
    getNotificationChannels: vi.fn().mockResolvedValue(channels),
    getNotificationEvents: vi.fn().mockResolvedValue(events),
    getNotificationRules: vi.fn().mockResolvedValue([rule(), rule({ id: 'r9', name: 'Other' })]),
    saveNotificationRule: vi.fn(async (input: Record<string, unknown>, id?: string) => ({
      id: id ?? 'new-id',
      ...input,
    })),
    deleteNotificationRule: vi.fn().mockResolvedValue(undefined),
    getNotificationPeople: vi.fn().mockResolvedValue({ people: [], total: 0 }),
    saveNotificationContacts: vi.fn().mockResolvedValue([]),
    sendTestNotification: vi
      .fn()
      .mockResolvedValue([{ channel: 'email', userId: 'u-ana', status: 'sent' }]),
    ...overrides,
  };
}

function view(
  apiClient = client(),
  props: Partial<Omit<NotificationsViewProps, 'apiClient'>> = {},
) {
  const result = render(
    <NotificationsView
      apiClient={apiClient as unknown as NotificationsViewProps['apiClient']}
      workspaceId="ws"
      canManage
      {...props}
    />,
  );
  return { ...result, apiClient };
}

const ready = () => screen.findByTestId('notification-rule-r1');

describe('NotificationsView', () => {
  it('shows the channels and the rules, saying who is told and when', async () => {
    view();
    expect(screen.getByTestId('notifications-loading')).toBeInTheDocument();
    const row = await ready();
    expect(row).toHaveTextContent('Tell the assignee');
    expect(row).toHaveTextContent('Issue assigned to a person');
    // The person the event is about, and how many others were chosen.
    expect(row).toHaveTextContent('The person it was assigned to, Pessoas escolhidas: 1');
    // One quiet line: the event, who is told, and the channels.
    expect(row).toHaveTextContent(
      'Issue assigned to a person · The person it was assigned to, Pessoas escolhidas: 1 · E-mail',
    );
    expect(within(row).getByRole('switch').checked).toBe(true);

    expect(
      within(screen.getByTestId('channel-card-email')).getByText('Pronto'),
    ).toBeInTheDocument();
    const teams = screen.getByTestId('channel-card-teams');
    expect(within(teams).getByText('Não configurado')).toBeInTheDocument();
    expect(teams).toHaveTextContent('SMTP');
    // Only a channel that works can be tested.
    expect(screen.queryByTestId('channel-test-teams')).toBeNull();
    expect(screen.getByTestId('channel-test-email')).toBeInTheDocument();
  });

  it('summarises the chosen people, and the events and channels that are gone', async () => {
    const client2 = client({
      getNotificationRules: vi.fn().mockResolvedValue([
        rule({ recipients: { subject: true, userIds: ['u-ana', 'u-ben', 'u-carol', 'u-gone'] } }),
        rule({
          id: 'r2',
          enabled: false,
          event: 'removed.event',
          channels: ['pigeon'],
          recipients: { subject: true, userIds: ['u-gone'] },
        }),
      ]),
    });
    view(client2);
    expect(await ready()).toHaveTextContent('The person it was assigned to, Pessoas escolhidas: 4');
    const second = screen.getByTestId('notification-rule-r2');
    expect(second).toHaveTextContent('Evento desconhecido');
    expect(second).toHaveTextContent('Pessoas escolhidas: 1');
    expect(second).toHaveTextContent('pigeon');
    expect(within(second).getByRole('switch').checked).toBe(false);
  });

  it('invites to create the first rule', async () => {
    view(client({ getNotificationRules: vi.fn().mockResolvedValue([]) }));
    expect(await screen.findByText('Nenhuma regra ainda')).toBeInTheDocument();
  });

  it('says what went wrong when it cannot load, and tries again', async () => {
    const failing = client({
      getNotificationRules: vi
        .fn()
        .mockRejectedValueOnce(new Error('Server down'))
        .mockResolvedValue([rule()]),
    });
    view(failing);
    expect(await screen.findByRole('alert')).toHaveTextContent('Server down');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await ready()).toBeInTheDocument();

    const odd = client({ getNotificationChannels: vi.fn().mockRejectedValue('boom') });
    view(odd);
    expect((await screen.findAllByRole('alert')).at(-1)).toHaveTextContent(
      'Não foi possível carregar as notificações.',
    );
  });

  it('still shows the rules when the people cannot be loaded, or there is no workspace', async () => {
    view(client({ getNotificationPeople: vi.fn().mockRejectedValue(new Error('403')) }));
    expect(await ready()).toBeInTheDocument();
    expect(await screen.findByText('Não foi possível carregar as pessoas.')).toBeInTheDocument();
    const none = client();
    view(none, { workspaceId: null });
    expect((await screen.findAllByTestId('notification-rule-r1')).length).toBeGreaterThan(0);
    expect(none.getNotificationPeople).not.toHaveBeenCalled();
  });

  it('lets a member without access only read', async () => {
    view(client(), { canManage: false });
    const row = await ready();
    expect(screen.getByRole('status')).toHaveTextContent('acesso a Integrações');
    expect(screen.queryByTestId('notification-new-rule')).toBeNull();
    expect(screen.queryByTestId('rule-edit-r1')).toBeNull();
    expect(screen.queryByTestId('channel-test-email')).toBeNull();
    expect(within(row).getByRole('switch').disabled).toBe(true);
  });

  it('turns a rule on or off, and says so when that fails', async () => {
    const apiClient = client();
    view(apiClient);
    fireEvent.click(await screen.findByTestId('rule-toggle-r1'));
    await waitFor(() => expect(apiClient.saveNotificationRule).toHaveBeenCalled());
    expect(apiClient.saveNotificationRule).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, name: 'Tell the assignee' }),
      'r1',
    );
    await waitFor(() => expect(screen.getByTestId('rule-toggle-r1').checked).toBe(false));

    apiClient.saveNotificationRule.mockRejectedValueOnce(new Error('No access'));
    fireEvent.click(screen.getByTestId('rule-toggle-r1'));
    expect(await screen.findByRole('alert')).toHaveTextContent('No access');
    apiClient.saveNotificationRule.mockRejectedValueOnce('boom');
    fireEvent.click(screen.getByTestId('rule-toggle-r1'));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível salvar a alteração.'),
    );
  });

  it('asks before deleting a rule, and then removes it', async () => {
    const apiClient = client();
    view(apiClient);
    fireEvent.click(await screen.findByTestId('rule-delete-r1'));
    expect(screen.getByText('Excluir esta regra?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(apiClient.deleteNotificationRule).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('rule-delete-r1'));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir regra' }));
    await waitFor(() => expect(screen.queryByTestId('notification-rule-r1')).toBeNull());
    expect(apiClient.deleteNotificationRule).toHaveBeenCalledWith('r1');
  });

  it('keeps the rule and says so when it cannot be deleted', async () => {
    const apiClient = client({
      deleteNotificationRule: vi.fn().mockRejectedValue(new Error('Nope')),
    });
    view(apiClient);
    fireEvent.click(await screen.findByTestId('rule-delete-r1'));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir regra' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Nope');
    expect(screen.getByTestId('notification-rule-r1')).toBeInTheDocument();

    apiClient.deleteNotificationRule.mockRejectedValueOnce('boom');
    fireEvent.click(screen.getByTestId('rule-delete-r1'));
    fireEvent.click(screen.getByRole('button', { name: 'Excluir regra' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível salvar a alteração.'),
    );
  });

  it.each([
    ['sent', undefined, 'Teste enviado para você'],
    ['queued', undefined, 'Teste enviado para você'],
    ['skipped', 'The channel is not set up.', 'Não enviado: The channel is not set up.'],
    ['failed', 'SMTP down', 'O teste falhou: SMTP down'],
    ['skipped', undefined, 'Não enviado:'],
    ['failed', undefined, 'O teste falhou:'],
  ] as const)(
    'sends a test message and tells how it went (%s)',
    async (status, reason, expected) => {
      const apiClient = client({
        sendTestNotification: vi
          .fn()
          .mockResolvedValue([{ channel: 'email', userId: 'u', status, reason }]),
      });
      view(apiClient);
      fireEvent.click(await screen.findByTestId('channel-test-email'));
      expect(await screen.findByText(expected, { exact: false })).toBeInTheDocument();
      expect(apiClient.sendTestNotification).toHaveBeenCalledWith('email');
    },
  );

  it('says so when the test cannot be sent at all', async () => {
    const empty = client({ sendTestNotification: vi.fn().mockResolvedValue([]) });
    view(empty);
    fireEvent.click(await screen.findByTestId('channel-test-email'));
    expect(await screen.findByText('Não foi possível enviar o teste.')).toBeInTheDocument();

    const broken = client({ sendTestNotification: vi.fn().mockRejectedValue(new Error('x')) });
    view(broken);
    await waitFor(() => expect(screen.getAllByTestId('channel-test-email')).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId('channel-test-email')[1]!);
    await waitFor(() =>
      expect(screen.getAllByText('Não foi possível enviar o teste.')).toHaveLength(2),
    );
  });

  it('shows the test as in progress while it is being sent', async () => {
    let finish!: (value: unknown) => void;
    const apiClient = client({
      sendTestNotification: vi.fn().mockReturnValue(new Promise((resolve) => (finish = resolve))),
    });
    view(apiClient);
    fireEvent.click(await screen.findByTestId('channel-test-email'));
    expect(await screen.findByText('Enviando…')).toBeInTheDocument();
    finish([{ channel: 'email', userId: 'u', status: 'sent' }]);
    expect(await screen.findByText(/Teste enviado/)).toBeInTheDocument();
  });

  it('creates a rule from the form and lists it', async () => {
    const apiClient = client({ getNotificationRules: vi.fn().mockResolvedValue([]) });
    view(apiClient);
    fireEvent.click(await screen.findByTestId('notification-new-rule'));
    expect(screen.getByRole('heading', { name: 'Nova regra de notificação' })).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('rule-name'), { target: { value: 'Tell Ana' } });
    fireEvent.click(screen.getByTestId('channel-email'));
    fireEvent.click(screen.getByTestId('rule-save'));

    await waitFor(() => expect(apiClient.saveNotificationRule).toHaveBeenCalled());
    expect(apiClient.saveNotificationRule).toHaveBeenCalledWith(
      {
        name: 'Tell Ana',
        enabled: true,
        event: 'issue.assigned',
        channels: ['email'],
        recipients: { subject: true, userIds: [] },
        subject: '',
        message: '',
      },
      undefined,
    );
    expect(await screen.findByText('Tell Ana')).toBeInTheDocument();
    expect(screen.queryByTestId('notification-rule-modal')).toBeNull();
  });

  it('closes the form with Escape without saving', async () => {
    const apiClient = client();
    view(apiClient);
    fireEvent.click(await screen.findByTestId('rule-edit-r1'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('notification-rule-modal')).toBeNull());
    expect(apiClient.saveNotificationRule).not.toHaveBeenCalled();
  });

  it('edits a rule and replaces it in the list', async () => {
    const apiClient = client();
    view(apiClient);
    fireEvent.click(await screen.findByTestId('rule-edit-r1'));
    expect(
      screen.getByRole('heading', { name: 'Editar regra de notificação' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('rule-name').value).toBe('Tell the assignee');
    fireEvent.change(screen.getByTestId('rule-name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByTestId('rule-save'));
    expect(await screen.findByText('Renamed')).toBeInTheDocument();
    expect(apiClient.saveNotificationRule).toHaveBeenCalledWith(expect.anything(), 'r1');
    expect(screen.queryByText('Tell the assignee')).toBeNull();
  });
});

describe('NotificationRuleModal', () => {
  const open = (props: Partial<React.ComponentProps<typeof NotificationRuleModal>> = {}) => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <NotificationRuleModal
        rule={null}
        events={events}
        channels={channels}
        onSave={onSave}
        onClose={onClose}
        {...props}
      />,
    );
    return { onSave, onClose };
  };

  it('asks for what is missing and does not save', () => {
    const { onSave } = open();
    fireEvent.click(screen.getByTestId('rule-save'));
    expect(screen.getByText('Dê um nome à regra.')).toBeInTheDocument();
    expect(screen.getByText('Escolha pelo menos um canal.')).toBeInTheDocument();
    // The person the event is about is told by itself, so nobody has to be chosen.
    expect(screen.queryByText('Escolha quem avisar.')).toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('tells the person the event is about, without asking who, and only when it has one', () => {
    const { onSave } = open();
    expect(screen.getByTestId('rule-recipient')).toHaveTextContent('The person it was assigned to');
    expect(screen.queryByRole('combobox', { name: 'Pessoas a avisar' })).toBeNull();
    expect(screen.queryByTestId('rule-kept-people')).toBeNull();
    fireEvent.change(screen.getByTestId('rule-event'), { target: { value: 'system.alert' } });
    expect(screen.queryByTestId('rule-recipient')).toBeNull();
    fireEvent.change(screen.getByTestId('rule-name'), { target: { value: 'Alerts' } });
    fireEvent.click(screen.getByTestId('channel-email'));
    fireEvent.click(screen.getByTestId('rule-save'));
    // The event has no one it is about, and nobody was chosen before.
    expect(screen.getByText('Escolha quem avisar.')).toBeInTheDocument();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('saves the rule with its wording, telling whoever the event is about', async () => {
    const { onSave } = open();
    fireEvent.change(screen.getByTestId('rule-name'), { target: { value: '  Tell Ben  ' } });
    fireEvent.click(screen.getByTestId('channel-email'));
    fireEvent.click(screen.getByTestId('channel-teams'));
    fireEvent.change(screen.getByTestId('rule-subject'), {
      target: { value: 'Review {{issue.title}}' },
    });
    fireEvent.change(screen.getByTestId('rule-message'), { target: { value: 'Please look.' } });
    fireEvent.click(screen.getByTestId('rule-enabled'));
    fireEvent.click(screen.getByTestId('rule-save'));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith({
      name: 'Tell Ben',
      enabled: false,
      event: 'issue.assigned',
      channels: ['email', 'teams'],
      recipients: { subject: true, userIds: [] },
      subject: 'Review {{issue.title}}',
      message: 'Please look.',
    });
  });

  it('shows the default wording and the names a text may use', () => {
    open();
    expect(screen.getByTestId('rule-subject')).toHaveAttribute(
      'placeholder',
      'Padrão: Issue #{{issue.number}} was assigned to you',
    );
    // The names a text may use are buttons that add them.
    expect(screen.getByTestId('rule-variable-issue.title')).toHaveTextContent('{{issue.title}}');
    expect(screen.getByTestId('rule-variable-actor.name')).toBeInTheDocument();
  });

  it('keeps a channel that is gone, so it can be removed, and the people chosen before', () => {
    open({
      rule: rule({ channels: ['pigeon'], recipients: { subject: false, userIds: ['u-gone'] } }),
    });
    expect(screen.getByTestId('channel-pigeon').checked).toBe(true);
    fireEvent.click(screen.getByTestId('channel-pigeon'));
    expect(screen.queryByTestId('channel-pigeon')).toBeNull();
  });

  it('says that people chosen before are still told, and saves them as they were', async () => {
    const { onSave } = open({
      rule: rule({ recipients: { subject: true, userIds: ['u-ben', 'u-gone'] } }),
    });
    expect(screen.getByTestId('rule-kept-people')).toHaveTextContent('2 pessoas');
    fireEvent.click(screen.getByTestId('rule-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.lastCall![0].recipients).toEqual({
      subject: true,
      userIds: ['u-ben', 'u-gone'],
    });
  });

  it('still lets an event with nobody it is about be saved, when people were chosen before', async () => {
    const { onSave } = open({
      rule: rule({ event: 'system.alert', recipients: { subject: false, userIds: ['u-ben'] } }),
    });
    expect(screen.queryByTestId('rule-recipient')).toBeNull();
    expect(screen.getByTestId('rule-kept-people')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('rule-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.lastCall![0].recipients).toEqual({ subject: false, userIds: ['u-ben'] });
  });

  it('shows what went wrong while saving, and lets the person try again', async () => {
    const onSave = vi
      .fn()
      .mockRejectedValueOnce(new Error('Name taken'))
      .mockRejectedValueOnce('boom')
      .mockResolvedValue(undefined);
    open({ rule: rule(), onSave });
    fireEvent.click(screen.getByTestId('rule-save'));
    expect(await screen.findByText('Name taken')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('rule-save'));
    expect(await screen.findByText('Não foi possível salvar a regra.')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('rule-save'));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(3));
  });

  it('closes without saving, and copes with no events at all', () => {
    const { onClose } = open({ events: [] });
    expect(screen.getByTestId('rule-event').childElementCount).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('NotificationActionEditor', () => {
  const options = {
    channels,
    members: members.map((m) => ({ userId: m.userId, name: m.user!.name, email: m.user!.email })),
    failed: false,
  };
  const config: NotificationNodeConfig = {
    channels: ['email'],
    userIds: ['u-ana'],
    roles: ['assignee'],
    subject: 'S',
    message: 'M',
  };
  const edit = (
    value: NotificationNodeConfig | undefined,
    extra: Partial<React.ComponentProps<typeof NotificationActionEditor>> = {},
  ) => {
    const onChange = vi.fn();
    render(
      <NotificationActionEditor
        value={value}
        options={options}
        disabled={false}
        onChange={onChange}
        {...extra}
      />,
    );
    return onChange;
  };

  it('starts empty and says what is needed', () => {
    edit(undefined);
    expect(screen.getByText('Escolha um canal.')).toBeInTheDocument();
    expect(screen.getByText('Escolha pessoas ou um papel a avisar.')).toBeInTheDocument();
  });

  it('changes one setting at a time and keeps the rest', () => {
    const onChange = edit(config);
    fireEvent.click(screen.getByTestId('channel-teams'));
    expect(onChange).toHaveBeenLastCalledWith({ ...config, channels: ['email', 'teams'] });
    fireEvent.click(screen.getByTestId('node-role-proofreader'));
    expect(onChange).toHaveBeenLastCalledWith({ ...config, roles: ['assignee', 'proofreader'] });
    fireEvent.click(screen.getByTestId('node-role-assignee'));
    expect(onChange).toHaveBeenLastCalledWith({ ...config, roles: [] });
    fireEvent.change(screen.getByTestId('node-subject'), { target: { value: 'New subject' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...config, subject: 'New subject' });
    fireEvent.change(screen.getByTestId('node-message'), { target: { value: 'New message' } });
    expect(onChange).toHaveBeenLastCalledWith({ ...config, message: 'New message' });
    fireEvent.focus(screen.getByRole('combobox', { name: 'Pessoas a avisar' }));
    fireEvent.click(screen.getByRole('option', { name: /Ben/ }));
    expect(onChange).toHaveBeenLastCalledWith({ ...config, userIds: ['u-ana', 'u-ben'] });
  });

  it('shows who the node tells even if they left, and can be read-only', () => {
    edit({ ...config, userIds: ['u-gone'] }, { disabled: true });
    expect(screen.getByText('Alguém que saiu')).toBeInTheDocument();
    expect(screen.getByTestId('node-subject').disabled).toBe(true);
    expect(screen.getByTestId('node-role-assignee').disabled).toBe(true);
  });

  it('says when the channels and members could not be loaded', () => {
    edit(config, { options: { channels: [], members: [], failed: true } });
    expect(screen.getByRole('status')).toHaveTextContent('Integrações');
    // The channel the node uses is still shown, so it can be seen and removed.
    expect(screen.getByTestId('channel-email').checked).toBe(true);
  });
});
