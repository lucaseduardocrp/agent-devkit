import React, { useState } from 'react';
import { useI18n } from '../../../lib/i18n/index.js';
import { cn } from '../../../lib/utils.js';
import type { ApiCollection, ApiFolder } from '../api-test-types.js';
import { KeyValueEditor } from '../ApiTestShared.js';
import { AuthEditor } from './AuthEditor.js';
import { DocsEditor } from './DocsEditor.js';
import { inheritedAuth } from './inheritance.js';
import { PaneTabs } from './integration-parts.js';
import { ScriptsPanel } from './ScriptsPanel.js';

type FolderTab = 'headers' | 'variables' | 'auth' | 'script' | 'tests' | 'docs';
const mark = (on: unknown) => (on ? '•' : '');

/** Settings every request inside a folder gets, on top of the collection's (as in Bruno). */
export function FolderSettingsPane({
  folder,
  collection,
  readOnly,
  onChange,
  onClearPersonal,
}: {
  readonly folder: ApiFolder;
  readonly collection: ApiCollection;
  readonly readOnly: boolean;
  readonly onChange: (folder: ApiFolder) => void;
  readonly onClearPersonal?: (ref: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<FolderTab>('headers');
  const auth = folder.auth ?? { type: 'inherit' };
  const enabledCount = (rows: readonly { enabled?: boolean }[] | undefined) =>
    (rows ?? []).filter((row) => row.enabled !== false).length;

  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={t('apiTests.workbench.folderSettings')}
      data-testid="folder-settings"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] px-4 py-3">
        <i className="ti ti-folder text-lg text-[var(--text-accent)]" aria-hidden="true" />
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-[var(--text-primary)]">
            {folder.name}
          </h2>
          <p className="truncate text-xs text-[var(--text-muted)]">
            {t('apiTests.workbench.folderSettings')} · {collection.name}
          </p>
        </div>
      </header>
      <PaneTabs
        label={t('apiTests.workbench.folderSettings')}
        value={tab}
        onChange={setTab}
        tabs={[
          {
            id: 'headers',
            label: t('apiTests.tabs.headers'),
            indicator: enabledCount(folder.headers),
          },
          {
            id: 'variables',
            label: t('apiTests.ui.variablesTab'),
            indicator: enabledCount(folder.vars),
          },
          { id: 'auth', label: t('apiTests.tabs.auth'), indicator: mark(auth.type !== 'inherit') },
          {
            id: 'script',
            label: t('apiTests.workbench.script'),
            indicator: mark(
              folder.scripts?.preRequest?.trim() || folder.scripts?.postResponse?.trim(),
            ),
          },
          {
            id: 'tests',
            label: t('apiTests.workbench.tests'),
            indicator: mark(folder.scripts?.tests?.trim()),
          },
          {
            id: 'docs',
            label: t('apiTests.tabs.docs'),
            indicator: mark(folder.description?.trim()),
          },
        ]}
      />
      {/* Docs fill the pane and scroll inside themselves; the other tabs stay in a reading column. */}
      <div
        className={cn('min-h-0 flex-1 p-4', tab === 'docs' ? 'overflow-hidden' : 'overflow-y-auto')}
        role="tabpanel"
      >
        <div className={cn('flex flex-col', tab === 'docs' ? 'h-full' : 'max-w-3xl gap-4')}>
          {tab === 'headers' && (
            <>
              <p className="text-xs text-[var(--text-secondary)]">
                {t('apiTests.workbench.headersHint.folder')}
              </p>
              <KeyValueEditor
                rows={folder.headers ?? []}
                readOnly={readOnly}
                onChange={(headers) => onChange({ ...folder, headers })}
              />
            </>
          )}
          {tab === 'variables' && (
            <>
              <p className="text-xs text-[var(--text-secondary)]">
                {t('apiTests.workbench.folderVarsHint')}
              </p>
              <KeyValueEditor
                rows={folder.vars ?? []}
                readOnly={readOnly}
                keyPlaceholder={t('apiTests.ui.variable')}
                onChange={(vars) => onChange({ ...folder, vars })}
              />
            </>
          )}
          {tab === 'auth' && (
            <AuthEditor
              auth={auth}
              allowInherit
              readOnly={readOnly}
              owner={folder.id}
              personalSecrets={collection.personalSecrets}
              onClearPersonal={onClearPersonal}
              inherited={inheritedAuth(collection, folder.id)}
              onChange={(next) => onChange({ ...folder, auth: next })}
            />
          )}
          {(tab === 'script' || tab === 'tests') && (
            <ScriptsPanel
              key={tab}
              section={tab}
              scope="folder"
              scripts={folder.scripts}
              readOnly={readOnly}
              onChange={(scripts) => onChange({ ...folder, scripts })}
            />
          )}
          {tab === 'docs' && (
            <DocsEditor
              value={folder.description ?? ''}
              readOnly={readOnly}
              hint={t('apiTests.workbench.docsHint')}
              onChange={(description) => onChange({ ...folder, description })}
              data-testid="folder-docs"
            />
          )}
        </div>
      </div>
    </section>
  );
}
