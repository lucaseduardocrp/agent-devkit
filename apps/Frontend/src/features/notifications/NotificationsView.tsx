import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog.js';
import { Input } from '../../components/ui/input.js';
import {
  PAGE_SIZES,
  Pagination,
  PagingSentinel,
  usePaging,
} from '../../components/ui/pagination.js';
import { SkeletonCard } from '../../components/ui/skeleton.js';
import { Switch } from '../../components/ui/switch.js';
import type { ApiClient } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import { cn } from '../../lib/utils.js';
import { NotificationContactsModal } from './NotificationContactsModal.js';
import { NotificationRuleModal } from './NotificationRuleModal.js';
import type {
  NotificationChannelDto,
  NotificationEventDto,
  NotificationMemberOption,
  NotificationPersonDto,
  NotificationRuleDto,
  NotificationRuleInput,
} from './notification-types.js';

export interface NotificationsViewProps {
  readonly apiClient: Pick<
    ApiClient,
    | 'getNotificationChannels'
    | 'getNotificationEvents'
    | 'getNotificationRules'
    | 'getNotificationPeople'
    | 'saveNotificationContacts'
    | 'saveNotificationRule'
    | 'deleteNotificationRule'
    | 'sendTestNotification'
  >;
  readonly workspaceId: string | null;
  /** May create, change and delete rules (access to Integrations). */
  readonly canManage: boolean;
}

interface Loaded {
  readonly channels: readonly NotificationChannelDto[];
  readonly events: readonly NotificationEventDto[];
}

/** The outcome of a test message, per channel. */
interface TestOutcome {
  readonly sending: boolean;
  readonly message?: string;
  readonly ok?: boolean;
}

/** A short list needs no search; it shows from this many people on. */
const SEARCH_FROM = 5;
/** How long the typing must pause before the server is asked. */
const SEARCH_DELAY_MS = 250;

/** Who is told, and when: the rules, and the channels they use. */
export function NotificationsView({
  apiClient,
  workspaceId,
  canManage,
}: NotificationsViewProps): React.JSX.Element {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [rules, setRules] = useState<readonly NotificationRuleDto[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ readonly rule: NotificationRuleDto | null } | null>(
    null,
  );
  const [pendingDelete, setPendingDelete] = useState<NotificationRuleDto | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // The people come a page at a time from the server; `list.key` says which page or search it is.
  const [list, setList] = useState<{ key: string; people: readonly NotificationPersonDto[] }>({
    key: '',
    people: [],
  });
  const [total, setTotal] = useState(0);
  const [peopleReady, setPeopleReady] = useState(false);
  const [peopleFailed, setPeopleFailed] = useState(false);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [editingMember, setEditingMember] = useState<NotificationPersonDto | null>(null);
  const [tests, setTests] = useState<Readonly<Record<string, TestOutcome>>>({});

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const [channels, events, loadedRules] = await Promise.all([
        apiClient.getNotificationChannels(),
        apiClient.getNotificationEvents(),
        apiClient.getNotificationRules(),
      ]);
      setRules(loadedRules);
      setLoaded({ channels, events });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : t('notifications.loadFailed'));
    }
  }, [apiClient, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const replaceRule = (rule: NotificationRuleDto) =>
    setRules((current) =>
      current.some((item) => item.id === rule.id)
        ? current.map((item) => (item.id === rule.id ? rule : item))
        : [...current, rule],
    );

  const saveRule = async (input: NotificationRuleInput) => {
    replaceRule(await apiClient.saveNotificationRule(input, editing?.rule?.id));
    setEditing(null);
  };

  const toggleRule = async (rule: NotificationRuleDto, enabled: boolean) => {
    setActionError(null);
    const { id, ...input } = rule;
    try {
      replaceRule(await apiClient.saveNotificationRule({ ...input, enabled }, id));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('notifications.actionFailed'));
    }
  };

  const confirmDelete = async (target: NotificationRuleDto) => {
    setDeleting(true);
    setActionError(null);
    try {
      await apiClient.deleteNotificationRule(target.id);
      const removed = target.id;
      setRules((current) => current.filter((rule) => rule.id !== removed));
      setPendingDelete(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('notifications.actionFailed'));
      setPendingDelete(null);
    } finally {
      setDeleting(false);
    }
  };

  const sendTest = async (channel: string) => {
    setTests((current) => ({ ...current, [channel]: { sending: true } }));
    let outcome: TestOutcome;
    try {
      const result = (await apiClient.sendTestNotification(channel))[0];
      if (!result) outcome = { sending: false, ok: false, message: t('notifications.testError') };
      else if (result.status === 'sent' || result.status === 'queued')
        outcome = { sending: false, ok: true, message: t('notifications.testSent') };
      else if (result.status === 'skipped')
        outcome = {
          sending: false,
          ok: false,
          message: t('notifications.testSkipped', { reason: result.reason ?? '' }),
        };
      else
        outcome = {
          sending: false,
          ok: false,
          message: t('notifications.testFailed', { reason: result.reason ?? '' }),
        };
    } catch {
      outcome = { sending: false, ok: false, message: t('notifications.testError') };
    }
    setTests((current) => ({ ...current, [channel]: outcome }));
  };

  const saveContacts = async (
    member: NotificationMemberOption,
    changes: Record<string, string>,
  ) => {
    const saved = await apiClient.saveNotificationContacts(member.userId, changes);
    const contacts = Object.fromEntries(saved.map((contact) => [contact.channel, contact.address]));
    setList((current) => ({
      ...current,
      people: current.people.map((person) =>
        person.userId === member.userId ? { ...person, contacts } : person,
      ),
    }));
    setEditingMember(null);
  };

  // The search waits for a pause in the typing, so each key does not cost a request.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);

  // Which people to draw is the server's to say; the paging only knows how many there are.
  const paging = usePaging(total, { storageKey: 'notifications.people.paging', resetKey: query });
  const needsPaging = paging.total > PAGE_SIZES[0];
  const listRef = useRef(list);
  listRef.current = list;
  const { mode, pageSize, page } = paging;
  // Only scrolling cares how far the list has grown; a page is fetched whole.
  const scrolledTo = paging.mode === 'scroll' ? paging.end : 0;
  useEffect(() => {
    if (!workspaceId) {
      setPeopleReady(true);
      return;
    }
    // A page replaces the list; in scroll mode the next batch is added below what is there.
    const key =
      mode === 'pages'
        ? `${workspaceId}|${query}|${pageSize}|${page}`
        : `${workspaceId}|${query}|scroll|${pageSize}`;
    const have = listRef.current.key === key ? listRef.current.people.length : 0;
    if (mode === 'scroll' && have > 0 && have >= scrolledTo) return;
    const controller = new AbortController();
    const offset = mode === 'pages' ? (page - 1) * pageSize : have;
    apiClient
      .getNotificationPeople({ search: query, offset, limit: pageSize }, controller.signal)
      .then(
        (found) => {
          setList((current) => ({
            key,
            people:
              current.key === key && mode === 'scroll'
                ? [...current.people, ...found.people]
                : found.people,
          }));
          setTotal(found.total);
          setPeopleFailed(false);
          setPeopleReady(true);
        },
        () => {
          if (controller.signal.aborted) return;
          setPeopleFailed(true);
          setPeopleReady(true);
        },
      );
    return () => controller.abort();
  }, [apiClient, workspaceId, query, mode, pageSize, page, scrolledTo]);

  const eventLabel = (key: string) =>
    loaded?.events.find((event) => event.key === key)?.label ?? t('notifications.unknownEvent');

  const recipientsSummary = (rule: NotificationRuleDto): string => {
    const subjectLabel = loaded?.events.find((event) => event.key === rule.event)?.subjectLabel;
    const chosen = rule.recipients.userIds.length;
    return [
      ...(rule.recipients.subject && subjectLabel ? [subjectLabel] : []),
      ...(chosen > 0 ? [t('notifications.recipientsChosen', { count: chosen })] : []),
    ].join(', ');
  };

  return (
    <div className="space-y-10" data-testid="screen-notifications">
      {!canManage && (
        <p
          role="status"
          className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300"
        >
          {t('notifications.readOnly')}
        </p>
      )}

      {loadError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300"
        >
          <span>{loadError}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
            {t('notifications.retry')}
          </Button>
        </div>
      )}

      {!loaded && !loadError && (
        <div className="grid gap-3 sm:grid-cols-2" data-testid="notifications-loading">
          <SkeletonCard />
          <SkeletonCard />
        </div>
      )}

      {loaded && (
        <>
          <section aria-labelledby="notification-channels" className="space-y-3">
            <h2 id="notification-channels" className="text-sm font-semibold">
              {t('notifications.channelsTitle')}
            </h2>
            <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
              {loaded.channels.map((channel) => {
                const test = tests[channel.id];
                return (
                  <li
                    key={channel.id}
                    data-testid={`channel-card-${channel.id}`}
                    className="flex flex-col gap-1.5 px-4 py-3"
                  >
                    <div className="flex items-center gap-3">
                      <span className="font-medium">{channel.label}</span>
                      <Badge variant={channel.available ? 'success' : 'outline'}>
                        {channel.available
                          ? t('notifications.channelReady')
                          : t('notifications.channelNotSetUp')}
                      </Badge>
                      {canManage && channel.available && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="ml-auto"
                          isLoading={test?.sending ?? false}
                          onClick={() => void sendTest(channel.id)}
                          data-testid={`channel-test-${channel.id}`}
                        >
                          {test?.sending
                            ? t('notifications.sendingTest')
                            : t('notifications.sendTest')}
                        </Button>
                      )}
                    </div>
                    {!channel.available && (
                      <p className="text-xs text-[var(--text-secondary)]">
                        {t('notifications.channelNotSetUpHint')}
                      </p>
                    )}
                    {test?.message && (
                      <p
                        role="status"
                        className={test.ok ? 'text-xs text-emerald-300' : 'text-xs text-red-300'}
                      >
                        {test.message}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <section aria-labelledby="notification-people" className="space-y-3">
            <div className="flex min-h-10 items-center justify-between gap-3">
              <h2 id="notification-people" className="text-sm font-semibold">
                {t('notifications.contactsTitle')}
              </h2>
              {(total > SEARCH_FROM || search !== '') && (
                <div className="w-full sm:w-64">
                  <Input
                    value={search}
                    onChange={(change) => setSearch(change.target.value)}
                    placeholder={t('notifications.contactsSearch')}
                    aria-label={t('notifications.contactsSearch')}
                    leftIcon={<i className="ti ti-search" aria-hidden="true" />}
                    data-testid="contacts-search"
                  />
                </div>
              )}
            </div>

            {peopleFailed && (
              <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {t('notifications.contactsLoadFailed')}
              </p>
            )}

            {!peopleReady ? (
              <SkeletonCard />
            ) : list.people.length === 0 && query === '' && !peopleFailed ? (
              <p className="rounded-lg border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--text-secondary)]">
                {t('notifications.contactsNone')}
              </p>
            ) : list.people.length === 0 ? (
              <p className="rounded-lg border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--text-secondary)]">
                {t('notifications.contactsNoMatches')}
              </p>
            ) : (
              <>
                <ul
                  className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] bg-[var(--surface-1)]"
                  data-testid="contacts-list"
                >
                  {list.people.map((member) => {
                    const own = member.contacts;
                    const configured = loaded.channels.filter((channel) => own[channel.id]);
                    const row = (
                      <>
                        <span className="min-w-0 flex-1 truncate">
                          <span className="font-medium">{member.name}</span>
                          <span className="ml-3 text-xs text-[var(--text-muted)]">
                            {member.email}
                          </span>
                        </span>
                        {configured.map((channel) => (
                          <Badge key={channel.id} variant="outline">
                            {channel.label}
                          </Badge>
                        ))}
                        {canManage && (
                          <i
                            className="ti ti-chevron-right text-[var(--text-muted)]"
                            aria-hidden="true"
                          />
                        )}
                      </>
                    );
                    const className = 'flex w-full items-center gap-3 px-4 py-2.5 text-left';
                    return (
                      <li key={member.userId} data-testid={`contact-row-${member.userId}`}>
                        {canManage ? (
                          <button
                            type="button"
                            aria-label={t('notifications.contactsEdit', { name: member.name })}
                            onClick={() => setEditingMember(member)}
                            className={`${className} transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--fill-accent)]`}
                          >
                            {row}
                          </button>
                        ) : (
                          <div className={className}>{row}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {needsPaging && (
                  <>
                    <PagingSentinel paging={paging} />
                    <Pagination paging={paging} perPageLabel={t('notifications.contactsPerPage')} />
                  </>
                )}
              </>
            )}
          </section>

          <section aria-labelledby="notification-rules" className="space-y-3">
            <div className="flex min-h-10 items-center justify-between gap-3">
              <h2 id="notification-rules" className="text-sm font-semibold">
                {t('notifications.rulesTitle')}
              </h2>
              {canManage && (
                <Button
                  type="button"
                  size="sm"
                  onClick={() => setEditing({ rule: null })}
                  data-testid="notification-new-rule"
                >
                  <i className="ti ti-plus mr-2" aria-hidden="true" />
                  {t('notifications.newRule')}
                </Button>
              )}
            </div>

            {actionError && (
              <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {actionError}
              </p>
            )}

            {rules.length === 0 ? (
              <div className="rounded-lg border border-dashed border-[var(--border)] p-6 text-center">
                <p className="text-sm font-medium">{t('notifications.noRules')}</p>
                <p className="mt-1 text-xs text-[var(--text-secondary)]">
                  {t('notifications.noRulesHint')}
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] bg-[var(--surface-1)]">
                {rules.map((rule) => (
                  <li
                    key={rule.id}
                    data-testid={`notification-rule-${rule.id}`}
                    className="flex items-center gap-4 px-4 py-3"
                  >
                    <Switch
                      checked={rule.enabled}
                      disabled={!canManage}
                      aria-label={t('notifications.toggleRule', { name: rule.name })}
                      onChange={(change) => void toggleRule(rule, change.target.checked)}
                      data-testid={`rule-toggle-${rule.id}`}
                    />
                    <div className="min-w-0 flex-1">
                      <p className={cn('truncate font-medium', !rule.enabled && 'opacity-60')}>
                        {rule.name}
                      </p>
                      <p className="truncate text-xs text-[var(--text-muted)]">
                        {[
                          eventLabel(rule.event),
                          recipientsSummary(rule),
                          rule.channels
                            .map(
                              (channel) =>
                                loaded.channels.find((item) => item.id === channel)?.label ??
                                channel,
                            )
                            .join(', '),
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    </div>
                    {canManage && (
                      <div className="flex gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing({ rule })}
                          data-testid={`rule-edit-${rule.id}`}
                        >
                          {t('notifications.edit')}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setPendingDelete(rule)}
                          data-testid={`rule-delete-${rule.id}`}
                        >
                          {t('notifications.delete')}
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {editing && loaded && (
        <NotificationRuleModal
          key={editing.rule?.id ?? 'new'}
          rule={editing.rule}
          events={loaded.events}
          channels={loaded.channels}
          onSave={saveRule}
          onClose={() => setEditing(null)}
        />
      )}

      {editingMember && loaded && (
        <NotificationContactsModal
          key={editingMember.userId}
          member={editingMember}
          channels={loaded.channels}
          contacts={editingMember.contacts}
          onSave={(changes) => saveContacts(editingMember, changes)}
          onClose={() => setEditingMember(null)}
        />
      )}

      <ConfirmationDialog
        open={pendingDelete !== null}
        title={t('notifications.deleteTitle')}
        description={t('notifications.deleteDescription', { name: pendingDelete?.name ?? '' })}
        confirmLabel={t('notifications.deleteConfirm')}
        cancelLabel={t('notifications.cancel')}
        isLoading={deleting}
        destructive
        onConfirm={() => pendingDelete && void confirmDelete(pendingDelete)}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
