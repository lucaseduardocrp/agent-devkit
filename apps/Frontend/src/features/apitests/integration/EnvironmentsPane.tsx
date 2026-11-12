import React, { useEffect, useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { ConfirmationDialog } from '../../../components/ui/confirmation-dialog.js';
import { Input } from '../../../components/ui/input.js';
import type { ApiClient } from '../../../lib/api-client.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { cn } from '../../../lib/utils.js';
import { secretRef, type ApiEnvironment } from '../api-test-types.js';
import { VariablesEditor } from '../ApiTestShared.js';
import { EmptyPane } from './integration-parts.js';
import { errorText } from './file-read.js';

type Draft = Pick<ApiEnvironment, 'name' | 'variables'>;
const blank = (): Draft => ({ name: '', variables: [{ key: 'baseUrl', value: '' }] });

/** Environments (base URLs, credentials) as a page of the workbench, as in Bruno. */
export function EnvironmentsPane({
  apiClient,
  environments,
  activeId,
  readOnly,
  onChanged,
  onActivate,
}: {
  readonly apiClient: ApiClient;
  readonly environments: readonly ApiEnvironment[];
  /** The environment selected in the header, used when sending. */
  readonly activeId: string;
  readonly readOnly: boolean;
  readonly onChanged: () => Promise<unknown> | void;
  readonly onActivate: (id: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState<string | null>(
    activeId || environments[0]?.id || null,
  );
  const [draft, setDraft] = useState<Draft>(blank);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [personal, setPersonal] = useState<readonly string[]>([]);

  const selected = environments.find((environment) => environment.id === selectedId) ?? null;
  useEffect(() => {
    setDraft(selected ? { name: selected.name, variables: selected.variables } : blank());
    setPersonal(selected?.personalSecrets ?? []);
    setDirty(false);
    // Only when another environment is picked: a reload must not drop what is being typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selected?.id]);

  const change = (next: Draft) => {
    setDraft(next);
    setDirty(true);
    setNotice(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = await apiClient.saveApiEnvironment(draft, selectedId ?? undefined);
      await onChanged();
      setSelectedId(saved.id);
      setDraft({ name: saved.name, variables: saved.variables });
      setPersonal(saved.personalSecrets ?? []);
      setDirty(false);
      setNotice(t('apiTests.saved'));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  };

  /** Forgets the current user's own value of a secret; the other members keep theirs. */
  const clearPersonal = async (environmentId: string, ref: string) => {
    setError(null);
    try {
      await apiClient.clearPersonalSecret({ scope: 'environment', scopeId: environmentId, ref });
      setDraft((current) => ({
        ...current,
        variables: current.variables.map((variable) =>
          secretRef.variable(variable.key) === ref ? { ...variable, hasValue: false } : variable,
        ),
      }));
      setPersonal((current) => current.filter((item) => item !== ref));
      setNotice(t('apiTests.workbench.personalCleared'));
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };

  // Only offered, and confirmed, while an environment is selected.
  const remove = async () => {
    const id = selectedId!;
    setConfirmDelete(false);
    try {
      await apiClient.deleteApiEnvironment(id);
      if (activeId === id) onActivate('');
      setSelectedId(null);
      await onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section
      className="flex h-full min-h-0 flex-col"
      aria-label={t('apiTests.environments')}
      data-testid="environments-page"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-[var(--border)] px-4 py-3">
        <i className="ti ti-world text-lg text-[var(--text-accent)]" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">
            {t('apiTests.environments')}
          </h2>
          <p className="truncate text-xs text-[var(--text-muted)]">
            {t('apiTests.environmentsHint')}
          </p>
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <nav
          className="flex w-60 shrink-0 flex-col gap-0.5 border-r border-[var(--border)] p-2"
          aria-label={t('apiTests.environments')}
        >
          {environments.map((environment) => (
            <button
              key={environment.id}
              type="button"
              onClick={() => setSelectedId(environment.id)}
              className={cn(
                'flex h-9 items-center gap-2 rounded-md px-3 text-left text-sm',
                environment.id === selectedId
                  ? 'bg-[var(--fill-ghost-selected)] text-[var(--text-primary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--fill-ghost-hover)]',
              )}
            >
              <span className="min-w-0 flex-1 truncate">{environment.name}</span>
              {environment.id === activeId && (
                <span
                  className="h-2 w-2 shrink-0 rounded-full bg-[var(--fill-success)]"
                  title={t('apiTests.ui.activeEnvironment')}
                />
              )}
            </button>
          ))}
          {!readOnly && (
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                'justify-start',
                selectedId === null && 'bg-[var(--fill-ghost-selected)] text-[var(--text-primary)]',
              )}
              onClick={() => setSelectedId(null)}
              data-testid="new-environment"
            >
              <i className="ti ti-plus" aria-hidden="true" />
              {t('apiTests.newEnvironment')}
            </Button>
          )}
        </nav>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {readOnly && !environments.length ? (
            <EmptyPane icon="ti-world">
              <p>{t('apiTests.ui.noEnvironments')}</p>
            </EmptyPane>
          ) : (
            <div className="flex max-w-3xl flex-col gap-5">
              <label className="flex flex-col gap-1.5 text-xs text-[var(--text-secondary)]">
                {t('apiTests.environmentName')}
                <Input
                  value={draft.name}
                  placeholder={t('apiTests.environmentName')}
                  disabled={readOnly}
                  onChange={(event) => change({ ...draft, name: event.target.value })}
                  data-testid="environment-name"
                />
              </label>
              <div className="flex flex-col gap-2">
                <h3 className="text-xs font-semibold text-[var(--text-primary)]">
                  {t('apiTests.ui.variables')}
                </h3>
                <VariablesEditor
                  variables={draft.variables}
                  readOnly={readOnly}
                  personalSecrets={personal}
                  onClearPersonal={
                    selectedId ? (ref) => void clearPersonal(selectedId, ref) : undefined
                  }
                  onChange={(variables) => change({ ...draft, variables })}
                />
              </div>
              {error && (
                <p role="alert" className="text-xs text-[var(--text-danger)]">
                  {error}
                </p>
              )}
              {notice && !dirty && (
                <p role="status" className="text-xs text-[var(--text-success)]">
                  {notice}
                </p>
              )}
              {!readOnly && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    isLoading={saving}
                    disabled={!draft.name.trim() || (!dirty && Boolean(selectedId))}
                    onClick={() => void save()}
                    data-testid="save-environment"
                  >
                    {t('apiTests.save')}
                  </Button>
                  {selectedId && selectedId !== activeId && (
                    <Button variant="secondary" onClick={() => onActivate(selectedId)}>
                      {t('apiTests.ui.useEnvironment')}
                    </Button>
                  )}
                  {selectedId && (
                    <Button
                      variant="destructive"
                      className="ml-auto"
                      onClick={() => setConfirmDelete(true)}
                    >
                      <i className="ti ti-trash" aria-hidden="true" />
                      {t('apiTests.delete')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <ConfirmationDialog
        open={confirmDelete}
        title={t('apiTests.delete')}
        description={t('apiTests.deleteEnvironmentConfirm', { name: draft.name })}
        confirmLabel={t('apiTests.delete')}
        cancelLabel={t('common.cancel')}
        destructive
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
      />
    </section>
  );
}
