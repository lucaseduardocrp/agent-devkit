import { useEffect, useState } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import { cn } from '../../lib/utils.js';
import { AdkCliInstall } from './AdkCliInstall.js';
import type { E2eLocalRunner } from './e2e-types.js';

const POLL_MS = 5_000;

export interface E2eLocalRunnerPanelProps {
  readonly apiClient: Pick<ApiClient, 'getE2eRunners' | 'apiUrl'>;
  /** Known when editing: shows how to start this run from the terminal. */
  readonly creationId?: string;
}

function Command({ children }: { readonly children: string }) {
  return (
    <code className="block select-all break-all rounded bg-[var(--surface-1)] p-2 font-mono text-[var(--text-primary)]">
      {children}
    </code>
  );
}

/**
 * Shows whether the user's computer is connected through `devkit runner` and how to connect
 * it. Local runs wait for that runner: it executes the browser and sends the evidence to ADK.
 */
export function E2eLocalRunnerPanel({ apiClient, creationId }: E2eLocalRunnerPanelProps) {
  const { t } = useI18n();
  const [runners, setRunners] = useState<readonly E2eLocalRunner[] | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const load = () =>
      apiClient
        .getE2eRunners(controller.signal)
        .then((items) => {
          if (active) setRunners(items);
        })
        .catch(() => {
          if (active) setRunners((current) => current ?? []);
        });
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [apiClient]);

  const online = (runners ?? []).filter((runner) => runner.online);
  const apiUrl = new URL(apiClient.apiUrl, window.location.origin).toString().replace(/\/$/, '');

  return (
    <div className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold text-[var(--text-primary)]">
            {t('e2e.localRunnerTitle')}
          </p>
          <p className="text-xs text-[var(--text-secondary)]">{t('e2e.localRunnerHint')}</p>
        </div>
        {runners !== null && (
          <span
            role="status"
            className={cn(
              'flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
              online.length ? 'bg-green-500/10 text-green-400' : 'bg-amber-500/10 text-amber-400',
            )}
          >
            <i
              className={cn('ti', online.length ? 'ti-plug-connected' : 'ti-plug-x')}
              aria-hidden="true"
            />
            {t(online.length ? 'e2e.localRunnerOnline' : 'e2e.localRunnerOffline')}
          </span>
        )}
      </div>
      {online.length > 0 && (
        <ul className="space-y-1 text-xs text-[var(--text-secondary)]">
          {online.map((runner) => (
            <li key={runner.id} className="flex items-center gap-2">
              <i className="ti ti-device-laptop" aria-hidden="true" />
              <span className="font-medium text-[var(--text-primary)]">{runner.name}</span>
              <span>
                {runner.platform} · devkit {runner.version}
              </span>
            </li>
          ))}
        </ul>
      )}
      {runners !== null && !online.length && (
        <ol className="list-decimal space-y-2 pl-4 text-xs text-[var(--text-secondary)]">
          <li>
            <AdkCliInstall />
          </li>
          <li className="space-y-1">
            <span>{t('e2e.localRunnerLogin')}</span>
            <Command>{`devkit login --api-url ${apiUrl}`}</Command>
          </li>
          <li className="space-y-1">
            <span>{t('e2e.localRunnerStart')}</span>
            <Command>devkit runner</Command>
          </li>
        </ol>
      )}
      {creationId && (
        <div className="space-y-1 border-t border-[var(--border)] pt-3 text-xs text-[var(--text-secondary)]">
          <p>{t('e2e.localRunnerTerminal')}</p>
          <Command>{`devkit e2e run ${creationId}`}</Command>
        </div>
      )}
    </div>
  );
}
