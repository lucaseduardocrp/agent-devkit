import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Select } from '../../components/ui/select.js';
import { useI18n } from '../../lib/i18n/index.js';
import type {
  ApiClient,
  DesignBranchDto,
  DesignRepositoryDto,
  DesignSettingsDto,
} from '../../lib/api-client.js';

const PROVIDER_LABELS: Readonly<Record<DesignRepositoryDto['provider'], string>> = {
  github: 'GitHub',
  azure: 'Azure DevOps',
};
/** A repository is addressed by its provider and id, which the option value carries together. */
const optionValue = (repository: { provider: string; id: string }) =>
  `${repository.provider}:${repository.id}`;
const savedValue = (settings: DesignSettingsDto) => `${settings.provider}:${settings.repositoryId}`;

export interface DesignRepositoryPickerProps {
  readonly apiClient: ApiClient;
  readonly isReadOnly?: boolean;
  readonly onSaved: (settings: DesignSettingsDto) => void;
  readonly onError: (message: string) => void;
  readonly onManageIntegrations?: () => void;
}

/**
 * Repository and branch the Design module works in, chosen among the repositories of every
 * connected provider.
 */
export function DesignRepositoryPicker({
  apiClient,
  isReadOnly = false,
  onSaved,
  onError,
  onManageIntegrations,
}: DesignRepositoryPickerProps) {
  const { t } = useI18n();
  const [repositories, setRepositories] = useState<readonly DesignRepositoryDto[]>([]);
  const [branches, setBranches] = useState<readonly DesignBranchDto[]>([]);
  const [saved, setSaved] = useState<DesignSettingsDto | null>(null);
  const [selection, setSelection] = useState('');
  const [branch, setBranch] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([apiClient.getDesignRepositories(), apiClient.getDesignSettings()])
      .then(([list, settings]) => {
        if (!active) return;
        setRepositories(list.repositories);
        setSaved(settings);
        if (settings) {
          setSelection(savedValue(settings));
          setBranch(settings.branch);
        }
      })
      .catch((error: unknown) => {
        if (active)
          onError(error instanceof Error ? error.message : t('design.repositoriesLoadFailed'));
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
    // The callbacks are recreated on every render of the view; reloading is driven by the client.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiClient]);

  const chosen = repositories.find((item) => optionValue(item) === selection);

  useEffect(() => {
    if (!chosen) {
      setBranches([]);
      return;
    }
    let active = true;
    setLoadingBranches(true);
    apiClient
      .getDesignBranches(chosen.provider, chosen.id)
      .then((list) => {
        if (!active) return;
        setBranches(list);
        // Keep the saved branch while it still exists; otherwise follow the repository default.
        setBranch((current) =>
          list.some((item) => item.name === current)
            ? current
            : (list.find((item) => item.isDefault)?.name ?? chosen.defaultBranch),
        );
      })
      .catch(() => active && setBranches([]))
      .finally(() => active && setLoadingBranches(false));
    return () => {
      active = false;
    };
  }, [apiClient, chosen]);

  const save = async () => {
    // Its only caller is the Save button below, which is disabled whenever there is no chosen
    // repository, so this never actually runs - it only keeps `chosen` narrowed for TypeScript.
    /* v8 ignore next */
    if (!chosen) return;
    setSaving(true);
    try {
      const settings = await apiClient.saveDesignSettings({
        provider: chosen.provider,
        repositoryId: chosen.id,
        branch,
      });
      setSaved(settings);
      onSaved(settings);
    } catch (error) {
      onError(error instanceof Error ? error.message : t('design.repositorySaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const isDirty = !saved || savedValue(saved) !== selection || saved.branch !== branch;

  return (
    <div data-testid="design-repository-picker">
      <label htmlFor="design-repository" className="mb-1.5 block text-sm font-medium">
        {t('design.repository')}
      </label>
      <Select
        id="design-repository"
        value={selection}
        disabled={isReadOnly || loading || repositories.length === 0}
        onChange={(event) => setSelection(event.target.value)}
      >
        <option value="">
          {loading
            ? t('common.loading')
            : repositories.length === 0
              ? t('runtime.configureIntegration')
              : t('design.chooseRepository')}
        </option>
        {repositories.map((repository) => (
          <option key={optionValue(repository)} value={optionValue(repository)}>
            {PROVIDER_LABELS[repository.provider]} · {repository.name}
          </option>
        ))}
      </Select>

      <label htmlFor="design-branch" className="mt-3 mb-1.5 block text-sm font-medium">
        {t('design.branch')}
      </label>
      <Select
        id="design-branch"
        value={branch}
        disabled={isReadOnly || !chosen || loadingBranches}
        onChange={(event) => setBranch(event.target.value)}
      >
        {!chosen && <option value="">{t('design.chooseRepositoryFirst')}</option>}
        {chosen && loadingBranches && <option value={branch}>{t('common.loading')}</option>}
        {chosen &&
          !loadingBranches &&
          (branches.length > 0
            ? branches
            : [{ name: branch || chosen.defaultBranch, isDefault: true }]
          ).map((item) => (
            <option key={item.name} value={item.name}>
              {item.name}
            </option>
          ))}
      </Select>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!isReadOnly && (
          <Button
            size="sm"
            onClick={() => void save()}
            disabled={!chosen || !isDirty}
            isLoading={saving}
          >
            <i className="ti ti-device-floppy" aria-hidden="true" /> {t('design.saveRepository')}
          </Button>
        )}
        {onManageIntegrations && (
          <Button size="sm" variant="ghost" onClick={onManageIntegrations}>
            <i className="ti ti-settings" aria-hidden="true" /> {t('design.manageRepositories')}
          </Button>
        )}
      </div>
    </div>
  );
}
