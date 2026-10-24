import React, { useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Textarea } from '../../../components/ui/textarea.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { flattenItems, type ApiCollection, type ExportFormat } from '../api-test-types.js';
import { VariablesEditor } from '../ApiTestShared.js';
import { PaneTabs } from './integration-parts.js';
import { AuthEditor } from './RequestPane.js';

type SettingsTab = 'overview' | 'variables' | 'auth';
const SOURCE_KINDS = ['manual', 'adk', 'postman', 'insomnia', 'openapi', 'generated'] as const;
const sourceKind = (kind: string) => SOURCE_KINDS.find((item) => item === kind);

export function CollectionSettingsPane({
  collection,
  readOnly,
  onChange,
  onExport,
  onDelete,
}: {
  readonly collection: ApiCollection;
  readonly readOnly: boolean;
  readonly onChange: (collection: ApiCollection) => void;
  readonly onExport: (format: ExportFormat) => void;
  readonly onDelete: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<SettingsTab>('overview');
  const kind = sourceKind(collection.source.kind);
  const requests = flattenItems(collection.items).length;

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
            id: 'variables',
            label: t('apiTests.ui.variablesTab'),
            indicator: collection.variables.length,
          },
          {
            id: 'auth',
            label: t('apiTests.tabs.auth'),
            indicator: collection.auth.type === 'none' ? '' : '•',
          },
        ]}
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-4" role="tabpanel">
        <div className="flex max-w-3xl flex-col gap-6">
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
              <label className="flex flex-col gap-1.5 text-xs text-[var(--text-secondary)]">
                {t('common.description')}
                <Textarea
                  className="text-xs"
                  value={collection.description ?? ''}
                  disabled={readOnly}
                  onChange={(event) => onChange({ ...collection, description: event.target.value })}
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
          {tab === 'variables' && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-[var(--text-secondary)]">{t('apiTests.variablesHint')}</p>
              <VariablesEditor
                variables={collection.variables}
                readOnly={readOnly}
                onChange={(variables) => onChange({ ...collection, variables })}
              />
            </div>
          )}
          {tab === 'auth' && (
            <AuthEditor
              auth={collection.auth}
              allowInherit={false}
              readOnly={readOnly}
              onChange={(auth) => onChange({ ...collection, auth })}
            />
          )}
        </div>
      </div>
    </section>
  );
}
