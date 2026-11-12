import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog.js';
import { Input } from '../../components/ui/input.js';
import { Modal } from '../../components/ui/modal.js';
import { SkeletonRow } from '../../components/ui/skeleton.js';
import type { E2eEnvironment, E2eEnvironmentInput } from './e2e-types.js';

interface VariableRow {
  readonly key: string;
  readonly value: string;
  /** Already saved: its value stays on the server unless a new one is typed. */
  readonly saved: boolean;
}

function message(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

/** Form to add an environment or change one: address, test account and custom variables. */
export function EnvironmentDialog({
  apiClient,
  environment,
  onClose,
  onSaved,
  onDeleted,
}: {
  readonly apiClient: ApiClient;
  /** Null to add a new one. */
  readonly environment: E2eEnvironment | null;
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly onDeleted: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const [name, setName] = useState(environment?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(environment?.baseUrl ?? '');
  const [username, setUsername] = useState(environment?.username ?? '');
  const [password, setPassword] = useState('');
  const [variables, setVariables] = useState<readonly VariableRow[]>(() =>
    (environment?.variableNames ?? []).map((key) => ({ key, value: '', saved: true })),
  );
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setVariable = (index: number, changes: Partial<VariableRow>) =>
    setVariables((rows) => rows.map((row, at) => (at === index ? { ...row, ...changes } : row)));

  const act = async (action: () => Promise<unknown>, done: () => void) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      done();
    } catch (reason) {
      setError(message(reason, t('e2e.actionFailed')));
      setBusy(false);
      setConfirming(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input: E2eEnvironmentInput = {
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      ...(username.trim() ? { username: username.trim() } : {}),
      ...(password ? { password } : {}),
      variables: variables
        .filter((row) => row.key.trim())
        .map((row) =>
          row.saved && !row.value
            ? { key: row.key.trim() }
            : { key: row.key.trim(), value: row.value },
        ),
    };
    void act(() => apiClient.saveE2eEnvironment(input, environment?.id), onSaved);
  };

  if (confirming && environment)
    return (
      <ConfirmationDialog
        open
        title={t('e2e.envDeleteTitle')}
        description={t('e2e.envDeleteDescription', { name: environment.name })}
        confirmLabel={t('e2e.envDelete')}
        cancelLabel={t('e2e.cancel')}
        destructive
        isLoading={busy}
        onConfirm={() => void act(() => apiClient.deleteE2eEnvironment(environment.id), onDeleted)}
        onCancel={() => setConfirming(false)}
      />
    );

  return (
    <Modal open labelledBy={titleId} closeOnBackdrop={!busy} onClose={onClose}>
      <form
        onSubmit={submit}
        className="flex w-[560px] max-w-full flex-col gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-6"
      >
        <h2 id={titleId} className="text-lg font-semibold text-[var(--text-primary)]">
          {t(environment ? 'e2e.envEdit' : 'e2e.envAdd')}
        </h2>
        <Input
          aria-label={t('e2e.envName')}
          placeholder={t('e2e.envName')}
          value={name}
          required
          maxLength={80}
          onChange={(event) => setName(event.target.value)}
        />
        <Input
          aria-label={t('e2e.envUrl')}
          placeholder={t('e2e.envUrl')}
          value={baseUrl}
          required
          type="url"
          onChange={(event) => setBaseUrl(event.target.value)}
        />

        <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              {t('e2e.envAccountTitle')}
            </h3>
            {environment?.hasPassword && (
              <span className="text-xs text-[var(--text-muted)]">{t('e2e.envPasswordSet')}</span>
            )}
          </div>
          <p className="text-xs text-[var(--text-secondary)]">{t('e2e.envAccountHint')}</p>
          <Input
            aria-label={t('e2e.username')}
            placeholder={t('e2e.username')}
            value={username}
            autoComplete="off"
            onChange={(event) => setUsername(event.target.value)}
          />
          <Input
            aria-label={t('e2e.password')}
            placeholder={environment?.hasPassword ? t('e2e.envPasswordKeep') : t('e2e.password')}
            value={password}
            type="password"
            autoComplete="new-password"
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-2 border-t border-[var(--border)] pt-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-[var(--text-primary)]">
              {t('e2e.envVariables')}
            </h3>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setVariables((rows) => [...rows, { key: '', value: '', saved: false }])
              }
            >
              <i className="ti ti-plus" aria-hidden="true" />
              {t('e2e.envAddVariable')}
            </Button>
          </div>
          {variables.map((row, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                aria-label={t('e2e.envVariableKey')}
                placeholder={t('e2e.envVariableKey')}
                value={row.key}
                className="font-mono uppercase"
                // Renaming a saved variable makes it a new one: its old value is not carried over.
                onChange={(event) => setVariable(index, { key: event.target.value, saved: false })}
              />
              <Input
                aria-label={t('e2e.envVariableValue')}
                placeholder={row.saved ? t('e2e.envVariableSaved') : t('e2e.envVariableValue')}
                value={row.value}
                autoComplete="off"
                onChange={(event) => setVariable(index, { value: event.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={t('e2e.envRemoveVariable', { name: row.key || String(index + 1) })}
                onClick={() => setVariables((rows) => rows.filter((_, at) => at !== index))}
              >
                <i className="ti ti-x" aria-hidden="true" />
              </Button>
            </div>
          ))}
        </div>

        {error && (
          <p className="rounded-md bg-red-500/10 px-3 py-2 text-sm text-red-300" role="alert">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2 border-t border-[var(--border)] pt-4">
          {environment && (
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              <i className="ti ti-trash" aria-hidden="true" />
              {t('e2e.envDelete')}
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            className="ml-auto"
            disabled={busy}
            onClick={onClose}
          >
            {t('e2e.cancel')}
          </Button>
          <Button type="submit" isLoading={busy}>
            {t('e2e.envSave')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export interface E2eEnvironmentsProps {
  readonly apiClient: ApiClient;
  readonly isReadOnly?: boolean;
  readonly onBack: () => void;
}

/** The saved environments of the workspace: where its applications run and how to sign in. */
export function E2eEnvironments({ apiClient, isReadOnly = false, onBack }: E2eEnvironmentsProps) {
  const { t } = useI18n();
  const [environments, setEnvironments] = useState<readonly E2eEnvironment[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** The environment being edited, `'new'` while adding one. */
  const [editing, setEditing] = useState<E2eEnvironment | 'new' | null>(null);

  const load = useCallback(async () => {
    try {
      setEnvironments(await apiClient.getE2eEnvironments());
      setLoadError(null);
    } catch (reason) {
      setLoadError(message(reason, t('e2e.loadFailed')));
    }
  }, [apiClient, t]);
  useEffect(() => void load(), [load]);

  const close = () => {
    setEditing(null);
    void load();
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6" data-testid="e2e-environments">
      <div>
        <Button variant="ghost" size="sm" onClick={onBack}>
          <i className="ti ti-chevron-left" aria-hidden="true" />
          {t('e2e.back')}
        </Button>
      </div>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">
            {t('e2e.envTitle')}
          </h1>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">{t('e2e.envSubtitle')}</p>
        </div>
        {!isReadOnly && (
          <Button onClick={() => setEditing('new')}>
            <i className="ti ti-plus" aria-hidden="true" />
            {t('e2e.envAdd')}
          </Button>
        )}
      </div>

      {loadError && !environments ? (
        <div className="flex flex-col items-start gap-3" role="alert">
          <p className="text-sm text-red-400">{loadError}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t('e2e.retry')}
          </Button>
        </div>
      ) : !environments ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : environments.length === 0 ? (
        <p className="rounded-lg border border-dashed border-[var(--border)] px-6 py-12 text-center text-sm text-[var(--text-secondary)]">
          {t('e2e.envEmpty')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {environments.map((environment) => (
            <li key={environment.id}>
              <Button
                variant="outline"
                className="flex h-auto w-full items-center justify-start gap-3 px-4 py-3 text-left"
                disabled={isReadOnly}
                aria-label={t('e2e.envOpen', { name: environment.name })}
                onClick={() => setEditing(environment)}
              >
                <i className="ti ti-world text-xl text-[var(--text-muted)]" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 font-medium text-[var(--text-primary)]">
                    {environment.name}
                    {environment.isDefault && (
                      <Badge variant="outline">{t('e2e.envDefault')}</Badge>
                    )}
                  </span>
                  <span className="block truncate text-xs font-normal text-[var(--text-muted)]">
                    {environment.baseUrl}
                    {environment.username && ` · ${environment.username}`}
                  </span>
                </span>
                <i className="ti ti-chevron-right text-[var(--text-muted)]" aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <EnvironmentDialog
          apiClient={apiClient}
          environment={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={close}
          onDeleted={close}
        />
      )}
    </div>
  );
}
