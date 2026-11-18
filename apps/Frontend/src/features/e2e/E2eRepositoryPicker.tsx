import { useEffect, useState } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { TranslationKey } from '../../lib/i18n/types.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { SearchableSelect } from '../../components/ui/searchable-select.js';
import { Select } from '../../components/ui/select.js';
import { desktopDevelopment, type DesktopDevelopmentBridge } from '../../lib/desktop.js';
import type {
  E2eBranch,
  E2eRepository,
  E2eRepositoryProvider,
  E2eRepositoryWarning,
} from './e2e-types.js';

export interface E2eRepositorySelection {
  readonly provider: E2eRepositoryProvider | '';
  readonly id: string;
  readonly branch: string;
  readonly path: string;
  /** "owner/repo" or "Project/Repo", set when a repository is picked. */
  readonly name?: string;
}

const providerLabels: Record<E2eRepositoryProvider, string> = {
  github: 'GitHub',
  azure_devops: 'Azure DevOps',
  local: 'Local',
};
const warningKeys: Record<E2eRepositoryWarning['code'], TranslationKey> = {
  CREDENTIALS_MISSING: 'e2e.repoWarningCredentials',
  CREDENTIALS_UNREADABLE: 'e2e.repoWarningUnreadable',
  NOT_CONFIGURED: 'e2e.repoWarningNotConfigured',
  PROVIDER_UNAVAILABLE: 'e2e.repoWarningUnavailable',
};

/** The folder field reads as the place of E2E scripts unless the caller names it otherwise. */
export interface RepositoryPathLabels {
  readonly label: string;
  readonly placeholder: string;
  readonly hint: string;
}

export function E2eRepositoryPicker({
  apiClient,
  value,
  invalid,
  onChange,
  onPathChange,
  onOpenIntegrations,
  source = 'e2e',
  pathLabels,
  disabled = false,
}: {
  readonly apiClient: ApiClient;
  readonly value: E2eRepositorySelection;
  readonly invalid: boolean;
  readonly onChange: (value: E2eRepositorySelection) => void;
  readonly onPathChange: (path: string) => void;
  readonly onOpenIntegrations?: () => void;
  /** Which module's routes list the repositories (each checks its own permission). */
  readonly source?: 'e2e' | 'integrationTests';
  readonly pathLabels?: RepositoryPathLabels;
  readonly disabled?: boolean;
}) {
  const { t } = useI18n();
  const [repositories, setRepositories] = useState<readonly E2eRepository[] | null>(null);
  const [warnings, setWarnings] = useState<readonly E2eRepositoryWarning[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [branches, setBranches] = useState<readonly E2eBranch[] | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [folderError, setFolderError] = useState<string | null>(null);
  // In the desktop app the specs can also live in a project folder of this computer.
  const desktop = source === 'e2e' ? desktopDevelopment() : undefined;

  useEffect(() => {
    let active = true;
    (source === 'e2e' ? apiClient.getE2eRepositories() : apiClient.listApiTestRepositories())
      .then((result) => {
        if (!active) return;
        setRepositories(result.repositories);
        setWarnings(result.warnings);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setRepositories([]);
        setLoadError(error instanceof Error ? error.message : t('e2e.repoLoadFailed'));
      });
    return () => {
      active = false;
    };
  }, [apiClient, source, t]);

  const { provider, id } = value;
  const isLocal = provider === 'local';
  useEffect(() => {
    if (!provider || !id) {
      setBranches(null);
      return;
    }
    let active = true;
    setBranches(null);
    setBranchError(null);
    (source === 'e2e'
      ? apiClient.getE2eBranches(provider, id)
      : apiClient.listApiTestBranches(provider, id)
    )
      .then((list) => {
        if (active) setBranches(list);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setBranches([]);
        setBranchError(error instanceof Error ? error.message : t('e2e.branchLoadFailed'));
      });
    return () => {
      active = false;
    };
  }, [apiClient, provider, id, source, t]);

  // Default to the repository's default branch once its branches are known.
  const selected = repositories?.find((repo) => repo.provider === provider && repo.id === id);
  // One flat list for the searchable select; when both hosts are connected the label says which
  // one a repository is on.
  const hosts = new Set((repositories ?? []).map((repo) => repo.provider));
  const repositoryOptions = (repositories ?? []).map((repo) => ({
    value: `${repo.provider}:${repo.id}`,
    label: hosts.size > 1 ? `${repo.name} (${providerLabels[repo.provider]})` : repo.name,
  }));
  useEffect(() => {
    if (
      (!selected && !isLocal) ||
      !branches ||
      branches.some((branch) => branch.name === value.branch)
    )
      return;
    const fallback =
      branches.find((branch) => branch.isDefault)?.name ??
      branches[0]?.name ??
      selected?.defaultBranch ??
      'local';
    if (fallback !== value.branch) onChange({ ...value, branch: fallback });
  }, [branches, isLocal, onChange, selected, value]);

  const selectRepository = (key: string) => {
    // The select only offers repositories of the loaded list.
    const repository = repositories!.find((repo) => `${repo.provider}:${repo.id}` === key)!;
    // Start on the default branch the select already shows, so the form is valid while
    // the branch list is still loading.
    onChange({
      ...value,
      provider: repository.provider,
      id: repository.id,
      branch: repository.defaultBranch,
      name: repository.name,
    });
  };

  const branchOptions =
    branches && branches.length
      ? branches
      : selected
        ? [{ name: selected.defaultBranch, isDefault: true }]
        : isLocal && value.branch
          ? [{ name: value.branch, isDefault: true }]
          : [];

  // The folder is picked in the native dialog; its branch is read by the effect above.
  const chooseFolder = async (bridge: DesktopDevelopmentBridge) => {
    const picked = await bridge.pickFolder();
    if (!picked.ok) return setFolderError(picked.error);
    if (!picked.path) return;
    setFolderError(null);
    onChange({
      ...value,
      provider: 'local',
      id: picked.path,
      branch: '',
      name: picked.path.split(/[\\/]/).filter(Boolean).pop() ?? picked.path,
    });
  };

  return (
    <div className="flex flex-col gap-4" data-testid="e2e-repository-picker">
      <div className="flex flex-col gap-1.5 text-sm text-[var(--text-secondary)]">
        {t('e2e.repository')}
        {/* Search and paged scrolling live in the select itself, like the other long lists. */}
        <SearchableSelect
          label={t('e2e.repository')}
          options={repositoryOptions}
          value={provider && id && !isLocal ? `${provider}:${id}` : ''}
          onChange={selectRepository}
          placeholder={repositories ? t('e2e.repositoryPlaceholder') : t('e2e.repositoryLoading')}
          emptyMessage={t('e2e.repositoryNoMatch')}
          disabled={disabled || !repositories?.length}
          {...(invalid ? { className: 'border-red-500/50 bg-red-500/10' } : {})}
        />
        {repositories && repositories.length > 0 && (
          <span className="text-xs text-[var(--text-muted)]">
            {t('e2e.repositoryCount', { count: repositories.length })}
          </span>
        )}
      </div>
      {desktop && (
        <div
          className="flex flex-col gap-1.5 text-sm text-[var(--text-secondary)]"
          data-testid="e2e-local-folder"
        >
          {t('e2e.localFolder')}
          <div className="flex gap-2">
            <Input
              aria-label={t('e2e.localFolder')}
              value={isLocal ? id : ''}
              readOnly
              placeholder={t('e2e.localFolderPlaceholder')}
            />
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() => void chooseFolder(desktop)}
            >
              <i className="ti ti-folder-open" aria-hidden="true" /> {t('e2e.chooseLocalFolder')}
            </Button>
          </div>
          <span className="text-xs text-[var(--text-muted)]">{t('e2e.localFolderHint')}</span>
          {folderError && (
            <span className="text-xs text-red-400" role="alert">
              {folderError}
            </span>
          )}
        </div>
      )}
      {invalid && (
        <p className="-mt-2 text-xs text-red-400" role="alert">
          {t('e2e.validationRepository')}
        </p>
      )}
      {repositories && repositories.length === 0 && (
        <p className="text-sm text-amber-400">
          {loadError ?? t('e2e.noRepositories')}{' '}
          {onOpenIntegrations && (
            <Button variant="link" size="sm" className="h-auto p-0" onClick={onOpenIntegrations}>
              {t('nav.connect')}
            </Button>
          )}
        </p>
      )}
      {warnings.map((warning) => (
        <p key={warning.provider} className="text-xs text-amber-400">
          {providerLabels[warning.provider]}: {t(warningKeys[warning.code])}
        </p>
      ))}

      <label className="flex flex-col gap-1.5 text-sm text-[var(--text-secondary)]">
        {t('e2e.baseBranch')}
        <Select
          aria-label={t('e2e.baseBranch')}
          value={value.branch}
          onChange={(event) => onChange({ ...value, branch: event.target.value })}
          disabled={disabled || !selected || branches === null}
        >
          {selected && branches === null && <option value="">{t('e2e.branchLoading')}</option>}
          {branchOptions.map((branch) => (
            <option key={branch.name} value={branch.name}>
              {branch.name}
            </option>
          ))}
        </Select>
      </label>
      {branchError && <p className="-mt-2 text-xs text-red-400">{branchError}</p>}

      <label className="flex flex-col gap-1.5 text-sm text-[var(--text-secondary)]">
        {pathLabels?.label ?? t('e2e.scriptPath')}
        <Input
          aria-label={pathLabels?.label ?? t('e2e.scriptPath')}
          value={value.path}
          placeholder={pathLabels?.placeholder ?? t('e2e.scriptPathPlaceholder')}
          disabled={disabled}
          onChange={(event) => onPathChange(event.target.value)}
        />
        <span className="text-xs text-[var(--text-muted)]">
          {pathLabels?.hint ?? t('e2e.scriptPathHint')}
        </span>
      </label>
    </div>
  );
}
