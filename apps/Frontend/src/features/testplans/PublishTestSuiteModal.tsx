import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Modal } from '../../components/ui/modal.js';
import { Select } from '../../components/ui/select.js';
import { SkeletonText } from '../../components/ui/skeleton.js';
import type {
  ApiClient,
  PublishedTestSuiteDto,
  PublishTestSuiteInput,
  RemoteTestPlanDto,
  RemoteTestSuiteDto,
  TestSuiteDto,
  TestSuiteProviderDto,
} from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import {
  FieldMappingEditor,
  type MappingSourceOption,
} from '../field-mapping/FieldMappingEditor.js';
import type { FieldValue } from '../field-mapping/types.js';

interface PublishTestSuiteModalProps {
  readonly apiClient: ApiClient;
  readonly suite: TestSuiteDto;
  readonly onClose: () => void;
  readonly onPublish: (input: PublishTestSuiteInput) => Promise<PublishedTestSuiteDto>;
  readonly onPublished: (result: PublishedTestSuiteDto) => void;
}

function suiteLabel(suite: RemoteTestSuiteDto, all: readonly RemoteTestSuiteDto[]): string {
  const byId = new Map(all.map((item) => [item.id, item]));
  const names = [suite.name];
  const visited = new Set([suite.id]);
  let parentId = suite.parentId;
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    names.unshift(parent.name);
    parentId = parent.parentId;
  }
  return names.join(' / ');
}

export function PublishTestSuiteModal({
  apiClient,
  suite,
  onClose,
  onPublish,
  onPublished,
}: PublishTestSuiteModalProps) {
  const { t } = useI18n();
  const [providers, setProviders] = useState<readonly TestSuiteProviderDto[]>([]);
  const [providerId, setProviderId] = useState('');
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [plans, setPlans] = useState<readonly RemoteTestPlanDto[]>([]);
  const [planId, setPlanId] = useState('');
  const [suites, setSuites] = useState<readonly RemoteTestSuiteDto[]>([]);
  const [parentSuiteId, setParentSuiteId] = useState('');
  const [destinationMode, setDestinationMode] = useState<'direct' | 'child'>('direct');
  const [newSuiteName, setNewSuiteName] = useState(suite.name);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [loadingPlans, setLoadingPlans] = useState(false);
  const [loadingSuites, setLoadingSuites] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [templateId, setTemplateId] = useState('');
  const [templateVersion, setTemplateVersion] = useState(0);
  const [fieldValues, setFieldValues] = useState<Record<string, FieldValue>>({});
  const [sourceFields, setSourceFields] = useState<{ providerId: string; key: string }[]>([]);
  const [preview, setPreview] = useState<{
    count: number;
    previews: { title: string; values: Record<string, FieldValue> }[];
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (typeof apiClient.getTestSuiteFieldSources !== 'function') return;
    let active = true;
    void apiClient.getTestSuiteFieldSources(suite.id).then(
      (items) => {
        if (active) setSourceFields(items);
      },
      () => {
        if (active) setSourceFields([]);
      },
    );
    return () => {
      active = false;
    };
  }, [apiClient, suite.id]);

  useEffect(() => {
    if (!templateId || !providerId) {
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    let active = true;
    setPreviewLoading(true);
    setPreviewError(null);
    const filled = Object.keys(fieldValues).length > 0;
    const run = () =>
      void apiClient
        .previewTestSuiteFields(suite.id, providerId, templateId, filled ? fieldValues : undefined)
        .then(
          (result) => {
            if (active) setPreview(result);
          },
          (cause: unknown) => {
            if (active) setPreviewError(cause instanceof Error ? cause.message : String(cause));
          },
        )
        .finally(() => {
          if (active) setPreviewLoading(false);
        });
    // Typed values are validated once the user pauses, not on every keystroke.
    const timer = filled ? setTimeout(run, 400) : undefined;
    if (!filled) run();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [apiClient, suite.id, providerId, templateId, templateVersion, fieldValues]);
  const sources: MappingSourceOption[] = [
    { value: 'core::title', label: 'Title', source: { kind: 'core', key: 'title' } },
    {
      value: 'core::description',
      label: 'Description',
      source: { kind: 'core', key: 'description' },
    },
    ...sourceFields.map((field) => ({
      value: `custom:${field.providerId}:${field.key}`,
      label: `${field.providerId} · ${field.key}`,
      source: { kind: 'custom' as const, providerId: field.providerId, key: field.key },
    })),
  ];

  useEffect(() => {
    let active = true;
    setLoadingProviders(true);
    setLoadError(null);
    void apiClient
      .getTestSuiteProviders()
      .then((items) => {
        if (active) setProviders(items);
      })
      .catch((error: unknown) => {
        if (active)
          setLoadError(error instanceof Error ? error.message : t('testplans.publishLoadFailed'));
      })
      .finally(() => {
        if (active) setLoadingProviders(false);
      });
    return () => {
      active = false;
    };
  }, [apiClient, retry, t]);

  useEffect(() => {
    if (!providerId || mode !== 'existing') return;
    let active = true;
    setLoadingPlans(true);
    setLoadError(null);
    void apiClient
      .getRemoteTestPlans(providerId)
      .then((items) => {
        if (active) setPlans(items);
      })
      .catch((error: unknown) => {
        if (active)
          setLoadError(error instanceof Error ? error.message : t('testplans.publishLoadFailed'));
      })
      .finally(() => {
        if (active) setLoadingPlans(false);
      });
    return () => {
      active = false;
    };
  }, [apiClient, mode, providerId, retry, t]);

  useEffect(() => {
    if (!providerId || mode !== 'existing' || !planId) return;
    let active = true;
    setLoadingSuites(true);
    setLoadError(null);
    void apiClient
      .getRemoteTestSuites(providerId, planId)
      .then((items) => {
        if (active) setSuites(items);
      })
      .catch((error: unknown) => {
        if (active)
          setLoadError(error instanceof Error ? error.message : t('testplans.publishLoadFailed'));
      })
      .finally(() => {
        if (active) setLoadingSuites(false);
      });
    return () => {
      active = false;
    };
  }, [apiClient, mode, planId, providerId, retry, t]);

  const configured = providers.some(
    (provider) => provider.id === providerId && provider.configured,
  );
  const ready =
    configured &&
    !loadingProviders &&
    !loadingPlans &&
    !loadingSuites &&
    !loadError &&
    !previewError &&
    !previewLoading &&
    (mode === 'new' ||
      Boolean(
        planId &&
        parentSuiteId &&
        (destinationMode === 'direct' ||
          (newSuiteName.trim() &&
            suites.find((item) => item.id === parentSuiteId)?.suiteType.toLowerCase() ===
              'statictestsuite')),
      ));

  const confirm = async () => {
    if (!ready || publishing) return;
    setPublishing(true);
    setPublishError(null);
    try {
      const result = await onPublish({
        providerId,
        ...(templateId ? { templateId } : {}),
        ...(templateId && Object.keys(fieldValues).length ? { fieldValues } : {}),
        ...(mode === 'existing'
          ? destinationMode === 'direct'
            ? { remotePlanId: planId, remoteSuiteId: parentSuiteId }
            : {
                remotePlanId: planId,
                remoteParentSuiteId: parentSuiteId,
                remoteSuiteName: newSuiteName.trim(),
              }
          : {}),
      });
      onPublished(result);
    } catch (error) {
      setPublishError(error instanceof Error ? error.message : t('testplans.suitePushFailed'));
    } finally {
      setPublishing(false);
    }
  };

  return (
    <Modal
      open
      labelledBy="publish-suite-dialog-title"
      closeOnBackdrop={!publishing}
      onClose={onClose}
    >
      <div className="flex h-[35rem] w-[36rem] max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] flex-col space-y-5 overflow-y-auto rounded-xl border border-border bg-surface-1 p-6 shadow-2xl">
        <div>
          <h2
            id="publish-suite-dialog-title"
            className="text-lg font-semibold text-[var(--text-primary)]"
          >
            {t('testplans.publishDialogTitle')}
          </h2>
          <p className="mt-1 text-sm text-muted">{suite.name}</p>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="publish-suite-provider" className="text-sm font-medium">
            {t('testplans.publishProvider')}
          </label>
          {loadingProviders ? (
            <SkeletonText lines={2} />
          ) : (
            <Select
              id="publish-suite-provider"
              value={providerId}
              disabled={publishing}
              onChange={(event) => {
                setProviderId(event.target.value);
                setPlanId('');
                setParentSuiteId('');
                setPlans([]);
                setSuites([]);
                setPublishError(null);
                setTemplateId('');
                setFieldValues({});
              }}
            >
              <option value="">{t('testplans.publishSelectProvider')}</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id} disabled={!provider.configured}>
                  {provider.name}
                  {provider.configured ? '' : ` — ${t('connect.notConfigured')}`}
                </option>
              ))}
            </Select>
          )}
          {!loadingProviders && !providers.some((provider) => provider.configured) && (
            <p className="text-xs text-muted">{t('testplans.publishNoProviders')}</p>
          )}
        </div>

        {configured && (
          <div className="space-y-1.5">
            <label htmlFor="publish-suite-mode" className="text-sm font-medium">
              {t('testplans.publishMode')}
            </label>
            <Select
              id="publish-suite-mode"
              value={mode}
              disabled={publishing}
              onChange={(event) => {
                setMode(event.target.value as 'new' | 'existing');
                setPlanId('');
                setParentSuiteId('');
                setPlans([]);
                setSuites([]);
                setPublishError(null);
              }}
            >
              <option value="new">{t('testplans.publishNewPlan')}</option>
              <option value="existing">{t('testplans.publishExistingSuite')}</option>
            </Select>
          </div>
        )}

        {configured && mode === 'existing' && (
          <>
            <div className="space-y-1.5">
              <label htmlFor="publish-suite-plan" className="text-sm font-medium">
                {t('testplans.publishPlan')}
              </label>
              {loadingPlans ? (
                <SkeletonText lines={2} />
              ) : (
                <Select
                  id="publish-suite-plan"
                  value={planId}
                  disabled={publishing}
                  onChange={(event) => {
                    setPlanId(event.target.value);
                    setParentSuiteId('');
                    setSuites([]);
                    setPublishError(null);
                  }}
                >
                  <option value="">{t('testplans.publishSelectPlan')}</option>
                  {plans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.name} {t('testplans.publishIdentifier', { id: plan.id })}
                    </option>
                  ))}
                </Select>
              )}
              {!loadingPlans && !loadError && plans.length === 0 && (
                <p className="text-xs text-muted">{t('testplans.publishNoPlans')}</p>
              )}
            </div>
            {planId && (
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <label htmlFor="publish-suite-parent" className="text-sm font-medium">
                    {t('testplans.publishDestinationSuite')}
                  </label>
                  {loadingSuites ? (
                    <SkeletonText lines={2} />
                  ) : (
                    <Select
                      id="publish-suite-parent"
                      value={parentSuiteId}
                      disabled={publishing}
                      onChange={(event) => {
                        setParentSuiteId(event.target.value);
                        setDestinationMode('direct');
                      }}
                    >
                      <option value="">{t('testplans.publishSelectDestinationSuite')}</option>
                      {suites.map((remoteSuite) => (
                        <option
                          key={remoteSuite.id}
                          value={remoteSuite.id}
                          disabled={
                            !['unknown', 'statictestsuite', 'requirementtestsuite'].includes(
                              remoteSuite.suiteType.toLowerCase(),
                            )
                          }
                        >
                          {suiteLabel(remoteSuite, suites)}{' '}
                          {t('testplans.publishIdentifier', { id: remoteSuite.id })}
                          {remoteSuite.suiteType.toLowerCase() === 'dynamictestsuite'
                            ? ` — ${t('testplans.publishReadOnlySuite')}`
                            : ''}
                        </option>
                      ))}
                    </Select>
                  )}
                  {!loadingSuites && !loadError && suites.length === 0 && (
                    <p className="text-xs text-muted">{t('testplans.publishNoSuites')}</p>
                  )}
                </div>
                {parentSuiteId && (
                  <div className="space-y-1.5">
                    <label htmlFor="publish-suite-placement" className="text-sm font-medium">
                      {t('testplans.publishPlacement')}
                    </label>
                    <Select
                      id="publish-suite-placement"
                      value={destinationMode}
                      disabled={publishing}
                      onChange={(event) =>
                        setDestinationMode(event.target.value as 'direct' | 'child')
                      }
                    >
                      <option value="direct">{t('testplans.publishDirectly')}</option>
                      <option
                        value="child"
                        disabled={
                          suites
                            .find((item) => item.id === parentSuiteId)
                            ?.suiteType.toLowerCase() !== 'statictestsuite'
                        }
                      >
                        {t('testplans.publishInNewSuite')}
                      </option>
                    </Select>
                  </div>
                )}
                {parentSuiteId && destinationMode === 'child' && (
                  <div className="space-y-1.5">
                    <label htmlFor="publish-suite-name" className="text-sm font-medium">
                      {t('testplans.publishNewSuiteName')}
                    </label>
                    <Input
                      id="publish-suite-name"
                      value={newSuiteName}
                      maxLength={255}
                      disabled={publishing}
                      onChange={(event) => setNewSuiteName(event.target.value)}
                    />
                  </div>
                )}
                <p className="text-xs text-muted">
                  {t(
                    destinationMode === 'child'
                      ? 'testplans.publishNewSuiteHint'
                      : 'testplans.publishExistingSuiteHint',
                  )}
                </p>
              </div>
            )}
          </>
        )}

        {/* The field template comes last: it fills the cases once the destination is chosen. */}
        {configured &&
          typeof apiClient.getFieldMappingTemplates === 'function' &&
          typeof apiClient.getTestCaseFieldCatalog === 'function' && (
            <FieldMappingEditor
              apiClient={apiClient}
              entityType="test_case"
              providerId={providerId}
              scope=""
              itemType="Test Case"
              sources={sources}
              selectedId={templateId}
              onSelected={(id) => {
                setTemplateId(id);
                setFieldValues({});
              }}
              onSaved={() => {
                setFieldValues({});
                setTemplateVersion((value) => value + 1);
              }}
              values={fieldValues}
              onValuesChange={setFieldValues}
            />
          )}
        {previewLoading && (
          <p role="status" className="text-xs text-muted">
            {t('testplans.publishFieldValidating')}
          </p>
        )}
        {previewError && (
          <p role="alert" className="text-xs text-red-400">
            {previewError}
          </p>
        )}
        {preview && templateId && (
          <div className="rounded border border-border p-2 text-xs">
            <strong>{t('testplans.publishFieldPreview', { count: preview.count })}</strong>
            {preview.previews.map((entry, index) => (
              <p key={`${entry.title}-${index}`}>
                {entry.title}:{' '}
                {Object.entries(entry.values)
                  .map(
                    ([id, value]) =>
                      `${id}=${Array.isArray(value) ? value.join(', ') : String(value)}`,
                  )
                  .join(' · ')}
              </p>
            ))}
          </div>
        )}

        {loadError && (
          <div
            role="alert"
            className="space-y-2 rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-400"
          >
            <p>{loadError}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRetry((value) => value + 1)}
            >
              {t('testplans.publishRetry')}
            </Button>
          </div>
        )}
        {publishError && (
          <p
            role="alert"
            className="rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-sm text-red-400"
          >
            {publishError}
          </p>
        )}

        <div className="mt-auto flex justify-end gap-3 pt-2">
          <Button type="button" variant="outline" disabled={publishing} onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type="button"
            disabled={!ready || publishing}
            isLoading={publishing}
            onClick={() => void confirm()}
          >
            {publishing ? t('testplans.pushingSuite') : t('testplans.pushSuite')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
