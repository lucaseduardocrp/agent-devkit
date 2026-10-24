import React, { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Modal } from '../../components/ui/modal.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../../components/ui/card.js';
import { useI18n } from '../../lib/i18n/index.js';
import { MAX_AGENT_SKILLS, type CustomAgentDto, type HubSkillDto } from './agent-types.js';

const HUB_REPOSITORY_URL = 'https://github.com/lucaseduardocrp/agent-devkit-hub';

export interface HubSkillsPanelProps {
  readonly skills: readonly HubSkillDto[];
  /** The workspace agents a skill can be assigned to. */
  readonly agents: readonly CustomAgentDto[];
  readonly isReadOnly: boolean;
  /** Key of the running action, or null; one action at a time across the catalog. */
  readonly busy: string | null;
  /** Runs an action as an activity, then reloads the catalog and the agents. */
  readonly run: (key: string, title: string, operation: () => Promise<unknown>) => Promise<void>;
  readonly updateAgentSkills: (
    agentId: string,
    change: { readonly skills?: readonly string[]; readonly refreshSkills?: readonly string[] },
  ) => Promise<unknown>;
}

/**
 * The Skills view of the catalog: ADK Hub skills, the workspace agents that use each one, and
 * a dialog to choose which agents use it. The API copies the SKILL.md into each agent it is added to.
 */
export function HubSkillsPanel({
  skills,
  agents,
  isReadOnly,
  busy,
  run,
  updateAgentSkills,
}: HubSkillsPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const [assigning, setAssigning] = useState<HubSkillDto | null>(null);

  const tierLabel = (tier: HubSkillDto['tier']) =>
    t(
      tier === 'built-in'
        ? 'agents.hubTierBuiltIn'
        : tier === 'official'
          ? 'agents.hubTierOfficial'
          : 'agents.hubTierCommunity',
    );
  const users = (skill: HubSkillDto) =>
    agents.filter((agent) => agent.skills?.some((item) => item.name === skill.name));
  const outdated = (skill: HubSkillDto) =>
    agents.filter((agent) =>
      agent.skills?.some((item) => item.name === skill.name && item.revision !== skill.revision),
    );

  const updateCopies = (skill: HubSkillDto) =>
    void run(
      `skill-update:${skill.name}`,
      t('agents.hubSkillUpdateAgents', { version: skill.version }),
      async () => {
        for (const agent of outdated(skill)) {
          await updateAgentSkills(agent.id, { refreshSkills: [skill.name] });
        }
      },
    );

  const assign = async (skill: HubSkillDto, selected: ReadonlySet<string>) => {
    const changed = agents.filter(
      (agent) => selected.has(agent.id) !== users(skill).some((user) => user.id === agent.id),
    );
    setAssigning(null);
    if (changed.length === 0) return;
    await run(
      `skill-assign:${skill.name}`,
      `${t('agents.hubSkillAssign')}: ${skill.name}`,
      async () => {
        for (const agent of changed) {
          const names = (agent.skills ?? []).map((item) => item.name);
          await updateAgentSkills(agent.id, {
            skills: selected.has(agent.id)
              ? [...names, skill.name]
              : names.filter((name) => name !== skill.name),
          });
        }
      },
    );
  };

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {skills.map((skill) => {
          const using = users(skill);
          const stale = outdated(skill);
          return (
            <Card
              key={skill.name}
              className="flex flex-col"
              data-testid={`hub-skill-${skill.name}`}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <CardTitle className="truncate text-base">{skill.name}</CardTitle>
                    <span className="text-xs text-[var(--text-muted)]">
                      {t('agents.hubBy', { author: skill.author })} · {tierLabel(skill.tier)}
                    </span>
                  </div>
                  <i
                    className="ti ti-sparkles text-lg text-[var(--fill-accent)]"
                    aria-hidden="true"
                  />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="rounded bg-[var(--surface-1)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]">
                    v{skill.version}
                  </span>
                  {(skill.tags ?? []).slice(0, 3).map((tag) => (
                    <span
                      key={tag}
                      className="rounded bg-[var(--surface-1)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]"
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-3 py-2">
                <CardDescription className="line-clamp-3 text-xs">
                  {skill.description}
                </CardDescription>
                <div className="mt-auto">
                  <span className="text-[11px] font-medium text-[var(--text-secondary)]">
                    {t('agents.hubSkillUsedBy')}
                  </span>
                  {using.length === 0 ? (
                    <p className="text-xs text-[var(--text-muted)]">{t('agents.hubSkillUnused')}</p>
                  ) : (
                    <ul className="mt-1 flex flex-wrap gap-1.5">
                      {using.map((agent) => (
                        <li
                          key={agent.id}
                          className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[11px] text-[var(--text-primary)]"
                        >
                          {agent.name}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </CardContent>
              <CardFooter className="flex items-center justify-between gap-2 border-t border-[var(--border)] pt-3">
                {skill.tier === 'built-in' ? (
                  <span />
                ) : (
                  <a
                    href={`${HUB_REPOSITORY_URL}/tree/main/skills/${skill.name}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                  >
                    {t('agents.hubViewOnSite')}
                    <i className="ti ti-arrow-up-right text-[11px]" aria-hidden="true" />
                  </a>
                )}
                {!isReadOnly && (
                  <div className="flex flex-wrap justify-end gap-2">
                    {stale.length > 0 && (
                      <Button
                        variant="outline"
                        className="h-[36px] px-3 text-xs"
                        disabled={busy !== null}
                        isLoading={busy === `skill-update:${skill.name}`}
                        onClick={() => updateCopies(skill)}
                      >
                        <i className="ti ti-refresh mr-1.5 text-xs" aria-hidden="true" />
                        {t('agents.hubSkillUpdateAgents', { version: skill.version })}
                      </Button>
                    )}
                    <Button
                      className="h-[36px] px-3 text-xs"
                      disabled={busy !== null}
                      isLoading={busy === `skill-assign:${skill.name}`}
                      onClick={() => setAssigning(skill)}
                      data-testid={`hub-skill-assign-${skill.name}`}
                    >
                      <i className="ti ti-link mr-1.5 text-xs" aria-hidden="true" />
                      {t('agents.hubSkillAssign')}
                    </Button>
                  </div>
                )}
              </CardFooter>
            </Card>
          );
        })}
      </div>

      {assigning && (
        <AssignSkillDialog
          skill={assigning}
          agents={agents}
          initial={new Set(users(assigning).map((agent) => agent.id))}
          onCancel={() => setAssigning(null)}
          onSave={(selected) => void assign(assigning, selected)}
        />
      )}
    </>
  );
}

function AssignSkillDialog({
  skill,
  agents,
  initial,
  onCancel,
  onSave,
}: {
  readonly skill: HubSkillDto;
  readonly agents: readonly CustomAgentDto[];
  readonly initial: ReadonlySet<string>;
  readonly onCancel: () => void;
  readonly onSave: (selected: ReadonlySet<string>) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [selected, setSelected] = useState<ReadonlySet<string>>(initial);
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  return (
    <Modal open labelledBy="assign-skill-title" onClose={onCancel}>
      <div className="flex w-[min(92vw,520px)] flex-col rounded-xl border border-[var(--border)] bg-[var(--surface-1)] shadow-2xl">
        <div className="border-b border-[var(--border)] px-6 py-4">
          <h2
            id="assign-skill-title"
            className="text-base font-semibold text-[var(--text-primary)]"
          >
            {t('agents.hubSkillAssignTitle', { name: skill.name })}
          </h2>
          <p className="mt-1 text-xs text-[var(--text-secondary)]">
            {t('agents.hubSkillAssignHelp')}
          </p>
        </div>
        <div className="max-h-[50vh] overflow-y-auto px-6 py-3">
          {agents.length === 0 ? (
            <p className="py-4 text-sm text-[var(--text-muted)]">
              {t('agents.hubSkillAssignNoAgents')}
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-[var(--border)]">
              {agents.map((agent) => {
                const checked = selected.has(agent.id);
                const full =
                  !initial.has(agent.id) && (agent.skills?.length ?? 0) >= MAX_AGENT_SKILLS;
                return (
                  <li key={agent.id}>
                    <label className="flex cursor-pointer items-center gap-3 py-2.5 text-sm">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={full && !checked}
                        onChange={() => toggle(agent.id)}
                        className="h-4 w-4 accent-[var(--fill-accent)]"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[var(--text-primary)]">
                          {agent.name}
                        </span>
                        <span className="block text-[11px] text-[var(--text-muted)]">
                          {full
                            ? t('agents.hubSkillAssignFull', { count: MAX_AGENT_SKILLS })
                            : t('agents.skillsCount', { count: agent.skills?.length ?? 0 })}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="flex items-center justify-end gap-3 border-t border-[var(--border)] px-6 py-4">
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button type="button" disabled={agents.length === 0} onClick={() => onSave(selected)}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
