import React, { useCallback, useEffect, useState } from 'react';
import { cn } from '../../lib/utils.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Badge } from '../../components/ui/badge.js';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '../../components/ui/card.js';
import type { ApiClient } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import { useActivityRunner } from '../activities/ActivityCenter.js';
import type { AgentRole, HubAgentCatalogDto, HubInstallState, HubTier } from './agent-types.js';

const HUB_REPOSITORY_URL = 'https://github.com/lucaseduardocrp/agent-devkit-hub';

const roleBadge: Record<AgentRole, 'success' | 'default' | 'pro' | 'outline'> = {
  QA: 'success',
  DOCUMENTATION: 'default',
  REFACTOR: 'pro',
  CUSTOM: 'outline',
};

export interface AgentHubPanelProps {
  readonly apiClient: ApiClient;
  readonly isReadOnly: boolean;
  readonly getRoleLabel: (role: AgentRole) => string;
  /** Called after an install or update so the catalog and the playground see the change. */
  readonly onChanged: () => Promise<void> | void;
}

/**
 * The Hub tab of the Agents page: agents from the ADK Hub and subagents of hub plugins, installed
 * into this workspace by the API (which downloads and checks every file) and updated in place.
 */
export function AgentHubPanel({
  apiClient,
  isReadOnly,
  getRoleLabel,
  onChanged,
}: AgentHubPanelProps): React.JSX.Element {
  const { t } = useI18n();
  const { runActivity } = useActivityRunner();
  const [catalog, setCatalog] = useState<HubAgentCatalogDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<AgentRole | 'ALL'>('ALL');

  const load = useCallback(async () => {
    setError(null);
    try {
      setCatalog(await apiClient.listHubAgents());
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('agents.hubUnavailable'));
    }
  }, [apiClient, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (text: string) => terms.every((term) => text.toLowerCase().includes(term));
  const agents = (catalog?.agents ?? []).filter(
    (agent) =>
      (role === 'ALL' || agent.role === role) &&
      matches([agent.name, agent.description, agent.author, agent.tags.join(' ')].join(' ')),
  );
  // Plugin subagents are installed as custom agents.
  const plugins =
    role === 'ALL' || role === 'CUSTOM'
      ? (catalog?.plugins ?? []).filter((plugin) =>
          matches(
            [
              plugin.name,
              plugin.title,
              plugin.description,
              ...plugin.agents.map((agent) => agent.name),
            ].join(' '),
          ),
        )
      : [];

  const run = async (key: string, title: string, operation: () => Promise<unknown>) => {
    setBusy(key);
    setActionError(null);
    try {
      await runActivity({ kind: 'agent', title }, operation);
      await Promise.all([load(), onChanged()]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const install = (ref: { name?: string; plugin?: string }, label: string) =>
    run(
      `install:${ref.plugin ? `${ref.plugin}/` : ''}${ref.name ?? '*'}`,
      `${t('agents.hubInstall')}: ${label}`,
      () => apiClient.installHubAgent(ref),
    );

  const update = (state: HubInstallState, version: string) => {
    const installed = state.installed;
    if (!installed || !window.confirm(t('agents.hubUpdateConfirm', { name: installed.name })))
      return;
    void run(`update:${installed.agentId}`, t('agents.hubUpdate', { version }), () =>
      apiClient.updateHubAgent(installed.agentId),
    );
  };

  const tierLabel = (tier: HubTier) =>
    t(
      tier === 'official'
        ? 'agents.hubTierOfficial'
        : tier === 'verified'
          ? 'agents.hubTierVerified'
          : 'agents.hubTierCommunity',
    );

  /** Install, installed or update, for one item. */
  const action = (state: HubInstallState, key: string, version: string, onInstall: () => void) => {
    if (state.status === 'installed') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
          <i className="ti ti-circle-check text-sm" aria-hidden="true" />
          {t('agents.hubInstalled')}
        </span>
      );
    }
    if (isReadOnly) return null;
    if (state.status === 'update-available') {
      return (
        <Button
          variant="outline"
          className="h-[36px] px-3 text-xs"
          disabled={busy !== null}
          isLoading={busy === `update:${state.installed?.agentId ?? ''}`}
          onClick={() => update(state, version)}
          data-testid={`hub-update-${key}`}
        >
          <i className="ti ti-refresh mr-1.5 text-xs" aria-hidden="true" />
          {t('agents.hubUpdate', { version })}
        </Button>
      );
    }
    return (
      <Button
        className="h-[36px] px-3 text-xs"
        disabled={busy !== null}
        isLoading={busy === `install:${key}`}
        onClick={onInstall}
        data-testid={`hub-install-${key}`}
      >
        <i className="ti ti-download mr-1.5 text-xs" aria-hidden="true" />
        {t('agents.hubInstall')}
      </Button>
    );
  };

  return (
    <div className="flex flex-col gap-6" data-testid="hub-panel">
      <p className="max-w-3xl text-sm text-[var(--text-secondary)]">{t('agents.hubSubtitle')}</p>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-1">
          {(['ALL', 'QA', 'DOCUMENTATION', 'REFACTOR', 'CUSTOM'] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={role === value ? 'default' : 'ghost'}
              aria-pressed={role === value}
              onClick={() => setRole(value)}
              className={cn(
                'h-8 px-3 text-xs font-medium',
                role === value
                  ? 'bg-[var(--fill-accent)] text-[#0d1b2c] hover:bg-[var(--fill-accent-hover)]'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
              )}
            >
              {value === 'ALL' ? t('common.all') : getRoleLabel(value)}
            </Button>
          ))}
        </div>
        <div className="w-full sm:w-72">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('agents.hubSearchPlaceholder')}
            className="text-xs"
          />
        </div>
      </div>

      {(error || actionError) && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400"
        >
          <span className="flex items-center gap-2">
            <i className="ti ti-alert-circle text-lg" aria-hidden="true" />
            {actionError ?? error}
          </span>
          {error && (
            <Button variant="outline" className="h-[36px]" onClick={() => void load()}>
              {t('common.retry')}
            </Button>
          )}
        </div>
      )}

      {!catalog && !error ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((index) => (
            <div
              key={index}
              className="h-44 animate-pulse rounded-xl border border-[var(--border)] bg-[var(--surface-2)]"
            />
          ))}
        </div>
      ) : catalog && agents.length === 0 && plugins.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--border)] p-12 text-center">
          <i className="ti ti-world-search text-4xl text-[var(--text-muted)]" aria-hidden="true" />
          <p className="mt-3 text-sm text-[var(--text-secondary)]">{t('agents.hubEmpty')}</p>
        </div>
      ) : (
        <>
          {agents.length > 0 && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {agents.map((agent) => (
                <Card
                  key={agent.name}
                  className="flex flex-col"
                  data-testid={`hub-agent-${agent.name}`}
                >
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <CardTitle className="truncate text-base">{agent.name}</CardTitle>
                        <span className="text-xs text-[var(--text-muted)]">
                          {t('agents.hubBy', { author: agent.author })} · {tierLabel(agent.tier)}
                        </span>
                      </div>
                      <Badge variant={roleBadge[agent.role]}>{getRoleLabel(agent.role)}</Badge>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      <span className="rounded bg-[var(--surface-1)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]">
                        v{agent.version}
                      </span>
                      {agent.temperature !== undefined && (
                        <span className="rounded bg-[var(--surface-1)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
                          temp {agent.temperature}
                        </span>
                      )}
                      {agent.tags.slice(0, 3).map((tag) => (
                        <span
                          key={tag}
                          className="rounded bg-[var(--surface-1)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  </CardHeader>
                  <CardContent className="flex-1 py-2">
                    <CardDescription className="line-clamp-3 text-xs">
                      {agent.description}
                    </CardDescription>
                  </CardContent>
                  <CardFooter className="flex items-center justify-between gap-2 border-t border-[var(--border)] pt-3">
                    <a
                      href={`${HUB_REPOSITORY_URL}/tree/main/agents/${agent.name}`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                    >
                      {t('agents.hubViewOnSite')}
                      <i className="ti ti-arrow-up-right text-[11px]" aria-hidden="true" />
                    </a>
                    {action(
                      agent,
                      agent.name,
                      agent.version,
                      () => void install({ name: agent.name }, agent.name),
                    )}
                  </CardFooter>
                </Card>
              ))}
            </div>
          )}

          {plugins.length > 0 && (
            <section className="flex flex-col gap-3" aria-labelledby="hub-plugin-agents">
              <div>
                <h2
                  id="hub-plugin-agents"
                  className="text-sm font-semibold text-[var(--text-primary)]"
                >
                  {t('agents.hubPluginAgents')}
                </h2>
                <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                  {t('agents.hubPluginAgentsHint')}
                </p>
              </div>
              {plugins.map((plugin) => {
                const version = plugin.version ?? plugin.sha.slice(0, 8);
                const pending = plugin.agents.filter(
                  (agent) => agent.status === 'available',
                ).length;
                return (
                  <Card key={plugin.name} data-testid={`hub-plugin-${plugin.name}`}>
                    <CardHeader className="pb-2">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <CardTitle className="text-base">{plugin.title}</CardTitle>
                          <span className="text-xs text-[var(--text-muted)]">
                            {plugin.name} · {t('agents.hubBy', { author: plugin.maintainer })} ·{' '}
                            {tierLabel(plugin.tier)} · {version}
                          </span>
                          <CardDescription className="mt-1 text-xs">
                            {plugin.description}
                          </CardDescription>
                        </div>
                        {!isReadOnly && pending > 1 && (
                          <Button
                            variant="outline"
                            className="h-[36px] px-3 text-xs"
                            disabled={busy !== null}
                            isLoading={busy === `install:${plugin.name}/*`}
                            onClick={() => void install({ plugin: plugin.name }, plugin.title)}
                          >
                            {t('agents.hubInstallAll')}
                          </Button>
                        )}
                      </div>
                    </CardHeader>
                    <CardContent className="flex flex-col divide-y divide-[var(--border)] py-0">
                      {plugin.agents.map((agent) => (
                        <div
                          key={agent.name}
                          className="flex items-center justify-between gap-3 py-2.5"
                        >
                          <span className="font-mono text-xs text-[var(--text-primary)]">
                            {agent.name}
                          </span>
                          {action(
                            agent,
                            `${plugin.name}/${agent.name}`,
                            version,
                            () =>
                              void install({ plugin: plugin.name, name: agent.name }, agent.name),
                          )}
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                );
              })}
            </section>
          )}
        </>
      )}
    </div>
  );
}
