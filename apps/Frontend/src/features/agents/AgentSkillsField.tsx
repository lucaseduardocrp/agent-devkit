import React from 'react';
import { cn } from '../../lib/utils.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Select } from '../../components/ui/select.js';
import { useI18n } from '../../lib/i18n/index.js';
import { MAX_AGENT_SKILLS, type AgentSkillDto, type HubSkillDto } from './agent-types.js';

export interface AgentSkillsFieldProps {
  /** Skill names the agent will use, in order. */
  readonly value: readonly string[];
  readonly onChange: (names: readonly string[]) => void;
  /** Skills to copy again from the hub when the agent is saved. */
  readonly refresh: readonly string[];
  readonly onRefreshChange: (names: readonly string[]) => void;
  /** The copies the saved agent has, to tell which ones the hub has a newer version of. */
  readonly attached: readonly AgentSkillDto[];
  /** null while loading; an empty list when the hub offers none. */
  readonly catalog: readonly HubSkillDto[] | null;
  readonly catalogError: boolean;
}

/** Picks the ADK Hub skills an agent uses; the API copies each SKILL.md when the agent is saved. */
export function AgentSkillsField({
  value,
  onChange,
  refresh,
  onRefreshChange,
  attached,
  catalog,
  catalogError,
}: AgentSkillsFieldProps): React.JSX.Element {
  const { t } = useI18n();
  const hub = (name: string) => catalog?.find((skill) => skill.name === name);
  const addable = (catalog ?? []).filter((skill) => !value.includes(skill.name));
  const full = value.length >= MAX_AGENT_SKILLS;

  return (
    <div>
      <label
        htmlFor="agent-skill-add"
        className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
      >
        {t('agents.skillsLabel')}
      </label>
      {value.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2" aria-label={t('agents.skillsLabel')}>
          {value.map((name) => {
            const copy = attached.find((skill) => skill.name === name);
            const current = hub(name);
            const newer =
              copy && current && current.revision !== copy.revision ? current : undefined;
            const queued = refresh.includes(name);
            return (
              <li
                key={name}
                title={copy?.description ?? current?.description}
                className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-2)] py-1 pl-2.5 pr-1 text-xs"
              >
                <i className="ti ti-sparkles text-[var(--fill-accent)]" aria-hidden="true" />
                <span className="font-mono text-[var(--text-primary)]">{name}</span>
                {(copy ?? current) && (
                  <span className="text-[var(--text-muted)]">{(copy ?? current)!.version}</span>
                )}
                {newer && (
                  <button
                    type="button"
                    aria-pressed={queued}
                    onClick={() =>
                      onRefreshChange(
                        queued ? refresh.filter((item) => item !== name) : [...refresh, name],
                      )
                    }
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[11px] font-medium',
                      queued
                        ? 'bg-[var(--fill-accent)] text-[#0d1b2c]'
                        : 'text-[var(--fill-accent)] hover:underline',
                    )}
                  >
                    {queued
                      ? t('agents.skillsUpdateQueued')
                      : t('agents.skillsUpdate', { version: newer.version })}
                  </button>
                )}
                <IconButton
                  icon={<i className="ti ti-x text-sm" aria-hidden="true" />}
                  label={t('agents.skillsRemove', { name })}
                  onClick={() => {
                    onChange(value.filter((item) => item !== name));
                    onRefreshChange(refresh.filter((item) => item !== name));
                  }}
                  size="sm"
                />
              </li>
            );
          })}
        </ul>
      )}
      <Select
        id="agent-skill-add"
        value=""
        disabled={full || !catalog || addable.length === 0}
        onChange={(event) => {
          if (event.target.value) onChange([...value, event.target.value]);
        }}
      >
        <option value="">{t('agents.skillsAdd')}</option>
        {addable.map((skill) => (
          <option key={skill.name} value={skill.name}>
            {skill.name} —{' '}
            {skill.description.length > 90
              ? `${skill.description.slice(0, 90)}…`
              : skill.description}
          </option>
        ))}
      </Select>
      <p className="mt-1 text-xs text-[var(--text-muted)]">
        {catalogError
          ? t('agents.skillsUnavailable')
          : full
            ? t('agents.skillsLimit', { count: MAX_AGENT_SKILLS })
            : t('agents.skillsHelp')}
      </p>
    </div>
  );
}
