import React, { useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Select } from '../../../components/ui/select.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { cn } from '../../../lib/utils.js';
import {
  REQUEST_KINDS,
  flattenItems,
  type ApiCollection,
  type CollectionSettings,
  type ExportFormat,
  type RequestKind,
} from '../api-test-types.js';
import { KeyValueEditor, VariablesEditor } from '../ApiTestShared.js';
import { VariableInput } from '../VariableInput.js';
import { AuthEditor } from './AuthEditor.js';
import { CiPipelineSettings, type CiPipelineContext } from './CiPipelineSettings.js';
import { ClientCertificates, TlsSettings } from './ClientCertificates.js';
import { DocsEditor } from './DocsEditor.js';
import { CheckboxField, PaneTabs, SectionTitle, SettingField } from './integration-parts.js';
import { ProtoFilesEditor } from './ProtoFilesEditor.js';
import { ProxySettings } from './ProxySettings.js';
import { ScriptsPanel } from './ScriptsPanel.js';

export const COLLECTION_SETTINGS_TABS = [
  'overview',
  'headers',
  'variables',
  'auth',
  'script',
  'tests',
  'proxy',
  'certificates',
  'tls',
  'protobuf',
  'network',
  'docs',
  'pipeline',
] as const;
type SettingsTab = (typeof COLLECTION_SETTINGS_TABS)[number];

const SOURCE_KINDS = ['manual', 'adk', 'postman', 'insomnia', 'openapi', 'generated'] as const;
const sourceKind = (kind: string) => SOURCE_KINDS.find((item) => item === kind);
const mark = (on: unknown) => (on ? '•' : '');

export function CollectionSettingsPane({
  collection,
  readOnly,
  onChange,
  onExport,
  onDelete,
  onClearPersonal,
  onError,
  pipeline,
}: {
  readonly collection: ApiCollection;
  readonly readOnly: boolean;
  readonly onChange: (collection: ApiCollection) => void;
  readonly onExport: (format: ExportFormat) => void;
  readonly onDelete: () => void;
  /** Forgets the current user's value of a personal secret of this collection. */
  readonly onClearPersonal?: (ref: string) => void;
  readonly onError?: (message: string) => void;
  /** Repository access for the Pipeline tab, which is hidden without it. */
  readonly pipeline?: CiPipelineContext;
}): React.JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<SettingsTab>('overview');
  const kind = sourceKind(collection.source.kind);
  const requests = flattenItems(collection.items).length;
  const settings = collection.settings ?? {};
  const setSettings = (patch: Partial<CollectionSettings>) =>
    onChange({ ...collection, settings: { ...settings, ...patch } });
  const personalSecrets = collection.personalSecrets;
  const fail = onError ?? (() => undefined);
  const enabledCount = (rows: readonly { enabled?: boolean }[] | undefined) =>
    (rows ?? []).filter((row) => row.enabled !== false).length;

  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={t('apiTests.ui.collectionSettings')}
      data-testid="collection-settings"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] px-4 py-3">
        <i className="ti ti-box text-lg text-[var(--text-accent)]" aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-[var(--text-primary)]">
            {collection.name}
          </h2>
          <p className="text-xs text-[var(--text-muted)]">{t('apiTests.ui.collectionSettings')}</p>
        </div>
      </header>
      <PaneTabs
        label={t('apiTests.ui.collectionSettings')}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: t('apiTests.ui.overview') },
          {
            id: 'headers',
            label: t('apiTests.tabs.headers'),
            indicator: enabledCount(collection.headers),
          },
          {
            id: 'variables',
            label: t('apiTests.ui.variablesTab'),
            indicator: collection.variables.length,
          },
          {
            id: 'auth',
            label: t('apiTests.tabs.auth'),
            indicator: mark(collection.auth.type !== 'none'),
          },
          {
            id: 'script',
            label: t('apiTests.workbench.script'),
            indicator: mark(
              collection.scripts?.preRequest?.trim() || collection.scripts?.postResponse?.trim(),
            ),
          },
          {
            id: 'tests',
            label: t('apiTests.workbench.tests'),
            indicator: mark(collection.scripts?.tests?.trim()),
          },
          {
            id: 'proxy',
            label: t('apiTests.workbench.proxy'),
            indicator: mark(settings.proxy?.enabled),
          },
          {
            id: 'certificates',
            label: t('apiTests.workbench.clientCertificates'),
            indicator: settings.clientCertificates?.length ?? 0,
          },
          {
            id: 'tls',
            label: t('apiTests.workbench.tls'),
            indicator: mark(settings.tls?.verify === false || settings.tls?.caCertificate),
            tone: settings.tls?.verify === false ? 'danger' : 'default',
          },
          {
            id: 'protobuf',
            label: t('apiTests.workbench.protobuf'),
            indicator: collection.protoFiles?.length ?? 0,
          },
          { id: 'network', label: t('apiTests.workbench.network') },
          {
            id: 'docs',
            label: t('apiTests.tabs.docs'),
            indicator: mark(collection.description?.trim()),
          },
          ...(pipeline
            ? [
                {
                  id: 'pipeline' as const,
                  label: t('apiTests.ci.tab'),
                  indicator: mark(collection.ci),
                },
              ]
            : []),
        ]}
      />
      {/* Docs fill the pane and scroll inside themselves; the other tabs stay in a reading column. */}
      <div
        className={cn('min-h-0 flex-1 p-4', tab === 'docs' ? 'overflow-hidden' : 'overflow-y-auto')}
        role="tabpanel"
      >
        <div className={cn('flex flex-col', tab === 'docs' ? 'h-full' : 'max-w-3xl gap-6')}>
          {tab === 'overview' && (
            <>
              <label className="flex flex-col gap-1.5 text-xs text-[var(--text-secondary)]">
                {t('apiTests.collectionName')}
                <Input
                  value={collection.name}
                  disabled={readOnly}
                  onChange={(event) => onChange({ ...collection, name: event.target.value })}
                  data-testid="collection-name"
                />
              </label>
              <dl className="grid grid-cols-3 gap-3 text-xs">
                {[
                  [
                    t('apiTests.ui.source'),
                    kind ? t(`apiTests.sourceKinds.${kind}`) : collection.source.kind,
                  ],
                  [t('apiTests.viewTabs.requests'), String(requests)],
                  [
                    t('common.updatedAt'),
                    collection.updatedAt ? new Date(collection.updatedAt).toLocaleString() : '—',
                  ],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-md border border-[var(--border)] bg-[var(--surface-1)] p-3"
                  >
                    <dt className="text-[var(--text-muted)]">{label}</dt>
                    <dd className="mt-1 font-medium text-[var(--text-primary)]">{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold text-[var(--text-primary)]">
                  {t('apiTests.export')}
                </h3>
                <div className="flex flex-wrap gap-2">
                  {(['postman', 'insomnia', 'bruno', 'adk'] as const).map((format) => (
                    <Button
                      key={format}
                      variant="secondary"
                      size="sm"
                      onClick={() => onExport(format)}
                    >
                      <i className="ti ti-download" aria-hidden="true" />
                      {t(`apiTests.formats.${format}`)}
                    </Button>
                  ))}
                </div>
                <p className="text-[11px] text-[var(--text-muted)]">{t('apiTests.formatsHint')}</p>
                <p className="text-[11px] text-[var(--text-muted)]">
                  {t('apiTests.workbench.exportPersonalHint')}
                </p>
              </div>
              {!readOnly && (
                <div className="flex items-center justify-between gap-4 rounded-md border border-[var(--bg-danger)] p-3">
                  <p className="text-xs text-[var(--text-secondary)]">
                    {t('apiTests.ui.deleteCollectionHint')}
                  </p>
                  <Button variant="destructive" size="sm" onClick={onDelete}>
                    {t('apiTests.deleteCollection')}
                  </Button>
                </div>
              )}
            </>
          )}
          {tab === 'headers' && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-[var(--text-secondary)]">
                {t('apiTests.workbench.headersHint.collection')}
              </p>
              <KeyValueEditor
                rows={collection.headers ?? []}
                readOnly={readOnly}
                onChange={(headers) => onChange({ ...collection, headers })}
              />
            </div>
          )}
          {tab === 'variables' && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-[var(--text-secondary)]">{t('apiTests.variablesHint')}</p>
              <VariablesEditor
                variables={collection.variables}
                readOnly={readOnly}
                personalSecrets={personalSecrets}
                onClearPersonal={onClearPersonal}
                onChange={(variables) => onChange({ ...collection, variables })}
              />
            </div>
          )}
          {tab === 'auth' && (
            <AuthEditor
              auth={collection.auth}
              allowInherit={false}
              readOnly={readOnly}
              owner="collection"
              personalSecrets={personalSecrets}
              onClearPersonal={onClearPersonal}
              onChange={(auth) => onChange({ ...collection, auth })}
            />
          )}
          {(tab === 'script' || tab === 'tests') && (
            <ScriptsPanel
              key={tab}
              section={tab}
              scope="collection"
              scripts={collection.scripts}
              readOnly={readOnly}
              onChange={(scripts) => onChange({ ...collection, scripts })}
              flow={collection.scriptFlow}
              onFlowChange={(scriptFlow) => onChange({ ...collection, scriptFlow })}
            />
          )}
          {tab === 'proxy' && (
            <ProxySettings
              proxy={settings.proxy}
              readOnly={readOnly}
              personalSecrets={personalSecrets}
              onClearPersonal={onClearPersonal}
              onChange={(proxy) => setSettings({ proxy })}
            />
          )}
          {tab === 'certificates' && (
            <ClientCertificates
              certificates={settings.clientCertificates ?? []}
              readOnly={readOnly}
              personalSecrets={personalSecrets}
              onClearPersonal={onClearPersonal}
              onError={fail}
              onChange={(clientCertificates) => setSettings({ clientCertificates })}
            />
          )}
          {tab === 'tls' && (
            <TlsSettings
              tls={settings.tls}
              readOnly={readOnly}
              onError={fail}
              onChange={(tls) => setSettings({ tls })}
            />
          )}
          {tab === 'protobuf' && (
            <ProtoFilesEditor
              files={collection.protoFiles ?? []}
              readOnly={readOnly}
              onError={fail}
              onChange={(protoFiles) => onChange({ ...collection, protoFiles })}
            />
          )}
          {tab === 'network' && (
            <NetworkSettings settings={settings} readOnly={readOnly} onChange={setSettings} />
          )}
          {tab === 'docs' && (
            <DocsEditor
              value={collection.description ?? ''}
              readOnly={readOnly}
              hint={t('apiTests.workbench.docsHint')}
              onChange={(description) => onChange({ ...collection, description })}
              data-testid="collection-docs"
            />
          )}
          {tab === 'pipeline' && pipeline && (
            <CiPipelineSettings
              collection={collection}
              readOnly={readOnly}
              onChange={(ci) => onChange({ ...collection, ci })}
              onError={fail}
              context={pipeline}
            />
          )}
        </div>
      </div>
    </section>
  );
}

/** Redirects, timeout, cookies and the defaults of new requests. */
function NetworkSettings({
  settings,
  readOnly,
  onChange,
}: {
  readonly settings: CollectionSettings;
  readonly readOnly: boolean;
  readonly onChange: (patch: Partial<CollectionSettings>) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const number = (text: string) => (text.trim() ? Math.max(0, Number(text) || 0) : undefined);
  const presets = settings.presets ?? {};
  return (
    <div className="flex flex-col gap-6" data-testid="network-settings">
      <div className="flex flex-col gap-4">
        <SectionTitle title={t('apiTests.workbench.network')} />
        <CheckboxField
          label={t('apiTests.workbench.followRedirects')}
          hint={t('apiTests.workbench.followRedirectsHint')}
          checked={settings.followRedirects !== false}
          disabled={readOnly}
          onChange={(followRedirects) => onChange({ followRedirects })}
        />
        <div className="grid grid-cols-2 gap-3">
          <SettingField label={t('apiTests.workbench.maxRedirects')}>
            <Input
              type="number"
              min={0}
              aria-label={t('apiTests.workbench.maxRedirects')}
              value={settings.maxRedirects ?? ''}
              placeholder="5"
              disabled={readOnly || settings.followRedirects === false}
              onChange={(event) => onChange({ maxRedirects: number(event.target.value) })}
            />
          </SettingField>
          <SettingField
            label={t('apiTests.workbench.timeout')}
            hint={t('apiTests.workbench.timeoutHint')}
          >
            <Input
              type="number"
              min={0}
              aria-label={t('apiTests.workbench.timeout')}
              value={settings.timeoutMs ?? ''}
              placeholder="30000"
              disabled={readOnly}
              onChange={(event) => onChange({ timeoutMs: number(event.target.value) })}
            />
          </SettingField>
        </div>
        <CheckboxField
          label={t('apiTests.workbench.cookieJar')}
          hint={t('apiTests.workbench.cookieJarHint')}
          checked={settings.cookies !== false}
          disabled={readOnly}
          onChange={(cookies) => onChange({ cookies })}
          testId="cookie-jar"
        />
      </div>
      <div className="flex flex-col gap-4">
        <SectionTitle
          title={t('apiTests.workbench.presets')}
          hint={t('apiTests.workbench.presetsHint')}
        />
        <div className="grid grid-cols-[180px_1fr] gap-3">
          <SettingField label={t('apiTests.workbench.requestType')}>
            <Select
              aria-label={t('apiTests.workbench.requestType')}
              value={presets.kind ?? 'http'}
              disabled={readOnly}
              onChange={(event) =>
                onChange({ presets: { ...presets, kind: event.target.value as RequestKind } })
              }
            >
              {REQUEST_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`apiTests.workbench.kinds.${kind}`)}
                </option>
              ))}
            </Select>
          </SettingField>
          <SettingField label={t('apiTests.workbench.baseUrl')}>
            <VariableInput
              mono
              aria-label={t('apiTests.workbench.baseUrl')}
              value={presets.baseUrl ?? ''}
              placeholder="{{baseUrl}}"
              disabled={readOnly}
              onValueChange={(baseUrl) => onChange({ presets: { ...presets, baseUrl } })}
            />
          </SettingField>
        </div>
      </div>
    </div>
  );
}
