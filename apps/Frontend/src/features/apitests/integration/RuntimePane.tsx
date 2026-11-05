import React, { useEffect, useId, useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { IconButton } from '../../../components/ui/icon-button.js';
import { Input } from '../../../components/ui/input.js';
import { Modal } from '../../../components/ui/modal.js';
import { useI18n } from '../../../lib/i18n/index.js';
import type { Cookie, RuntimeState, Variable } from '../api-test-types.js';
import { PaneTabs } from './integration-parts.js';

type RuntimeTab = 'variables' | 'cookies';

/**
 * The current user's runtime state of a collection: variables set by captures and scripts, and
 * the cookie jar. It is never shared: each member has their own.
 */
export function RuntimeDialog({
  open,
  collectionName,
  runtime,
  error,
  onSave,
  onClear,
  onClose,
}: {
  readonly open: boolean;
  readonly collectionName: string;
  /** Null while it loads. */
  readonly runtime: RuntimeState | null;
  readonly error: string | null;
  readonly onSave: (runtime: RuntimeState) => Promise<unknown>;
  readonly onClear: () => Promise<unknown>;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const titleId = useId();
  const [tab, setTab] = useState<RuntimeTab>('variables');
  const [variables, setVariables] = useState<Variable[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setVariables(runtime?.variables ?? []);
    setDirty(false);
  }, [runtime]);

  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    void action().finally(() => setBusy(false));
  };
  const cookies = runtime?.cookies ?? [];
  /** The cookie jar is only shown with a loaded runtime, whose variables are kept as they are. */
  const saveCookies = (state: RuntimeState, next: Cookie[]) =>
    run(() => onSave({ variables: state.variables, cookies: next }));
  const update = (index: number, patch: Partial<Variable>) => {
    setVariables((rows) =>
      rows.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    );
    setDirty(true);
  };

  return (
    <Modal open={open} onClose={onClose} labelledBy={titleId}>
      <div
        className="flex max-h-[calc(100vh-2rem)] w-[min(94vw,760px)] flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-2xl"
        data-testid="runtime-dialog"
      >
        <header className="flex items-start gap-3 border-b border-[var(--border)] px-5 py-4">
          <i className="ti ti-variable text-lg text-[var(--text-accent)]" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-base font-semibold text-[var(--text-primary)]">
              {t('apiTests.workbench.runtime')} · {collectionName}
            </h2>
            <p className="text-xs text-[var(--text-muted)]">
              {t('apiTests.workbench.runtimeHint')}
            </p>
          </div>
          <IconButton
            size="sm"
            icon={<i className="ti ti-x" aria-hidden="true" />}
            label={t('apiTests.close')}
            onClick={onClose}
          />
        </header>
        <PaneTabs
          label={t('apiTests.workbench.runtime')}
          value={tab}
          onChange={setTab}
          tabs={[
            {
              id: 'variables',
              label: t('apiTests.ui.variablesTab'),
              indicator: runtime?.variables.length ?? 0,
            },
            { id: 'cookies', label: t('apiTests.workbench.cookies'), indicator: cookies.length },
          ]}
        />
        <div className="min-h-0 flex-1 overflow-y-auto p-4" role="tabpanel">
          {error && (
            <p role="alert" className="mb-3 text-xs text-[var(--text-danger)]">
              {error}
            </p>
          )}
          {!runtime && !error && (
            <p role="status" className="text-xs text-[var(--text-muted)]">
              {t('common.loading')}
            </p>
          )}
          {runtime && tab === 'variables' && (
            <div className="flex flex-col gap-2" data-testid="runtime-variables">
              {variables.map((variable, index) => (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    className="font-mono"
                    aria-label={t('apiTests.key')}
                    value={variable.key}
                    onChange={(event) => update(index, { key: event.target.value })}
                  />
                  <Input
                    className="font-mono"
                    aria-label={variable.key || t('apiTests.value')}
                    value={variable.value}
                    onChange={(event) => update(index, { value: event.target.value })}
                  />
                  <IconButton
                    variant="ghost"
                    icon={
                      <i
                        className="ti ti-trash text-sm text-[var(--text-danger)]"
                        aria-hidden="true"
                      />
                    }
                    label={t('apiTests.workbench.deleteNamed', { name: variable.key })}
                    onClick={() => {
                      setVariables((rows) => rows.filter((_, position) => position !== index));
                      setDirty(true);
                    }}
                  />
                </div>
              ))}
              {!variables.length && (
                <p className="text-xs text-[var(--text-muted)]">
                  {t('apiTests.workbench.noRuntimeVariables')}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  onClick={() => {
                    setVariables((rows) => [...rows, { key: '', value: '' }]);
                    setDirty(true);
                  }}
                >
                  <i className="ti ti-plus mr-1" aria-hidden="true" />
                  {t('apiTests.addVariable')}
                </Button>
                <span className="flex-1" />
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-[var(--text-danger)]"
                  disabled={busy || (!runtime.variables.length && !cookies.length)}
                  onClick={() => run(onClear)}
                  data-testid="runtime-clear"
                >
                  {t('apiTests.workbench.clearAll')}
                </Button>
                <Button
                  size="sm"
                  disabled={!dirty || busy}
                  isLoading={busy}
                  onClick={() =>
                    run(() =>
                      onSave({ variables: variables.filter((row) => row.key.trim()), cookies }),
                    )
                  }
                  data-testid="runtime-save"
                >
                  {t('apiTests.save')}
                </Button>
              </div>
            </div>
          )}
          {runtime && tab === 'cookies' && (
            <div className="flex flex-col gap-2" data-testid="runtime-cookies">
              {cookies.length ? (
                <table className="w-full text-left text-xs">
                  <thead className="text-[var(--text-muted)]">
                    <tr>
                      <th className="px-2 py-1 font-medium">{t('apiTests.workbench.domain')}</th>
                      <th className="px-2 py-1 font-medium">{t('common.name')}</th>
                      <th className="px-2 py-1 font-medium">{t('apiTests.value')}</th>
                      <th className="px-2 py-1 font-medium">
                        {t('apiTests.workbench.cookiePath')}
                      </th>
                      <th className="px-2 py-1 font-medium">{t('apiTests.workbench.expires')}</th>
                      <th className="w-8" />
                    </tr>
                  </thead>
                  <tbody className="font-mono text-[var(--text-primary)]">
                    {cookies.map((cookie, index) => (
                      <tr key={index} className="border-t border-[var(--border)]">
                        <td className="px-2 py-1">{cookie.domain}</td>
                        <td className="px-2 py-1">{cookie.name}</td>
                        <td className="max-w-48 truncate px-2 py-1" title={cookie.value}>
                          {cookie.value}
                        </td>
                        <td className="px-2 py-1">{cookie.path}</td>
                        <td className="px-2 py-1 text-[var(--text-muted)]">
                          {cookie.expires
                            ? new Date(cookie.expires).toLocaleString()
                            : t('apiTests.workbench.session')}
                        </td>
                        <td>
                          <IconButton
                            size="xs"
                            variant="ghost"
                            icon={
                              <i
                                className="ti ti-trash text-[var(--text-danger)]"
                                aria-hidden="true"
                              />
                            }
                            label={t('apiTests.workbench.deleteNamed', { name: cookie.name })}
                            disabled={busy}
                            onClick={() =>
                              saveCookies(
                                runtime,
                                cookies.filter((_, position) => position !== index),
                              )
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-xs text-[var(--text-muted)]">
                  {t('apiTests.workbench.noCookies')}
                </p>
              )}
              {cookies.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="self-end text-[var(--text-danger)]"
                  disabled={busy}
                  onClick={() => saveCookies(runtime, [])}
                  data-testid="cookies-clear"
                >
                  {t('apiTests.workbench.clearCookies')}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
