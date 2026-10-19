import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/button.js';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import type { AccessTokenDto, AccessTokenScope, ApiClient } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';

const EXPIRY_OPTIONS = ['30', '90', '365', 'never'] as const;
type ExpiryOption = (typeof EXPIRY_OPTIONS)[number];

export interface AccessTokensPanelProps {
  readonly apiClient?: ApiClient;
}

/** Personal access tokens used to connect MCP clients (Claude, Codex…) without a password. */
export function AccessTokensPanel({ apiClient }: AccessTokensPanelProps) {
  const { t, formatDate } = useI18n();
  const [tokens, setTokens] = useState<readonly AccessTokenDto[]>([]);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<AccessTokenScope>('full');
  const [expiry, setExpiry] = useState<ExpiryOption>('90');
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<AccessTokenDto | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!apiClient) return;
    try {
      setTokens(await apiClient.listAccessTokens());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.loadTokensFailed'));
    }
  }, [apiClient, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!apiClient) return;
    if (!name.trim()) {
      setError(t('settings.tokenNameRequired'));
      return;
    }
    setIsBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await apiClient.createAccessToken({
        name: name.trim(),
        scope,
        expiresInDays: expiry === 'never' ? null : Number(expiry),
      });
      setCreatedSecret(created.token);
      setName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.createTokenFailed'));
    } finally {
      setIsBusy(false);
    }
  };

  const handleCopy = async (secret: string) => {
    try {
      await navigator.clipboard.writeText(secret);
      setNotice(t('settings.tokenCopied'));
    } catch {
      // Clipboard can be unavailable (permissions, insecure context); the token stays visible.
    }
  };

  const handleRevoke = async () => {
    if (!apiClient || !pendingRevoke) return;
    setIsBusy(true);
    setError(null);
    try {
      await apiClient.revokeAccessToken(pendingRevoke.id);
      setNotice(t('settings.tokenRevoked'));
      setPendingRevoke(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.revokeTokenFailed'));
    } finally {
      setIsBusy(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="access-tokens-panel">
      <div>
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">
          {t('settings.accessTokens')}
        </h2>
        <p className="text-xs text-muted">{t('settings.accessTokensDesc')}</p>
      </div>

      <form
        className="grid gap-3 sm:grid-cols-[1fr_auto_auto_auto]"
        onSubmit={(event) => void handleCreate(event)}
      >
        <div>
          <label htmlFor="token-name" className="mb-1.5 block text-xs text-[var(--text-secondary)]">
            {t('settings.tokenName')}
          </label>
          <Input
            id="token-name"
            value={name}
            maxLength={100}
            placeholder={t('settings.tokenNamePlaceholder')}
            onChange={(event) => setName(event.target.value)}
            data-testid="token-name-input"
          />
        </div>
        <div>
          <label
            htmlFor="token-scope"
            className="mb-1.5 block text-xs text-[var(--text-secondary)]"
          >
            {t('settings.tokenScope')}
          </label>
          <Select
            id="token-scope"
            value={scope}
            onChange={(event) => setScope(event.target.value as AccessTokenScope)}
            data-testid="token-scope-select"
          >
            <option value="full">{t('settings.tokenScopeFull')}</option>
            <option value="read">{t('settings.tokenScopeRead')}</option>
          </Select>
        </div>
        <div>
          <label
            htmlFor="token-expiry"
            className="mb-1.5 block text-xs text-[var(--text-secondary)]"
          >
            {t('settings.tokenExpiry')}
          </label>
          <Select
            id="token-expiry"
            value={expiry}
            onChange={(event) => setExpiry(event.target.value as ExpiryOption)}
            data-testid="token-expiry-select"
          >
            {EXPIRY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option === 'never'
                  ? t('settings.tokenExpiryNever')
                  : t('settings.tokenExpiryDays', { days: option })}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" className="self-end" isLoading={isBusy} data-testid="create-token">
          {t('settings.createToken')}
        </Button>
      </form>

      {createdSecret && (
        <div
          className="space-y-2 rounded-lg border border-[var(--border-strong)] bg-surface-2 p-3 text-xs"
          role="status"
          data-testid="created-token"
        >
          <p className="font-semibold text-[var(--text-primary)]">{t('settings.tokenCreated')}</p>
          <code className="block break-all rounded bg-surface-1 p-2 font-mono">
            {createdSecret}
          </code>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted">{t('settings.tokenMcpHint')}</span>
            <Button type="button" size="sm" variant="secondary" onClick={() => void handleCopy(createdSecret)}
            >
              {t('settings.copyToken')}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <p className="text-xs text-[var(--text-danger)]" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="text-xs text-[var(--text-secondary)]">{notice}</p>}

      <ul
        className="divide-y divide-[var(--border)] rounded-lg border border-border"
        data-testid="token-list"
      >
        {tokens.length === 0 ? (
          <li className="p-3 text-xs text-muted">{t('settings.noTokens')}</li>
        ) : (
          tokens.map((token) => (
            <li key={token.id} className="flex items-center justify-between gap-3 p-3 text-xs">
              <div className="min-w-0">
                <p className="truncate font-semibold text-[var(--text-primary)]">{token.name}</p>
                <p className="text-muted">
                  <span className="font-mono">{token.tokenPrefix}…</span>
                  {' · '}
                  {token.scope === 'read'
                    ? t('settings.tokenScopeRead')
                    : t('settings.tokenScopeFull')}
                  {' · '}
                  {token.lastUsedAt
                    ? t('settings.tokenLastUsed', { date: formatDate(token.lastUsedAt) })
                    : t('settings.tokenNeverUsed')}
                  {token.expiresAt
                    ? ` · ${t('settings.tokenExpires', { date: formatDate(token.expiresAt) })}`
                    : ` · ${t('settings.tokenExpiryNever')}`}
                </p>
              </div>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setPendingRevoke(token)}
                data-testid={`revoke-token-${token.id}`}
              >
                {t('settings.revokeToken')}
              </Button>
            </li>
          ))
        )}
      </ul>

      <ConfirmationDialog
        open={Boolean(pendingRevoke)}
        title={t('settings.revokeTokenTitle')}
        description={t('settings.revokeTokenDesc', { name: pendingRevoke?.name ?? '' })}
        confirmLabel={t('settings.revokeToken')}
        cancelLabel={t('common.cancel')}
        destructive
        isLoading={isBusy}
        onConfirm={() => void handleRevoke()}
        onCancel={() => setPendingRevoke(null)}
      />
    </div>
  );
}
