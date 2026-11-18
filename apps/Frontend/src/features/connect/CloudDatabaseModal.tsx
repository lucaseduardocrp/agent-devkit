import { useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Input } from '../../components/ui/input.js';
import { Modal } from '../../components/ui/modal.js';
import { Switch } from '../../components/ui/switch.js';
import { useI18n } from '../../lib/i18n/index.js';
import type {
  DesktopCloudInspection,
  DesktopCloudTarget,
  DesktopStorageBridge,
  DesktopStorageStatus,
} from '../../lib/desktop.js';

export interface CloudDatabaseModalProps {
  readonly storage: DesktopStorageBridge;
  readonly status: DesktopStorageStatus;
  readonly onClose: () => void;
}

interface Checked {
  readonly url: string;
  readonly inspection: DesktopCloudInspection;
  readonly target: DesktopCloudTarget;
}

/**
 * Desktop app only: keeps ADK's data in a hosted PostgreSQL instead of this computer, or goes
 * back. Connecting and disconnecting restart ADK, so on success the window reloads by itself.
 */
export function CloudDatabaseModal({ storage, status, onClose }: CloudDatabaseModalProps) {
  const { t } = useI18n();
  const [url, setUrl] = useState('');
  const [checked, setChecked] = useState<Checked | null>(null);
  const [copyLocalData, setCopyLocalData] = useState(true);
  const [encryptionKey, setEncryptionKey] = useState('');
  const [copyCloudData, setCopyCloudData] = useState(false);
  const [working, setWorking] = useState<'check' | 'move' | 'key' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async <T,>(
    kind: 'check' | 'move' | 'key',
    call: () => Promise<({ ok: true } & T) | { ok: false; error: string }>,
  ): Promise<({ ok: true } & T) | null> => {
    setWorking(kind);
    setError(null);
    setNotice(null);
    const result = await call().catch((failure: unknown) => ({
      ok: false as const,
      error: failure instanceof Error ? failure.message : String(failure),
    }));
    setWorking(null);
    if (!result.ok) {
      setError(result.error);
      return null;
    }
    return result;
  };

  const check = async () => {
    const typed = url.trim();
    const result = await run('check', () => storage.inspect(typed));
    setChecked(
      result ? { url: typed, inspection: result.inspection, target: result.target } : null,
    );
  };

  const connect = async (database: Checked) => {
    const key = encryptionKey.trim();
    // On success ADK restarts and the window loads again: nothing else to do here.
    await run('move', () =>
      storage.connect({
        url: database.url,
        copyLocalData: database.inspection.kind === 'empty' && copyLocalData,
        ...(database.inspection.kind === 'adk' && key ? { integrationEncryptionKey: key } : {}),
      }),
    );
  };
  // Enabled only once the URL was checked.
  const connectChecked = checked ? () => void connect(checked) : undefined;

  const disconnect = async () => {
    await run('move', () => storage.disconnect({ copyCloudData }));
  };

  const copyKey = async () => {
    if (await run('key', () => storage.copyEncryptionKey()))
      setNotice(t('connect.cloudDatabase.keyCopied'));
  };

  const busy = working !== null || status.busy;

  return (
    <Modal open labelledBy="cloud-database-title" onClose={busy ? undefined : onClose}>
      <div
        className="relative w-[min(92vw,560px)] max-h-[90vh] overflow-y-auto rounded-xl border border-border bg-surface-1 p-6 shadow-2xl"
        data-testid="cloud-database-modal"
      >
        <IconButton
          icon={<i className="ti ti-x text-lg" aria-hidden="true" />}
          label={t('connect.closeModal')}
          onClick={onClose}
          disabled={busy}
          size="sm"
          className="absolute right-4 top-4"
        />
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--bg-accent)] text-lg">
            <i className="ti ti-database text-[var(--text-accent)]" aria-hidden="true" />
          </div>
          <div>
            <h2
              id="cloud-database-title"
              className="text-base font-bold tracking-tight text-[var(--text-primary)]"
            >
              {t('connect.cloudDatabase.title')}
            </h2>
            <p className="text-xs text-muted">{t('connect.cloudDatabase.description')}</p>
          </div>
        </div>

        {error && (
          <div
            className="mb-4 rounded-md border border-[var(--border-danger)] bg-[var(--bg-danger)] p-3 text-xs text-[var(--text-danger)]"
            role="alert"
          >
            {error}
          </div>
        )}
        {notice && (
          <div
            className="mb-4 rounded-md border border-[var(--border-success)] bg-[var(--bg-success)] p-3 text-xs text-[var(--text-success)]"
            role="status"
          >
            {notice}
          </div>
        )}

        {status.mode === 'cloud' && status.target ? (
          <div className="space-y-5">
            <p className="text-sm text-[var(--text-secondary)]">
              {t('connect.cloudDatabase.cloudNow')}
            </p>
            <TargetDetails target={status.target} />

            <div className="space-y-2 rounded-lg border border-border bg-surface-2 p-4">
              <p className="text-xs text-[var(--text-secondary)]">
                {t('connect.cloudDatabase.copyKeyHint')}
              </p>
              <Button
                variant="outline"
                size="sm"
                isLoading={working === 'key'}
                disabled={busy}
                onClick={() => void copyKey()}
              >
                <i className="ti ti-key" aria-hidden="true" />
                {t('connect.cloudDatabase.copyKey')}
              </Button>
            </div>

            <div className="space-y-3 border-t border-border pt-4">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                {t('connect.cloudDatabase.disconnectTitle')}
              </h3>
              <SwitchRow
                id="cloud-database-bring"
                checked={copyCloudData}
                disabled={busy}
                onChange={setCopyCloudData}
                label={t('connect.cloudDatabase.bringCloud')}
                help={t('connect.cloudDatabase.disconnectHint')}
              />
            </div>
            {working === 'move' && (
              <p className="text-xs text-[var(--text-secondary)]" role="status">
                {t('connect.cloudDatabase.disconnecting')}
              </p>
            )}
            <div className="flex justify-end">
              <Button
                variant="outline"
                isLoading={working === 'move'}
                disabled={busy}
                onClick={() => void disconnect()}
              >
                {t('connect.cloudDatabase.disconnect')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-[var(--text-secondary)]">
              {t('connect.cloudDatabase.localNow')}
            </p>
            <div className="space-y-1.5">
              <label
                htmlFor="cloud-database-url"
                className="block text-sm font-medium text-[var(--text-primary)]"
              >
                {t('connect.cloudDatabase.urlLabel')}
              </label>
              <div className="flex gap-2">
                <Input
                  id="cloud-database-url"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t('connect.cloudDatabase.urlPlaceholder')}
                  value={url}
                  disabled={busy}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setChecked(null);
                  }}
                />
                <Button
                  variant="outline"
                  isLoading={working === 'check'}
                  disabled={busy || url.trim() === ''}
                  onClick={() => void check()}
                >
                  {t('connect.cloudDatabase.check')}
                </Button>
              </div>
              <p className="text-xs text-muted">{t('connect.cloudDatabase.urlHint')}</p>
            </div>

            {checked && (
              <div
                className="space-y-3 rounded-lg border border-[var(--border-success)] bg-surface-2 p-4"
                data-testid="cloud-database-checked"
              >
                <p className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                  <i className="ti ti-circle-check text-[var(--text-success)]" aria-hidden="true" />
                  {checked.inspection.kind === 'adk'
                    ? t('connect.cloudDatabase.adkFound', {
                        host: checked.target.host,
                        users: String(checked.inspection.users),
                      })
                    : t('connect.cloudDatabase.emptyFound', { host: checked.target.host })}
                </p>
                {checked.inspection.kind === 'empty' ? (
                  <SwitchRow
                    id="cloud-database-copy"
                    checked={copyLocalData}
                    disabled={busy}
                    onChange={setCopyLocalData}
                    label={t('connect.cloudDatabase.copyLocal')}
                    help={t('connect.cloudDatabase.copyLocalHint')}
                  />
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-[var(--text-secondary)]">
                      {t('connect.cloudDatabase.existingHint')}
                    </p>
                    <label
                      htmlFor="cloud-database-key"
                      className="block text-xs font-medium text-[var(--text-primary)]"
                    >
                      {t('connect.cloudDatabase.keyLabel')}
                    </label>
                    <Input
                      id="cloud-database-key"
                      type="password"
                      autoComplete="off"
                      value={encryptionKey}
                      onChange={(event) => setEncryptionKey(event.target.value)}
                    />
                    <p className="text-xs text-muted">{t('connect.cloudDatabase.keyHint')}</p>
                  </div>
                )}
              </div>
            )}
            {working === 'move' && (
              <p className="text-xs text-[var(--text-secondary)]" role="status">
                {t('connect.cloudDatabase.connecting')}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={busy} onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button
                isLoading={working === 'move'}
                disabled={busy || !connectChecked}
                onClick={connectChecked}
              >
                {t('connect.cloudDatabase.connect')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function TargetDetails({ target }: { readonly target: DesktopCloudTarget }) {
  const { t } = useI18n();
  const rows: [string, string][] = [
    [t('connect.cloudDatabase.host'), `${target.host}:${target.port}`],
    [t('connect.cloudDatabase.database'), target.database],
    [t('connect.cloudDatabase.user'), target.user],
  ];
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border border-border bg-surface-2 p-4 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted">{label}</dt>
          <dd className="break-all font-mono text-[var(--text-primary)]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SwitchRow({
  id,
  checked,
  disabled,
  onChange,
  label,
  help,
}: {
  readonly id: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly label: string;
  readonly help: string;
}) {
  return (
    <label htmlFor={id} className="flex items-start justify-between gap-4">
      <span className="min-w-0">
        <span id={`${id}-label`} className="block text-sm text-[var(--text-primary)]">
          {label}
        </span>
        <span id={`${id}-help`} className="block text-xs text-muted">
          {help}
        </span>
      </span>
      <Switch
        id={id}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-help`}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
