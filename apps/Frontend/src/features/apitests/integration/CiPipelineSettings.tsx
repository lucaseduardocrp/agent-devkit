import React, { useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { ConfirmationDialog } from '../../../components/ui/confirmation-dialog.js';
import { Select } from '../../../components/ui/select.js';
import type { ApiClient } from '../../../lib/api-client.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { E2eRepositoryPicker, type E2eRepositorySelection } from '../../e2e/E2eRepositoryPicker.js';
import {
  CI_TOOLS,
  type ApiCollection,
  type ApiEnvironment,
  type CiConfig,
  type CiPreview,
  type CiPublication,
  type CiSecret,
  type CiTool,
} from '../api-test-types.js';
import { errorText } from './file-read.js';
import { SectionTitle, SettingField } from './integration-parts.js';

/** What the Pipeline tab needs besides the collection; without it the tab is hidden. */
export interface CiPipelineContext {
  readonly apiClient: ApiClient;
  readonly environments: readonly ApiEnvironment[];
  /**
   * Saves pending edits first: the pipeline is built from the saved collection. Resolves with
   * null when saving failed (the view reports why).
   */
  readonly onSave: () => Promise<unknown>;
  readonly onOpenIntegrations?: () => void;
}

/** `a\b/c/` → `a/b/c`; null when a segment is `.` or `..` (the server refuses those). */
function normalizeFolder(path: string): string | null {
  const segments = path.trim().replace(/\\/g, '/').split('/').filter(Boolean);
  return segments.some((segment) => segment === '.' || segment === '..')
    ? null
    : segments.join('/');
}

const slug = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'collection';

/** The CI settings of the collection, complete or not at all. */
function configOf(
  selection: E2eRepositorySelection,
  tool: CiTool,
  environmentId: string,
): CiConfig | undefined {
  const path = normalizeFolder(selection.path);
  if (!selection.provider || !selection.id || !selection.branch || !path) return undefined;
  return {
    repository: {
      provider: selection.provider,
      id: selection.id,
      name: selection.name || selection.id,
      branch: selection.branch,
      path,
    },
    tool,
    environmentId: environmentId || null,
  };
}

function SecretsList({
  secrets,
  provider,
}: {
  readonly secrets: readonly CiSecret[];
  readonly provider: CiConfig['repository']['provider'];
}): React.JSX.Element {
  const { t } = useI18n();
  if (!secrets.length)
    return <p className="text-xs text-[var(--text-secondary)]">{t('apiTests.ci.noSecrets')}</p>;
  return (
    <div className="flex flex-col gap-2" data-testid="ci-secrets">
      <SectionTitle
        title={t('apiTests.ci.secretsTitle')}
        hint={t(provider === 'github' ? 'apiTests.ci.secretsGithub' : 'apiTests.ci.secretsAzure')}
      />
      <ul className="flex flex-col gap-1 text-xs">
        {secrets.map((secret) => (
          <li key={secret.name} className="font-mono text-[var(--text-primary)]">
            {secret.name}
            <span className="text-[var(--text-muted)]"> ← {secret.variable}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Repository, branch and folder where the collection lives, the tool whose runner the pipeline
 * uses, and the commit that writes both there.
 */
export function CiPipelineSettings({
  collection,
  readOnly,
  onChange,
  onError,
  context,
}: {
  readonly collection: ApiCollection;
  readonly readOnly: boolean;
  readonly onChange: (ci: CiConfig | undefined) => void;
  readonly onError: (message: string) => void;
  readonly context: CiPipelineContext;
}): React.JSX.Element {
  const { t } = useI18n();
  const { apiClient, environments, onSave, onOpenIntegrations } = context;
  const saved = collection.ci;
  // The form keeps incomplete choices; the collection only gets complete settings.
  const [selection, setSelection] = useState<E2eRepositorySelection>(() => ({
    provider: saved?.repository.provider ?? '',
    id: saved?.repository.id ?? '',
    name: saved?.repository.name ?? '',
    branch: saved?.repository.branch ?? '',
    path: saved?.repository.path ?? `api-tests/${slug(collection.name)}`,
  }));
  const [tool, setTool] = useState<CiTool>(saved?.tool ?? 'bruno');
  const [environmentId, setEnvironmentId] = useState(saved?.environmentId ?? '');
  const [preview, setPreview] = useState<CiPreview | null>(null);
  const [publication, setPublication] = useState<CiPublication | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const update = (next: {
    selection?: E2eRepositorySelection;
    tool?: CiTool;
    environmentId?: string;
  }) => {
    const nextSelection = next.selection ?? selection;
    const nextTool = next.tool ?? tool;
    const nextEnvironment = next.environmentId ?? environmentId;
    setSelection(nextSelection);
    setTool(nextTool);
    setEnvironmentId(nextEnvironment);
    setPreview(null);
    const config = configOf(nextSelection, nextTool, nextEnvironment);
    if (JSON.stringify(config) !== JSON.stringify(saved)) onChange(config);
  };

  const invalidFolder = normalizeFolder(selection.path) === null;
  const config = configOf(selection, tool, environmentId);

  const withSaved = async <T,>(action: () => Promise<T>): Promise<T | null> => {
    setBusy(true);
    let result: T | null = null;
    try {
      if (await onSave()) result = await action();
    } catch (err) {
      onError(errorText(err));
    }
    setBusy(false);
    return result;
  };

  const togglePreview = async () => {
    if (preview) {
      setPreview(null);
      return;
    }
    setPreview(await withSaved(() => apiClient.previewApiCollectionCi(collection.id)));
  };

  const publish = async () => {
    setConfirming(false);
    const result = await withSaved(() => apiClient.publishApiCollectionCi(collection.id));
    if (result) setPublication(result);
  };

  const pipelinePath = publication?.pipelinePath ?? preview?.pipelinePath;
  const secrets = publication?.secrets ?? preview?.secrets;
  const pipelineFile = preview?.files.find((file) => file.path === preview.pipelinePath);

  return (
    <div className="flex flex-col gap-6" data-testid="ci-pipeline">
      <SectionTitle title={t('apiTests.ci.title')} hint={t('apiTests.ci.intro')} />
      <E2eRepositoryPicker
        apiClient={apiClient}
        source="integrationTests"
        value={selection}
        invalid={false}
        disabled={readOnly}
        onChange={(value) => update({ selection: value })}
        onPathChange={(path) => update({ selection: { ...selection, path } })}
        onOpenIntegrations={onOpenIntegrations}
        pathLabels={{
          label: t('apiTests.ci.folder'),
          placeholder: t('apiTests.ci.folderPlaceholder'),
          hint: t('apiTests.ci.folderHint'),
        }}
      />
      {invalidFolder && (
        <p className="-mt-4 text-xs text-red-400" role="alert">
          {t('apiTests.ci.invalidFolder')}
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <SettingField label={t('apiTests.ci.tool')} hint={t(`apiTests.ci.toolHints.${tool}`)}>
          <Select
            aria-label={t('apiTests.ci.tool')}
            value={tool}
            disabled={readOnly}
            onChange={(event) => update({ tool: event.target.value as CiTool })}
          >
            {CI_TOOLS.map((item) => (
              <option key={item} value={item}>
                {t(`apiTests.ci.tools.${item}`)}
              </option>
            ))}
          </Select>
        </SettingField>
        <SettingField label={t('apiTests.ci.environment')}>
          <Select
            aria-label={t('apiTests.ci.environment')}
            value={environmentId}
            disabled={readOnly}
            onChange={(event) => update({ environmentId: event.target.value })}
          >
            <option value="">{t('apiTests.ci.noEnvironment')}</option>
            {environments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.name}
              </option>
            ))}
          </Select>
        </SettingField>
      </div>
      <p className="text-xs text-[var(--text-secondary)]">{t('apiTests.ci.credentialsNote')}</p>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={!config || busy}
          onClick={() => void togglePreview()}
        >
          <i className="ti ti-file-search" aria-hidden="true" />
          {preview ? t('apiTests.ci.hidePreview') : t('apiTests.ci.preview')}
        </Button>
        {!readOnly && (
          <Button size="sm" disabled={!config || busy} onClick={() => setConfirming(true)}>
            <i className="ti ti-git-commit" aria-hidden="true" />
            {busy ? t('apiTests.ci.publishing') : t('apiTests.ci.publish')}
          </Button>
        )}
        {!readOnly && saved && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setSelection({ provider: '', id: '', name: '', branch: '', path: selection.path });
              setPreview(null);
              setPublication(null);
              onChange(undefined);
            }}
          >
            {t('apiTests.ci.clear')}
          </Button>
        )}
        {!config && !invalidFolder && (
          <span className="text-xs text-[var(--text-muted)]">{t('apiTests.ci.incomplete')}</span>
        )}
      </div>

      {publication && config && (
        <div
          className="flex flex-col gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-1)] p-3 text-xs"
          role="status"
          data-testid="ci-publication"
        >
          <p className="text-[var(--text-primary)]">
            {publication.commitUrl
              ? t('apiTests.ci.published', { branch: config.repository.branch })
              : t('apiTests.ci.unchanged')}{' '}
            {publication.commitUrl && (
              <a
                className="text-[var(--text-accent)] underline"
                href={publication.commitUrl}
                target="_blank"
                rel="noreferrer"
              >
                {t('apiTests.ci.viewCommit')}
              </a>
            )}
          </p>
          {publication.removed.length > 0 && (
            <p className="text-[var(--text-secondary)]">
              {t('apiTests.ci.removed', { files: publication.removed.join(', ') })}
            </p>
          )}
        </div>
      )}

      {pipelinePath && config && (
        <div className="flex flex-col gap-3">
          <p className="font-mono text-xs text-[var(--text-secondary)]">
            {t('apiTests.ci.pipelineFile', { path: pipelinePath })}
          </p>
          {config.repository.provider === 'azure_devops' && (
            <p className="text-xs text-amber-400">
              {t('apiTests.ci.azureNote', { path: pipelinePath })}
            </p>
          )}
          {secrets && <SecretsList secrets={secrets} provider={config.repository.provider} />}
        </div>
      )}

      {preview && (
        <div className="flex flex-col gap-2" data-testid="ci-preview">
          <ul className="flex flex-col gap-0.5 font-mono text-[11px] text-[var(--text-secondary)]">
            {preview.files.map((file) => (
              <li key={file.path}>{file.path}</li>
            ))}
          </ul>
          {pipelineFile && (
            <pre className="max-h-96 overflow-auto rounded-md border border-[var(--border)] bg-[var(--surface-1)] p-3 font-mono text-[11px] text-[var(--text-primary)]">
              {pipelineFile.content}
            </pre>
          )}
        </div>
      )}

      <ConfirmationDialog
        open={confirming}
        title={t('apiTests.ci.confirmTitle')}
        description={t('apiTests.ci.confirmDescription', {
          repository: config?.repository.name ?? '',
          branch: config?.repository.branch ?? '',
          path: config?.repository.path ?? '',
        })}
        confirmLabel={t('apiTests.ci.publish')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void publish()}
      />
    </div>
  );
}
