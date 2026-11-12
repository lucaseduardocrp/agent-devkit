import { useState, useEffect, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../../lib/utils.js';
import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import type { ApiClient, IntegrationCategory, UserIntegrationDto } from '../../lib/api-client.js';
import { useI18n, type TranslationKey } from '../../lib/i18n/index.js';
import { getLlmModelCatalog } from './llm-model-catalog.js';
import { usePermissions } from '../workspaces/permissions.js';
import { TelegramConfigForm } from './TelegramIntegrationPanel.js';
import { readTelegramSettings, type TelegramSettingsValue } from './telegram-settings.js';

const CUSTOM_MODEL_VALUE = '__custom_model__';
export interface IntegrationCardItem {
  readonly id: string;
  readonly providerId: string;
  readonly category: IntegrationCategory;
  /** Category used to group the card in the integrations catalog. */
  readonly displayCategory?: IntegrationCategory;
  readonly name: string;
  readonly desc: string;
  readonly descriptionKey?: TranslationKey;
  readonly icon: string;
  readonly iconBg: string;
  readonly iconColor: string;
  status: 'connected' | 'disconnected' | 'not-configured';
  hasSecret?: boolean;
}

export interface IntegrationConfigModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly integration: IntegrationCardItem;
  readonly currentConfig?: UserIntegrationDto;
  readonly apiClient?: ApiClient;
  readonly onSaveSuccess: (saved: UserIntegrationDto) => void;
  readonly onDeleteSuccess: (category: IntegrationCategory, providerId: string) => void;
  readonly isReadOnly?: boolean;
  readonly className?: string;
}

export function IntegrationConfigModal({
  isOpen,
  onClose,
  integration,
  currentConfig,
  apiClient,
  onSaveSuccess,
  onDeleteSuccess,
  isReadOnly = false,
  className,
}: IntegrationConfigModalProps) {
  const { t, messages } = useI18n();
  const boardLabels = messages.integrationFields;
  const canRemoveIntegrations = usePermissions().can('integrations', 'delete');
  const [isEnabled, setIsEnabled] = useState(true);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [isCustomModel, setIsCustomModel] = useState(false);
  // Telegram keeps booleans and nested values, which the string settings above cannot hold.
  const [telegramSettings, setTelegramSettings] = useState<TelegramSettingsValue>(() =>
    readTelegramSettings(),
  );
  const [secret, setSecret] = useState('');
  const [probeResult, setProbeResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [isProbing, setIsProbing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setIsEnabled(currentConfig ? currentConfig.isEnabled : true);
      const strSettings: Record<string, string> = {};
      if (currentConfig?.settings) {
        Object.entries(currentConfig.settings).forEach(([k, v]) => {
          if (typeof v === 'string') {
            strSettings[k] = v;
          }
        });
      }
      const modelCatalog = getLlmModelCatalog(integration.providerId);
      if (modelCatalog) {
        const configuredModel = strSettings.model?.trim();
        const isKnownModel = modelCatalog.models.some((model) => model.id === configuredModel);
        setIsCustomModel(Boolean(configuredModel && !isKnownModel));
        if (!configuredModel) {
          strSettings.model = modelCatalog.defaultModel;
        }
      } else {
        setIsCustomModel(false);
      }
      setSettings(strSettings);
      setTelegramSettings(readTelegramSettings(currentConfig?.settings));
      setSecret('');
      setProbeResult(null);
      setErrorMessage(null);
    }
  }, [isOpen, currentConfig, integration.providerId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) {
    return null;
  }

  const updateSetting = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };
  const isTelegram = integration.providerId === 'telegram';
  const settingsToSave: Record<string, unknown> = isTelegram ? { ...telegramSettings } : settings;

  const handleProbe = async () => {
    if (!apiClient) return;
    setIsProbing(true);
    setProbeResult(null);
    setErrorMessage(null);

    try {
      const result = await apiClient.testIntegration(integration.category, integration.providerId, {
        settings: settingsToSave,
        secret: secret.trim() || undefined,
      });
      setProbeResult(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('connect.probeFailed');
      setProbeResult({ ok: false, message: msg });
    } finally {
      setIsProbing(false);
    }
  };

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (!apiClient) return;
    setIsSaving(true);
    setErrorMessage(null);

    try {
      const saved = await apiClient.saveIntegration(integration.category, integration.providerId, {
        isEnabled,
        settings: settingsToSave,
        secret: secret.trim() || undefined,
      });
      onSaveSuccess(saved);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('connect.saveFailed');
      setErrorMessage(msg);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!apiClient) return;
    setIsSaving(true);
    setErrorMessage(null);

    try {
      await apiClient.deleteIntegration(integration.category, integration.providerId);
      onDeleteSuccess(integration.category, integration.providerId);
      onClose();
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('connect.removeFailed');
      setErrorMessage(msg);
    } finally {
      setIsSaving(false);
    }
  };

  const hasExistingSecret = Boolean(currentConfig?.hasSecret);
  const modelCatalog = getLlmModelCatalog(integration.providerId);

  const modalContent = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="integration-modal-title"
      data-testid="integration-modal"
    >
      <div
        className={cn(
          'relative w-full rounded-xl border border-border bg-surface-1 p-6 shadow-2xl overflow-y-auto max-h-[90vh]',
          isTelegram ? 'max-w-2xl' : 'max-w-lg',
          className,
        )}
      >
        <IconButton
          icon={<i className="ti ti-x text-lg" aria-hidden="true" />}
          label={t('connect.closeModal')}
          onClick={onClose}
          size="sm"
          className="absolute right-4 top-4"
        />

        <div className="mb-5 flex items-center gap-3">
          <div
            className="flex h-10 w-10 items-center justify-center rounded-lg text-lg"
            style={{ background: integration.iconBg }}
          >
            <i className={`ti ${integration.icon}`} style={{ color: integration.iconColor }} />
          </div>
          <div>
            <h2
              id="integration-modal-title"
              className="text-base font-bold text-[var(--text-primary)] tracking-tight"
            >
              {t('connect.configureProvider', { name: integration.name })}
            </h2>
            <p className="text-xs text-muted">{integration.desc}</p>
          </div>
        </div>

        {errorMessage && (
          <div
            className="mb-4 rounded-md border border-[var(--border-danger)] bg-[var(--bg-danger)] p-3 text-xs text-[var(--text-danger)]"
            role="alert"
          >
            {errorMessage}
          </div>
        )}

        {probeResult && (
          <div
            className={cn(
              'mb-4 rounded-md p-3 text-xs border flex items-center gap-2',
              probeResult.ok
                ? 'border-[var(--border-success)] bg-[var(--bg-success)] text-[var(--text-success)]'
                : 'border-[var(--border-danger)] bg-[var(--bg-danger)] text-[var(--text-danger)]',
            )}
            role="status"
          >
            <i
              className={cn(
                'ti text-base',
                probeResult.ok ? 'ti-circle-check' : 'ti-alert-triangle',
              )}
              aria-hidden="true"
            />
            <span>{probeResult.message}</span>
          </div>
        )}

        <form
          onSubmit={(e) => {
            void handleSave(e);
          }}
          className="space-y-4"
          autoComplete="off"
        >
          {/* Azure DevOps Form */}
          {integration.providerId === 'azure_devops_wiki' && (
            <>
              <div>
                <label
                  htmlFor="cfg-az-org"
                  className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
                >
                  {t('connect.azureOrganization')}
                </label>
                <Input
                  id="cfg-az-org"
                  name="azure-org"
                  type="text"
                  placeholder={t('connect.organizationPlaceholder')}
                  value={settings.organization ?? ''}
                  onChange={(e) => updateSetting('organization', e.target.value)}
                  autoComplete="off"
                  data-1p-ignore="true"
                />
              </div>
              <div>
                <label
                  htmlFor="cfg-az-proj"
                  className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
                >
                  {t('connect.projectLabel')}
                </label>
                <Input
                  id="cfg-az-proj"
                  name="azure-project"
                  type="text"
                  placeholder={t('connect.projectPlaceholder')}
                  value={settings.project ?? ''}
                  onChange={(e) => updateSetting('project', e.target.value)}
                  autoComplete="off"
                  data-1p-ignore="true"
                />
              </div>
              <div>
                <label
                  htmlFor="cfg-az-wiki"
                  className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
                >
                  {t('connect.wikiIdentifier')}
                </label>
                <Input
                  id="cfg-az-wiki"
                  name="azure-wiki"
                  type="text"
                  placeholder={t('connect.wikiIdentifierPlaceholder')}
                  value={settings.wikiIdentifier ?? ''}
                  onChange={(e) => updateSetting('wikiIdentifier', e.target.value)}
                  autoComplete="off"
                />
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  {t('connect.wikiWriteScope')}
                </p>
              </div>
            </>
          )}

          {/* GitHub Projects Form */}
          {integration.providerId === 'azure_devops' && (
            <>
              <label className="block text-sm">
                {boardLabels.organization}
                <Input
                  value={settings.organization ?? ''}
                  onChange={(event) => updateSetting('organization', event.target.value)}
                />
              </label>
              <label className="block text-sm">
                {boardLabels.project}
                <Input
                  value={settings.project ?? ''}
                  onChange={(event) => updateSetting('project', event.target.value)}
                />
              </label>
            </>
          )}
          {integration.providerId === 'trello' && (
            <>
              <label className="block text-sm">
                {boardLabels.apiKey}
                <Input
                  value={settings.apiKey ?? ''}
                  onChange={(event) => updateSetting('apiKey', event.target.value)}
                />
              </label>
              <label className="block text-sm">
                {boardLabels.boardId}
                <Input
                  value={settings.boardId ?? ''}
                  onChange={(event) => updateSetting('boardId', event.target.value)}
                />
              </label>
            </>
          )}
          {integration.providerId === 'jira' && (
            <>
              <label className="block text-sm">
                {boardLabels.jiraUrl}
                <Input
                  type="url"
                  placeholder={boardLabels.jiraUrlPlaceholder}
                  value={settings.baseUrl ?? ''}
                  onChange={(event) => updateSetting('baseUrl', event.target.value)}
                />
              </label>
              <label className="block text-sm">
                {boardLabels.email}
                <Input
                  type="email"
                  value={settings.email ?? ''}
                  onChange={(event) => updateSetting('email', event.target.value)}
                />
              </label>
              <label className="block text-sm">
                {boardLabels.projectKey}
                <Input
                  value={settings.projectKey ?? ''}
                  onChange={(event) => updateSetting('projectKey', event.target.value)}
                />
              </label>
            </>
          )}
          {integration.providerId === 'testrail' && (
            <>
              <label className="block text-sm">
                {t('connect.testrailUrl')}
                <Input
                  type="url"
                  placeholder={t('connect.testrailUrlPlaceholder')}
                  value={settings.baseUrl ?? ''}
                  onChange={(event) => updateSetting('baseUrl', event.target.value)}
                />
              </label>
              <label className="block text-sm">
                {t('connect.testrailUsername')}
                <Input
                  type="email"
                  value={settings.username ?? ''}
                  onChange={(event) => updateSetting('username', event.target.value)}
                />
              </label>
              <p className="text-xs text-[var(--text-muted)]">{t('connect.testrailSecretHint')}</p>
            </>
          )}
          {integration.providerId === 'xray' && (
            <>
              <label className="block text-sm">
                {t('connect.xrayClientId')}
                <Input
                  value={settings.clientId ?? ''}
                  onChange={(event) => updateSetting('clientId', event.target.value)}
                />
              </label>
              <label className="block text-sm">
                {t('connect.xrayProjectKey')}
                <Input
                  value={settings.projectKey ?? ''}
                  onChange={(event) => updateSetting('projectKey', event.target.value)}
                />
              </label>
              <label className="block text-sm">
                {t('connect.xrayRegion')}
                <Input
                  type="url"
                  placeholder={t('connect.xrayRegionPlaceholder')}
                  value={settings.baseUrl ?? ''}
                  onChange={(event) => updateSetting('baseUrl', event.target.value)}
                />
              </label>
              <label className="block text-sm">
                {t('connect.xrayJiraUrl')}
                <Input
                  type="url"
                  placeholder={t('connect.xrayJiraUrlPlaceholder')}
                  value={settings.jiraBaseUrl ?? ''}
                  onChange={(event) => updateSetting('jiraBaseUrl', event.target.value)}
                />
              </label>
              <p className="text-xs text-[var(--text-muted)]">{t('connect.xraySecretHint')}</p>
            </>
          )}
          {integration.providerId === 'github_projects' && (
            <>
              <div>
                <label
                  htmlFor="cfg-gh-owner"
                  className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
                >
                  {t('connect.githubOwner')}
                </label>
                <Input
                  id="cfg-gh-owner"
                  name="gh-owner"
                  type="text"
                  placeholder={t('connect.ownerPlaceholder')}
                  value={settings.owner ?? ''}
                  onChange={(e) => updateSetting('owner', e.target.value)}
                  autoComplete="off"
                  data-1p-ignore="true"
                />
              </div>
              <div>
                <label
                  htmlFor="cfg-gh-number"
                  className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
                >
                  {boardLabels.projectNumber}
                </label>
                <Input
                  id="cfg-gh-number"
                  type="number"
                  min="1"
                  value={settings.projectNumber ?? ''}
                  onChange={(event) => updateSetting('projectNumber', event.target.value)}
                />
              </div>
            </>
          )}

          {/* Wiki.js Form */}
          {integration.providerId === 'wiki_js' && (
            <div>
              <label
                htmlFor="cfg-wiki-url"
                className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
              >
                {t('connect.wikiBaseUrl')}
              </label>
              <Input
                id="cfg-wiki-url"
                name="wiki-url"
                type="url"
                placeholder="http://localhost:3000"
                value={settings.baseUrl ?? ''}
                onChange={(e) => updateSetting('baseUrl', e.target.value)}
                autoComplete="off"
              />
            </div>
          )}

          {modelCatalog && integration.providerId !== 'ollama' && (
            <div>
              <label
                htmlFor="cfg-cloud-model"
                className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
              >
                {t('connect.providerModel', { provider: modelCatalog.label })}
              </label>
              <Select
                id="cfg-cloud-model"
                name="cloud-model"
                value={isCustomModel ? CUSTOM_MODEL_VALUE : settings.model}
                onChange={(e) => {
                  const custom = e.target.value === CUSTOM_MODEL_VALUE;
                  setIsCustomModel(custom);
                  updateSetting('model', custom ? '' : e.target.value);
                }}
                required
                disabled={isReadOnly}
              >
                {modelCatalog.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.label}
                  </option>
                ))}
                <option value={CUSTOM_MODEL_VALUE}>{t('runtime.customModel')}</option>
              </Select>
              {isCustomModel && (
                <Input
                  className="mt-2"
                  aria-label={t('connect.customModelId')}
                  name="custom-cloud-model"
                  type="text"
                  placeholder={t('connect.customModelPlaceholder')}
                  value={settings.model}
                  onChange={(e) => updateSetting('model', e.target.value)}
                  autoComplete="off"
                  required
                  disabled={isReadOnly}
                />
              )}
            </div>
          )}

          {/* Ollama Form */}
          {integration.providerId === 'ollama' && (
            <>
              <div>
                <label
                  htmlFor="cfg-ollama-url"
                  className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
                >
                  {t('connect.ollamaUrl')}
                </label>
                <Input
                  id="cfg-ollama-url"
                  name="ollama-url"
                  type="text"
                  placeholder="http://localhost:11434"
                  value={settings.baseUrl ?? ''}
                  onChange={(e) => updateSetting('baseUrl', e.target.value)}
                  autoComplete="off"
                />
              </div>
              {modelCatalog && (
                <div>
                  <label
                    htmlFor="cfg-ollama-model"
                    className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
                  >
                    {t('connect.providerModel', { provider: modelCatalog.label })}
                  </label>
                  <Select
                    id="cfg-ollama-model"
                    name="ollama-model"
                    value={isCustomModel ? CUSTOM_MODEL_VALUE : settings.model}
                    onChange={(e) => {
                      const custom = e.target.value === CUSTOM_MODEL_VALUE;
                      setIsCustomModel(custom);
                      updateSetting('model', custom ? '' : e.target.value);
                    }}
                    required
                    disabled={isReadOnly}
                  >
                    {modelCatalog.models.map((model) => (
                      <option key={model.id} value={model.id}>
                        {model.label}
                      </option>
                    ))}
                    <option value={CUSTOM_MODEL_VALUE}>{t('runtime.customInstalledModel')}</option>
                  </Select>
                  {isCustomModel && (
                    <Input
                      className="mt-2"
                      aria-label={t('connect.customModelId')}
                      name="custom-ollama-model"
                      type="text"
                      placeholder="Ex.: meu-modelo:latest"
                      value={settings.model}
                      onChange={(e) => updateSetting('model', e.target.value)}
                      autoComplete="off"
                      required
                      disabled={isReadOnly}
                    />
                  )}
                </div>
              )}
            </>
          )}

          {isTelegram && (
            <TelegramConfigForm
              value={telegramSettings}
              onChange={setTelegramSettings}
              apiClient={apiClient}
              isReadOnly={isReadOnly}
              canRemove={canRemoveIntegrations}
              isSaved={Boolean(currentConfig)}
              secret={secret}
              onSecretChange={setSecret}
              hasExistingSecret={hasExistingSecret}
              isEnabled={isEnabled}
              onEnabledChange={setIsEnabled}
            />
          )}

          {/* Generic fallback for other integrations (PostgreSQL, Slack, SharePoint, REST API) */}
          {![
            'azure_devops_wiki',
            'azure_devops',
            'trello',
            'jira',
            'testrail',
            'xray',
            'github_projects',
            'wiki_js',
            'gemini',
            'openai',
            'claude',
            'groq',
            'ollama',
            'telegram',
          ].includes(integration.providerId) && (
            <div>
              <label
                htmlFor="cfg-generic-url"
                className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
              >
                {t('connect.connectionEndpoint')}
              </label>
              <Input
                id="cfg-generic-url"
                name="generic-url"
                type="text"
                placeholder="https://..."
                value={settings.baseUrl ?? ''}
                onChange={(e) => updateSetting('baseUrl', e.target.value)}
                autoComplete="off"
              />
            </div>
          )}

          {/* Credentials / Secret input (Telegram has its own, inside its Connection section) */}
          {!isTelegram && (
            <div>
              <label
                htmlFor="cfg-secret"
                className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
              >
                {t('connect.secretLabel')}
              </label>
              <Input
                id="cfg-secret"
                name="integration-secret-pat"
                type="password"
                placeholder={
                  hasExistingSecret
                    ? t('connect.keepSecretPlaceholder')
                    : t('connect.secretPlaceholder')
                }
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                disabled={isReadOnly}
                autoComplete="new-password"
                data-1p-ignore="true"
                data-lpignore="true"
              />
              {hasExistingSecret && (
                <span className="mt-1 block text-[11px] text-muted">
                  {t('connect.existingSecretHelp')}
                </span>
              )}
            </div>
          )}

          {!isTelegram && (
            <div className="flex items-center gap-2 pt-1">
              <input
                id="cfg-enable"
                type="checkbox"
                checked={isEnabled}
                onChange={(e) => setIsEnabled(e.target.checked)}
                disabled={isReadOnly}
                className="h-4 w-4 rounded border-border bg-surface-2 text-accent-foreground focus:ring-1 focus:ring-border-accent disabled:opacity-50"
              />
              <label
                htmlFor="cfg-enable"
                className="text-xs text-[var(--text-secondary)] select-none"
              >
                {t('connect.enableIntegration')}
              </label>
            </div>
          )}

          {isReadOnly ? (
            <div className="flex items-center justify-between gap-2 pt-3 border-t border-border">
              <span className="text-xs text-amber-400">{t('connect.readOnlyHelp')}</span>
              <Button type="button" variant="outline" onClick={onClose}>
                {t('common.close')}
              </Button>
            </div>
          ) : (
            <div
              className={cn(
                'flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-border',
                // The actions stay in view while the long Telegram form scrolls.
                isTelegram &&
                  'sticky -bottom-6 z-10 -mx-6 -mb-6 rounded-b-xl bg-surface-1 px-6 pb-6',
              )}
            >
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void handleProbe();
                  }}
                  disabled={isProbing || isSaving}
                >
                  {isProbing ? t('connect.testing') : t('connect.testConnection')}
                </Button>

                {currentConfig && canRemoveIntegrations && (
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => {
                      void handleDelete();
                    }}
                    disabled={isProbing || isSaving}
                  >
                    {t('connect.disconnect')}
                  </Button>
                )}
              </div>

              <Button type="submit" disabled={isSaving || isProbing}>
                {isSaving ? t('common.saving') : t('common.save')}
              </Button>
            </div>
          )}
        </form>
      </div>
    </div>
  );

  return createPortal(modalContent, document.body);
}
