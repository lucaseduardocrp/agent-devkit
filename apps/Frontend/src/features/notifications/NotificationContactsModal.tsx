import React, { useId, useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Modal } from '../../components/ui/modal.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { NotificationChannelDto, NotificationMemberOption } from './notification-types.js';

export interface NotificationContactsModalProps {
  readonly member: NotificationMemberOption;
  readonly channels: readonly NotificationChannelDto[];
  /** The addresses already set for this person, by channel id. */
  readonly contacts: Readonly<Record<string, string>>;
  /** Receives only the channels whose address changed; an empty text removes the address. */
  readonly onSave: (changes: Record<string, string>) => Promise<void>;
  readonly onClose: () => void;
}

/** Who the person is in ADK, and where each channel reaches them. */
export function NotificationContactsModal({
  member,
  channels,
  contacts,
  onSave,
  onClose,
}: NotificationContactsModalProps): React.JSX.Element {
  const { t } = useI18n();
  const titleId = useId();
  const [drafts, setDrafts] = useState<Record<string, string>>({ ...contacts });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = async () => {
    const changes: Record<string, string> = {};
    for (const channel of channels) {
      const next = (drafts[channel.id] ?? '').trim();
      if (next !== (contacts[channel.id] ?? '')) changes[channel.id] = next;
    }
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(changes);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : t('notifications.saveFailed'));
      setSaving(false);
    }
  };

  return (
    <Modal open onClose={onClose} labelledBy={titleId}>
      <form
        noValidate
        data-testid="notification-contacts-modal"
        className="flex max-h-[92vh] w-[min(96vw,560px)] flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)]"
        onSubmit={(submit) => {
          submit.preventDefault();
          void save();
        }}
      >
        <div className="flex items-center gap-3 border-b border-[var(--border)] px-6 py-4">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate text-lg font-semibold" data-testid="adk-name">
              {member.name}
            </h2>
            <p className="truncate text-xs text-[var(--text-secondary)]" data-testid="adk-email">
              {member.email}
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-5 overflow-y-auto p-6">
          <fieldset className="flex flex-col gap-4">
            <legend className="sr-only">{t('notifications.contactsTitle')}</legend>
            {channels.length === 0 && (
              <p className="text-sm text-[var(--text-secondary)]">
                {t('notifications.contactsNoChannels')}
              </p>
            )}
            {channels.map((channel) => (
              <label
                key={channel.id}
                className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]"
              >
                {channel.available
                  ? channel.label
                  : t('notifications.channelUnavailable', { label: channel.label })}
                <Input
                  type={channel.id === 'email' ? 'email' : 'text'}
                  value={drafts[channel.id] ?? ''}
                  maxLength={320}
                  disabled={saving}
                  placeholder={
                    channel.id === 'email'
                      ? member.email
                      : t('notifications.contactsAddressPlaceholder', { label: channel.label })
                  }
                  onChange={(change) =>
                    setDrafts((current) => ({ ...current, [channel.id]: change.target.value }))
                  }
                  data-testid={`contact-${channel.id}`}
                />
                <span className="text-xs text-[var(--text-muted)]">
                  {channel.id === 'email'
                    ? t('notifications.contactsEmailHint')
                    : t('notifications.contactsOtherHint')}
                </span>
              </label>
            ))}
          </fieldset>

          {saveError && (
            <p role="alert" className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300">
              {saveError}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-3 border-t border-[var(--border)] px-6 py-4">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            {t('notifications.cancel')}
          </Button>
          <Button type="submit" isLoading={saving} data-testid="contacts-save">
            {saving ? t('notifications.saving') : t('notifications.contactsSave')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
