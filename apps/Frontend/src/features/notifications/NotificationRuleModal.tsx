import React, { useId, useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Modal } from '../../components/ui/modal.js';
import { Select } from '../../components/ui/select.js';
import { Switch } from '../../components/ui/switch.js';
import { Textarea } from '../../components/ui/textarea.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import { ChannelPicker } from './ChannelPicker.js';
import { previewTemplate } from './notification-preview.js';
import { NotificationSection } from './NotificationSection.js';
import type {
  NotificationChannelDto,
  NotificationEventDto,
  NotificationRuleDto,
  NotificationRuleInput,
} from './notification-types.js';

export interface NotificationRuleModalProps {
  /** The rule being edited; null creates a new one. */
  readonly rule: NotificationRuleDto | null;
  readonly events: readonly NotificationEventDto[];
  readonly channels: readonly NotificationChannelDto[];
  /** Saves the rule; rejects with what to tell the person when it cannot. */
  readonly onSave: (input: NotificationRuleInput) => Promise<void>;
  readonly onClose: () => void;
}

type Problem = 'name' | 'channels' | 'recipients';
type TextField = 'subject' | 'message';
type WordingView = 'edit' | 'preview';

const SUBJECT_LIMIT = 200;
const MESSAGE_LIMIT = 5000;

/** Create or edit a notification rule: when, through which channels, whom to tell, and the words. */
export function NotificationRuleModal({
  rule,
  events,
  channels,
  onSave,
  onClose,
}: NotificationRuleModalProps): React.JSX.Element {
  const { t } = useI18n();
  const titleId = useId();
  const [name, setName] = useState(rule?.name ?? '');
  const [eventKey, setEventKey] = useState(rule?.event ?? events[0]?.key ?? '');
  const [selectedChannels, setSelectedChannels] = useState<string[]>([...(rule?.channels ?? [])]);
  // Who is told is not chosen here: it follows the event, each time it happens. People picked
  // before this was so are kept as they were, and the rule says so.
  const keptPeople = rule?.recipients.userIds ?? [];
  const [subject, setSubject] = useState(rule?.subject ?? '');
  const [message, setMessage] = useState(rule?.message ?? '');
  /** The text a variable button adds to: the one the person was last typing in. */
  const [target, setTarget] = useState<TextField>('message');
  /** Whether the words are being written, or read the way people will see them. */
  const [view, setView] = useState<WordingView>('edit');
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [problems, setProblems] = useState<ReadonlySet<Problem>>(new Set());
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const event = events.find((candidate) => candidate.key === eventKey);
  /** Adds `{{name}}` to the end of the text being written, when it still fits. */
  const insertVariable = (variable: string) => {
    const token = `{{${variable}}}`;
    const add = (text: string, limit: number) => {
      const next = `${text}${text && !/\s$/.test(text) ? ' ' : ''}${token}`;
      return next.length <= limit ? next : text;
    };
    if (target === 'subject') setSubject((text) => add(text, SUBJECT_LIMIT));
    else setMessage((text) => add(text, MESSAGE_LIMIT));
  };

  const save = async () => {
    const found = new Set<Problem>();
    if (!name.trim()) found.add('name');
    if (selectedChannels.length === 0) found.add('channels');
    const tellsSubject = Boolean(event?.subjectLabel);
    if (!tellsSubject && keptPeople.length === 0) found.add('recipients');
    setProblems(found);
    if (found.size > 0) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({
        name: name.trim(),
        enabled,
        event: eventKey,
        channels: selectedChannels,
        recipients: { subject: tellsSubject, userIds: [...keptPeople] },
        subject,
        message,
      });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t('notifications.saveFailed'));
      setSaving(false);
    }
  };

  const error = (problem: Problem, text: string) =>
    problems.has(problem) ? (
      <p role="alert" className="text-xs text-red-400">
        {text}
      </p>
    ) : null;

  const previewSubject = previewTemplate(subject || event?.defaultSubject || '');
  const previewMessage = previewTemplate(message || event?.defaultMessage || '');

  return (
    <Modal open onClose={onClose} labelledBy={titleId}>
      <form
        data-testid="notification-rule-modal"
        className="flex max-h-[92vh] w-[min(96vw,880px)] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-2)]"
        onSubmit={(submit) => {
          submit.preventDefault();
          void save();
        }}
      >
        <div className="border-b border-[var(--border)] px-6 py-4">
          <h2 id={titleId} className="text-lg font-semibold">
            {rule ? t('notifications.modalEdit') : t('notifications.modalCreate')}
          </h2>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            {t('notifications.ruleIntro')}
          </p>
        </div>

        <div className="flex flex-col gap-6 overflow-y-auto p-6">
          <NotificationSection>
            <div className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
              <span>{t('notifications.channels')}</span>
              <ChannelPicker
                channels={channels}
                selected={selectedChannels}
                invalid={problems.has('channels')}
                onChange={setSelectedChannels}
              />
              {error('channels', t('notifications.channelRequired'))}
            </div>
          </NotificationSection>

          <NotificationSection>
            <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
              {t('notifications.name')}
              <Input
                value={name}
                placeholder={t('notifications.namePlaceholder')}
                maxLength={200}
                aria-invalid={problems.has('name') || undefined}
                onChange={(change) => setName(change.target.value)}
                data-testid="rule-name"
              />
              {error('name', t('notifications.nameRequired'))}
            </label>

            <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
              {t('notifications.event')}
              <Select
                value={eventKey}
                onChange={(change) => setEventKey(change.target.value)}
                data-testid="rule-event"
              >
                {events.map((candidate) => (
                  <option key={candidate.key} value={candidate.key}>
                    {candidate.label}
                  </option>
                ))}
              </Select>
              {event && (
                <span className="text-xs text-[var(--text-muted)]">{event.description}</span>
              )}
            </label>
          </NotificationSection>

          {(event?.subjectLabel || keptPeople.length > 0 || problems.has('recipients')) && (
            <NotificationSection>
              {event?.subjectLabel && (
                <div
                  className="flex items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3"
                  data-testid="rule-recipient"
                >
                  <i
                    className="ti ti-user-check text-lg text-[var(--fill-accent)]"
                    aria-hidden="true"
                  />
                  <div className="flex flex-col text-sm text-[var(--text-primary)]">
                    {event.subjectLabel}
                    <span className="text-xs text-[var(--text-muted)]">
                      {t('notifications.subjectHint')}
                    </span>
                  </div>
                </div>
              )}
              {keptPeople.length > 0 && (
                <p className="text-xs text-[var(--text-muted)]" data-testid="rule-kept-people">
                  {t('notifications.recipientsKept', { count: keptPeople.length })}
                </p>
              )}
              {error('recipients', t('notifications.recipientRequired'))}
            </NotificationSection>
          )}

          <NotificationSection
            action={
              <div
                role="tablist"
                aria-label={t('notifications.stepWhat')}
                className="flex gap-1 rounded-lg bg-[var(--surface-1)] p-1"
              >
                {(['edit', 'preview'] as const).map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={view === id}
                    onClick={() => setView(id)}
                    data-testid={`rule-tab-${id}`}
                    className={cn(
                      'rounded-md px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fill-accent)]',
                      view === id
                        ? 'bg-[var(--surface-2)] text-[var(--text-primary)] shadow-sm'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]',
                    )}
                  >
                    {id === 'edit' ? t('notifications.tabEdit') : t('notifications.previewTitle')}
                  </button>
                ))}
              </div>
            }
          >
            {view === 'edit' ? (
              <>
                <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                  <span className="flex items-center justify-between gap-2">
                    {t('notifications.subjectField')}
                    <span className="text-xs text-[var(--text-muted)]">
                      {subject.length}/{SUBJECT_LIMIT}
                    </span>
                  </span>
                  <Input
                    value={subject}
                    maxLength={SUBJECT_LIMIT}
                    placeholder={t('notifications.defaultPrefix', {
                      text: event?.defaultSubject ?? '',
                    })}
                    onFocus={() => setTarget('subject')}
                    onChange={(change) => setSubject(change.target.value)}
                    data-testid="rule-subject"
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                  <span className="flex items-center justify-between gap-2">
                    {t('notifications.messageField')}
                    <span className="text-xs text-[var(--text-muted)]">
                      {message.length}/{MESSAGE_LIMIT}
                    </span>
                  </span>
                  <Textarea
                    value={message}
                    maxLength={MESSAGE_LIMIT}
                    rows={6}
                    placeholder={t('notifications.defaultPrefix', {
                      text: event?.defaultMessage ?? '',
                    })}
                    onFocus={() => setTarget('message')}
                    onChange={(change) => setMessage(change.target.value)}
                    data-testid="rule-message"
                  />
                </label>

                {(event?.placeholders.length ?? 0) > 0 && (
                  <div className="flex flex-col gap-2">
                    <span className="text-xs text-[var(--text-muted)]">
                      {t('notifications.variablesTitle', {
                        field:
                          target === 'subject'
                            ? t('notifications.subjectField')
                            : t('notifications.messageField'),
                      })}
                    </span>
                    <div className="flex flex-wrap gap-1.5" data-testid="rule-variables">
                      {event!.placeholders.map((variable) => (
                        <button
                          key={variable}
                          type="button"
                          onClick={() => insertVariable(variable)}
                          data-testid={`rule-variable-${variable}`}
                          className="rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 font-mono text-xs text-[var(--text-secondary)] transition-colors hover:border-[var(--fill-accent)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fill-accent)]"
                        >
                          {`{{${variable}}}`}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <div
                  className="flex min-h-40 flex-col gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-5"
                  data-testid="rule-preview"
                >
                  <p className="text-sm font-semibold text-[var(--text-primary)]">
                    {previewSubject}
                  </p>
                  <p className="whitespace-pre-wrap text-sm text-[var(--text-secondary)]">
                    {previewMessage}
                  </p>
                </div>
                <span className="text-xs text-[var(--text-muted)]">
                  {t('notifications.previewHint')}
                </span>
              </>
            )}
          </NotificationSection>

          {saveError && (
            <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {saveError}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] px-6 py-4">
          <label className="flex items-center gap-3 text-sm text-[var(--text-primary)]">
            <Switch
              checked={enabled}
              onChange={(change) => setEnabled(change.target.checked)}
              data-testid="rule-enabled"
            />
            {t('notifications.enabledField')}
          </label>
          <div className="flex gap-3">
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
              {t('notifications.cancel')}
            </Button>
            <Button type="submit" isLoading={saving} data-testid="rule-save">
              {saving ? t('notifications.saving') : t('notifications.save')}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
