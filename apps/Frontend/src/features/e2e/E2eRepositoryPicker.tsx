import { useEffect, useState } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { TranslationKey } from '../../lib/i18n/types.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
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
}

const providerLabels: Record<E2eRepositoryProvider, string> = {
  github: 'GitHub',
  azure_devops: 'Azure DevOps',
};
const warningKeys: Record<E2eRepositoryWarning['code'], TranslationKey> = {
  CREDENTIALS_MISSING: 'e2e.repoWarningCredentials',
  NOT_CONFIGURED: 'e2e.repoWarningNotConfigured',
  PROVIDER_UNAVAILABLE: 'e2e.repoWarningUnavailable',
};

export function E2eRepositoryPicker({
  apiClient,
  value,
  invalid,
  onChange,
  onPathChange,
  onOpenIntegrations,
}: {
  readonly apiClient: ApiClient;
  readonly value: E2eRepositorySelection;
  readonly invalid: boolean;
  readonly onChange: (value: E2eRepositorySelection) => void;
  readonly onPathChange: (path: string) => void;
  readonly onOpenIntegrations?: () => void;
}) {
  const { t } = useI18n();
  const [repositories, setRepositories] = useState<readonly E2eRepository[] | null>(null);
  const [warnings, setWarnings] = useState<readonly E2eRepositoryWarning[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [branches, setBranches] = useState<readonly E2eBranch[] | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    apiClient
      .getE2eRepositories()
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
  }, [apiClient, t]);

  const { provider, id } = value;
  useEffect(() => {
    if (!provider || !id) {
      setBranches(null);
      return;
    }
    let active = true;
    setBranches(null);
    setBranchError(null);
    apiClient
      .getE2eBranches(provider, id)
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
  }, [apiClient, provider, id, t]);

  // Default to the repository's default branch once its branches are known.
  const selected = repositories?.find((repo) => repo.provider === provider && repo.id === id);
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  // The native list cannot be searched, so long accounts are filtered here; the current
  // choice always stays listed so the select never loses its value.
  const visibleRepositories = (repositories ?? []).filter(
    (repo) => !query || repo.name.toLowerCase().includes(query) || repo === selected,
  );
  useEffect(() => {
    if (!selected || !branches || branches.some((branch) => branch.name === value.branch)) return;
    const fallback =
      branches.find((branch) => branch.isDefault)?.name ??
      branches[0]?.name ??
      selected.defaultBranch;
    if (fallback !== value.branch) onChange({ ...value, branch: fallback });
  }, [branches, onChange, selected, value]);

  const selectRepository = (key: string) => {
    const [nextProvider = '', ...rest] = key.split(':');
    const nextId = rest.join(':');
    const repository = repositories?.find(
      (repo) => repo.provider === nextProvider && repo.id === nextId,
    );
    // Start on the default branch the select already shows, so the form is valid while
    // the branch list is still loading.
    onChange({
      ...value,
      provider: nextProvider as E2eRepositoryProvider | '',
      id: nextId,
      branch: repository?.defaultBranch ?? '',
    });
  };

  const branchOptions =
    branches && branches.length
      ? branches
      : selected
        ? [{ name: selected.defaultBranch, isDefault: true }]
        : [];

  return (
    <div className="flex flex-col gap-4" data-testid="e2e-repository-picker">
      <label className="flex flex-col gap-1.5 text-sm text-[var(--text-secondary)]">
        {t('e2e.repository')}
        {repositories && repositories.length > 0 && (
          <Input
            type="search"
            aria-label={t('e2e.repositorySearch')}
            placeholder={t('e2e.repositorySearch')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        )}
        <Select
          aria-label={t('e2e.repository')}
          value={provider && id ? `${provider}:${id}` : ''}
          onChange={(event) => selectRepository(event.target.value)}
          disabled={!repositories?.length}
          variant={invalid ? 'error' : 'default'}
        >
          <option value="">
            {!repositories
              ? t('e2e.repositoryLoading')
              : query && !visibleRepositories.some((repo) => repo !== selected)
                ? t('e2e.repositoryNoMatch')
                : t('e2e.repositoryPlaceholder')}
          </option>
          {(['github', 'azure_devops'] as const).map((group) => {
            const items = visibleRepositories.filter((repo) => repo.provider === group);
            return items.length ? (
              <optgroup key={group} label={providerLabels[group]}>
                {items.map((repo) => (
                  <option key={`${repo.provider}:${repo.id}`} value={`${repo.provider}:${repo.id}`}>
                    {repo.name}
                  </option>
                ))}
              </optgroup>
            ) : null;
          })}
        </Select>
        {repositories && repositories.length > 0 && (
          <span className="text-xs text-[var(--text-muted)]">
            {t('e2e.repositoryCount', { count: repositories.length })}
          </span>
        )}
      </label>
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
          disabled={!selected || branches === null}
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
        {t('e2e.scriptPath')}
        <Input
          aria-label={t('e2e.scriptPath')}
          value={value.path}
          placeholder={t('e2e.scriptPathPlaceholder')}
          onChange={(event) => onPathChange(event.target.value)}
        />
        <span className="text-xs text-[var(--text-muted)]">{t('e2e.scriptPathHint')}</span>
      </label>
    </div>
  );
}
