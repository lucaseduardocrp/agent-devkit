import React from 'react';
import { cn } from '../../lib/utils.js';
import { Input } from '../../components/ui/input.js';
import { MultiSelect } from '../../components/ui/multi-select.js';
import { Switch } from '../../components/ui/switch.js';
import { Textarea } from '../../components/ui/textarea.js';
import { useI18n } from '../../lib/i18n/index.js';
import { ChannelPicker } from './ChannelPicker.js';
import { NotificationSection as Section } from './NotificationSection.js';
import {
  EMPTY_NOTIFICATION_CONFIG,
  type NotificationNodeConfig,
  type NotificationOptions,
} from './notification-types.js';

export interface NotificationActionEditorProps {
  readonly value: NotificationNodeConfig | undefined;
  readonly options: NotificationOptions;
  readonly disabled: boolean;
  readonly onChange: (next: NotificationNodeConfig) => void;
}

const ROLES = [
  ['assignee', 'notifications.roleAssignee', 'ti-user-check'],
  ['proofreader', 'notifications.roleProofreader', 'ti-eye-check'],
] as const;

const SUBJECT_LIMIT = 200;
const MESSAGE_LIMIT = 5000;

/** The settings of a `notifications_send` action: channels, people and roles, and the words. */
export function NotificationActionEditor({
  value,
  options,
  disabled,
  onChange,
}: NotificationActionEditorProps): React.JSX.Element {
  const { t } = useI18n();
  const config = value ?? EMPTY_NOTIFICATION_CONFIG;
  const set = (patch: Partial<NotificationNodeConfig>) => onChange({ ...config, ...patch });

  // Someone who left the workspace stays in the list, so the node shows who it used to tell.
  const memberOptions = [
    ...options.members.map((member) => ({
      value: member.userId,
      label: member.name,
      description: member.email,
    })),
    ...config.userIds
      .filter((id) => !options.members.some((member) => member.userId === id))
      .map((id) => ({ value: id, label: t('notifications.unknownPerson'), description: id })),
  ];

  return (
    <div className="flex flex-col gap-4" data-testid="notification-action-editor">
      {options.failed && (
        <p role="status" className="text-xs text-amber-300">
          {t('notifications.nodeOptionsUnavailable')}
        </p>
      )}

      <div className="flex flex-col gap-6">
        <Section title={t('notifications.nodeChannels')}>
          <ChannelPicker
            channels={options.channels}
            selected={config.channels}
            disabled={disabled}
            invalid={config.channels.length === 0}
            onChange={(channels) => set({ channels })}
          />
          {config.channels.length === 0 && (
            <span className="text-xs text-amber-300">{t('notifications.nodeNeedsChannel')}</span>
          )}
        </Section>

        <Section title={t('notifications.nodeWho')}>
          <fieldset className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
            <legend className="mb-2">{t('notifications.nodeRoles')}</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {ROLES.map(([role, label, icon]) => (
                <label
                  key={role}
                  className={cn(
                    'flex cursor-pointer items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5 text-[var(--text-primary)] transition-colors',
                    'has-[:checked]:border-[var(--fill-accent)]',
                    disabled && 'cursor-not-allowed opacity-60',
                  )}
                >
                  <i className={cn('ti text-base', icon)} aria-hidden="true" />
                  <span className="flex-1">{t(label)}</span>
                  <Switch
                    checked={config.roles.includes(role)}
                    disabled={disabled}
                    onChange={(change) =>
                      set({
                        roles: change.target.checked
                          ? [...config.roles, role]
                          : config.roles.filter((item) => item !== role),
                      })
                    }
                    data-testid={`node-role-${role}`}
                  />
                </label>
              ))}
            </div>
          </fieldset>

          <div className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
            <span>{t('notifications.nodePeople')}</span>
            <MultiSelect
              options={memberOptions}
              values={config.userIds}
              onChange={(userIds) => set({ userIds })}
              label={t('notifications.peopleLabel')}
              placeholder={t('notifications.peoplePlaceholder')}
              emptyMessage={t('notifications.peopleEmpty')}
              disabled={disabled}
            />
            {config.userIds.length === 0 && config.roles.length === 0 && (
              <span className="text-xs text-amber-300">{t('notifications.nodeNeedsPeople')}</span>
            )}
          </div>
        </Section>

        <Section title={t('notifications.nodeWhat')}>
          <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
            <span className="flex items-center justify-between gap-2">
              {t('notifications.nodeSubject')}
              <span className="text-xs text-[var(--text-muted)]">
                {config.subject.length}/{SUBJECT_LIMIT}
              </span>
            </span>
            <Input
              value={config.subject}
              maxLength={SUBJECT_LIMIT}
              disabled={disabled}
              placeholder="Issue #{{issue.number}}: {{issue.title}}"
              onChange={(change) => set({ subject: change.target.value })}
              data-testid="node-subject"
            />
          </label>
          <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
            <span className="flex items-center justify-between gap-2">
              {t('notifications.nodeMessage')}
              <span className="text-xs text-[var(--text-muted)]">
                {config.message.length}/{MESSAGE_LIMIT}
              </span>
            </span>
            <Textarea
              value={config.message}
              maxLength={MESSAGE_LIMIT}
              rows={4}
              disabled={disabled}
              placeholder={t('notifications.nodeMessagePlaceholder')}
              onChange={(change) => set({ message: change.target.value })}
              data-testid="node-message"
            />
          </label>
          <p className="text-xs text-[var(--text-muted)]">{t('notifications.nodeVariablesHint')}</p>
        </Section>
      </div>
    </div>
  );
}
