import React, { useId } from 'react';
import { Switch } from '../../components/ui/switch.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { NotificationChannelDto } from './notification-types.js';

export interface ChannelPickerProps {
  readonly channels: readonly NotificationChannelDto[];
  readonly selected: readonly string[];
  readonly disabled?: boolean;
  readonly invalid?: boolean;
  readonly onChange: (selected: string[]) => void;
}

/**
 * Which channels to use. A channel that is not set up can still be picked: the rule or the node
 * keeps working as soon as it is, and says so until then.
 */
export function ChannelPicker({
  channels,
  selected,
  disabled = false,
  invalid = false,
  onChange,
}: ChannelPickerProps): React.JSX.Element {
  const { t } = useI18n();
  const groupId = useId();
  // A channel the rule names but the server no longer has stays visible, so it can be removed.
  const known = new Set(channels.map((channel) => channel.id));
  const options: readonly NotificationChannelDto[] = [
    ...channels,
    ...selected.filter((id) => !known.has(id)).map((id) => ({ id, label: id, available: false })),
  ];

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);

  return (
    <div
      role="group"
      aria-labelledby={groupId}
      aria-invalid={invalid || undefined}
      className="flex flex-wrap gap-2"
      data-testid="channel-picker"
    >
      <span id={groupId} className="sr-only">
        {t('notifications.channels')}
      </span>
      {options.map((channel) => (
        <label
          key={channel.id}
          className={cn(
            'flex cursor-pointer items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text-primary)] transition-colors',
            'has-[:checked]:border-[var(--fill-accent)]',
            disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          {channel.available
            ? channel.label
            : t('notifications.channelUnavailable', { label: channel.label })}
          <Switch
            checked={selected.includes(channel.id)}
            disabled={disabled}
            onChange={() => toggle(channel.id)}
            data-testid={`channel-${channel.id}`}
          />
        </label>
      ))}
    </div>
  );
}
