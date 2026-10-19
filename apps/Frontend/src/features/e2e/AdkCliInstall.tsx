import { useI18n } from '../../lib/i18n/index.js';

/** npm package that provides the `devkit` command (local runner, tunnels, MCP server). */
export const ADK_CLI_INSTALL = 'npm install -g @agent-devkit/cli';

/** How to install the ADK command line on the user's computer. */
export function AdkCliInstall() {
  const { t } = useI18n();
  return (
    <div className="space-y-1">
      <p>
        {t('e2e.cliInstall')}{' '}
        <a
          href="https://nodejs.org"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--text-accent)] underline underline-offset-2"
        >
          {t('e2e.cliInstallNode')}
        </a>
      </p>
      <code className="block select-all break-all rounded bg-[var(--surface-1)] p-2 font-mono text-[var(--text-primary)]">
        {ADK_CLI_INSTALL}
      </code>
      <p className="text-[var(--text-muted)]">{t('e2e.cliPowerShellHint')}</p>
    </div>
  );
}
