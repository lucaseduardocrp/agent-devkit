import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog.js';
import { Skeleton } from '../../components/ui/skeleton.js';
import { Switch } from '../../components/ui/switch.js';
import {
  desktopCache,
  type DesktopCacheCategory,
  type DesktopCacheUsage,
} from '../../lib/desktop.js';
import { useI18n, type TranslationKey } from '../../lib/i18n/index.js';
import { formatBytes } from '../shared/attachment-types.js';

const categoryText: Record<DesktopCacheCategory, { title: TranslationKey; text: TranslationKey }> =
  {
    web: { title: 'settings.cacheWeb', text: 'settings.cacheWebDescription' },
    temp: { title: 'settings.cacheTemp', text: 'settings.cacheTempDescription' },
    browser: { title: 'settings.cacheBrowser', text: 'settings.cacheBrowserDescription' },
  };

/** Needs a reinstall to be used again, so it is never selected without the person asking. */
const SELECTED_BY_DEFAULT: readonly DesktopCacheCategory[] = ['web', 'temp'];

/**
 * Settings > General in the desktop app: deletes the files the app leaves on this computer that
 * are rebuilt on demand (see apps/Desktop/src/main/cache.ts). Hidden in a browser.
 */
export function CachePanel() {
  const { t } = useI18n();
  const cache = desktopCache();
  const [usage, setUsage] = useState<readonly DesktopCacheUsage[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<DesktopCacheCategory>>(new Set());
  const [isConfirming, setIsConfirming] = useState(false);
  const [isClearing, setIsClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(
    async (keepSelection: boolean) => {
      if (!cache) return;
      try {
        const result = await cache.status();
        if (!result.ok) throw new Error(result.error);
        setUsage(result.usage);
        // Only what there is to delete can be selected.
        const present = (id: DesktopCacheCategory) =>
          result.usage.some((item) => item.id === id && item.bytes > 0);
        setSelected((current) =>
          keepSelection
            ? new Set([...current].filter(present))
            : new Set(SELECTED_BY_DEFAULT.filter(present)),
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : t('settings.cacheLoadFailed'));
        setUsage([]);
      }
    },
    [cache, t],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  if (!cache) return null;

  const selectedBytes = (usage ?? [])
    .filter((item) => selected.has(item.id))
    .reduce((sum, item) => sum + item.bytes, 0);

  const toggle = (id: DesktopCacheCategory, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const clear = async () => {
    setIsConfirming(false);
    setIsClearing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await cache.clear([...selected]);
      if (!result.ok) throw new Error(result.error);
      const size = formatBytes(result.freedBytes);
      setNotice(
        result.failed > 0
          ? t('settings.cacheClearedPartial', { size, count: String(result.failed) })
          : t('settings.cacheCleared', { size }),
      );
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.cacheClearFailed'));
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <div
      className="space-y-4 rounded-xl border border-border bg-surface-1 p-5 shadow-sm"
      data-testid="cache-card"
    >
      <div>
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">
          {t('settings.cacheTitle')}
        </h2>
        <p className="text-xs text-muted">{t('settings.cacheDescription')}</p>
      </div>

      {usage === null ? (
        <div className="space-y-2" data-testid="cache-loading">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-surface-2">
          {usage.map(({ id, bytes }) => (
            <li key={id} className="flex items-center justify-between gap-4 p-3">
              <label className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5">
                <span className="text-xs font-semibold text-[var(--text-primary)]">
                  {t(categoryText[id].title)}
                </span>
                <span className="text-[11px] text-muted">{t(categoryText[id].text)}</span>
              </label>
              <span className="shrink-0 text-xs text-[var(--text-secondary)]">
                {bytes > 0 ? formatBytes(bytes) : t('settings.cacheNothing')}
              </span>
              <Switch
                aria-label={t(categoryText[id].title)}
                checked={selected.has(id)}
                disabled={isClearing || bytes === 0}
                onChange={(event) => toggle(id, event.target.checked)}
                data-testid={`cache-toggle-${id}`}
              />
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p role="alert" className="text-xs text-red-400">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-xs text-emerald-400">
          {notice}
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-muted">
          {t('settings.cacheSelected', { size: formatBytes(selectedBytes) })}
        </span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          isLoading={isClearing}
          disabled={isClearing || selectedBytes === 0}
          onClick={() => setIsConfirming(true)}
          leftIcon={<i className="ti ti-trash" aria-hidden="true" />}
          data-testid="cache-clear"
        >
          {t('settings.cacheClear')}
        </Button>
      </div>

      <ConfirmationDialog
        open={isConfirming}
        title={t('settings.cacheConfirmTitle')}
        description={t('settings.cacheConfirmDescription', { size: formatBytes(selectedBytes) })}
        confirmLabel={t('settings.cacheClear')}
        cancelLabel={t('common.cancel')}
        destructive
        onCancel={() => setIsConfirming(false)}
        onConfirm={() => void clear()}
      />
    </div>
  );
}
