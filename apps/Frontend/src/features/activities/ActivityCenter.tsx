/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Button } from '../../components/ui/button.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';

export type ActivityKind = 'sync' | 'push' | 'pull' | 'agent' | 'download';
export type ActivityStatus = 'running' | 'success' | 'error';

export interface ActivityItem {
  readonly id: string;
  readonly kind: ActivityKind;
  readonly title: string;
  readonly detail?: string;
  readonly status: ActivityStatus;
  readonly startedAt: number;
  readonly finishedAt?: number;
}

interface ActivityInput {
  readonly kind: ActivityKind;
  readonly title: string;
  readonly detail?: string;
}

interface ActivityContextValue {
  readonly activities: readonly ActivityItem[];
  readonly runActivity: <T>(input: ActivityInput, operation: () => Promise<T>) => Promise<T>;
  readonly clearFinished: () => void;
}

const fallbackActivityContext: Pick<ActivityContextValue, 'runActivity'> = {
  runActivity: (_input, operation) => operation(),
};
// Without a provider there is nothing finished to clear, so the clear action is never shown.
const emptyActivityContext: Pick<ActivityContextValue, 'activities'> &
  Partial<Pick<ActivityContextValue, 'clearFinished'>> = {
  activities: [],
};

const ActivityContext = createContext<ActivityContextValue | null>(null);

const icons: Record<ActivityKind, string> = {
  sync: 'ti-refresh',
  pull: 'ti-cloud-download',
  push: 'ti-cloud-upload',
  agent: 'ti-sparkles',
  download: 'ti-download',
};

function createActivityId(): string {
  return `activity-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function ActivityProvider({ children }: { readonly children: ReactNode }) {
  const { t } = useI18n();
  const [activities, setActivities] = useState<readonly ActivityItem[]>([]);

  const runActivity = useCallback(
    async <T,>(input: ActivityInput, operation: () => Promise<T>): Promise<T> => {
      const id = createActivityId();
      const startedAt = Date.now();
      setActivities((current) => [{ ...input, id, status: 'running', startedAt }, ...current]);
      try {
        const result = await operation();
        setActivities((current) =>
          current.map((item) =>
            item.id === id ? { ...item, status: 'success', finishedAt: Date.now() } : item,
          ),
        );
        return result;
      } catch (error) {
        const detail = error instanceof Error ? error.message : t('common.error');
        setActivities((current) =>
          current.map((item) =>
            item.id === id ? { ...item, status: 'error', detail, finishedAt: Date.now() } : item,
          ),
        );
        throw error;
      }
    },
    [t],
  );

  const clearFinished = useCallback(() => {
    setActivities((current) => current.filter((item) => item.status === 'running'));
  }, []);
  const value = useMemo(
    () => ({ activities, runActivity, clearFinished }),
    [activities, clearFinished, runActivity],
  );

  return <ActivityContext.Provider value={value}>{children}</ActivityContext.Provider>;
}

export function useActivities(): ActivityContextValue {
  const context = useContext(ActivityContext);
  if (!context) throw new Error('useActivities must be used within ActivityProvider');
  return context;
}

export function useActivityRunner(): Pick<ActivityContextValue, 'runActivity'> {
  return useContext(ActivityContext) ?? fallbackActivityContext;
}

export function ActivityCenter() {
  const { t } = useI18n();
  const { activities, clearFinished } = useContext(ActivityContext) ?? emptyActivityContext;
  const [open, setOpen] = useState(false);
  const [dismissedActivityId, setDismissedActivityId] = useState<string>();
  const runningCount = activities.filter((item) => item.status === 'running').length;
  const unreadCount = activities.filter((item) => item.status !== 'running').length;
  const latestFinished = activities.find((item) => item.status !== 'running');

  // Keep activity popovers below modal overlays (which use z-50 or higher).
  return (
    <div className="relative z-40" data-testid="activity-center">
      {!open && latestFinished && latestFinished.id !== dismissedActivityId && (
        <div
          role={latestFinished.status === 'error' ? 'alert' : 'status'}
          className={cn(
            'absolute right-0 top-full z-50 mt-3 flex w-[min(380px,calc(100vw-2.5rem))] items-start gap-3 rounded-xl border bg-surface-1 p-3 shadow-2xl',
            latestFinished.status === 'error' ? 'border-red-500/50' : 'border-emerald-500/40',
          )}
        >
          <i
            className={cn(
              'ti mt-0.5 text-lg',
              latestFinished.status === 'error'
                ? 'ti-alert-circle text-red-400'
                : 'ti-circle-check text-emerald-400',
            )}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">
              {latestFinished.status === 'error' ? t('activity.failed') : t('activity.completed')}
            </p>
            <p className="truncate text-xs text-muted">{latestFinished.title}</p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label={t('activity.dismissNotification')}
            onClick={() => setDismissedActivityId(latestFinished.id)}
          >
            <i className="ti ti-x" aria-hidden="true" />
          </Button>
        </div>
      )}
      {open && (
        <section
          className="absolute right-0 top-full mt-3 w-[min(420px,calc(100vw-2.5rem))] overflow-hidden rounded-xl border border-border bg-surface-1 shadow-2xl"
          aria-label={t('activity.center')}
        >
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold">{t('activity.title')}</h2>
              <p className="text-xs text-muted">{t('activity.subtitle')}</p>
            </div>
            <div className="flex items-center gap-1">
              {activities.some((item) => item.status !== 'running') && (
                <Button variant="ghost" size="sm" className="h-8" onClick={clearFinished}>
                  {t('activity.clearCompleted')}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label={t('activity.close')}
                onClick={() => setOpen(false)}
              >
                <i className="ti ti-x" aria-hidden="true" />
              </Button>
            </div>
          </header>
          <div className="thin-scrollbar max-h-96 overflow-y-auto p-2">
            {activities.length === 0 ? (
              <p className="px-3 py-8 text-center text-sm text-muted">{t('activity.empty')}</p>
            ) : (
              <ul className="space-y-1" aria-live="polite">
                {activities.map((item) => (
                  <li
                    key={item.id}
                    className="flex gap-3 rounded-lg border border-transparent px-3 py-2.5 hover:border-border hover:bg-surface-2"
                    data-status={item.status}
                  >
                    <span
                      className={cn(
                        'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2',
                        item.status === 'success' && 'text-emerald-400',
                        item.status === 'error' && 'text-red-400',
                        item.status === 'running' && 'text-accent-foreground',
                      )}
                    >
                      <i
                        className={cn(
                          'ti',
                          item.status === 'running' ? 'ti-loader-2 animate-spin' : icons[item.kind],
                        )}
                        aria-hidden="true"
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{item.title}</p>
                      <p className="text-xs text-muted">
                        {item.status === 'running'
                          ? t('activity.running')
                          : item.status === 'success'
                            ? t('activity.successStatus')
                            : item.detail || t('activity.failed')}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}
      <Button
        type="button"
        className="relative h-9 w-9 rounded-full p-0 shadow-none"
        variant="secondary"
        aria-label={t('activity.open')}
        title={t('activity.notifications')}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        leftIcon={<i className="ti ti-bell-filled" aria-hidden="true" />}
      >
        <span className="sr-only">
          {runningCount > 0
            ? t('activity.inProgressCount', { count: runningCount })
            : t('activity.title')}
        </span>
        {(unreadCount > 0 || runningCount > 0) && (
          <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full border-2 border-[var(--surface-1)] bg-[var(--fill-accent)] px-1 text-[10px] font-semibold leading-none text-white">
            {unreadCount + runningCount}
          </span>
        )}
      </Button>
    </div>
  );
}
