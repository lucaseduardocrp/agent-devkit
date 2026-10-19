import { cn } from '../../lib/utils.js';
import { Button } from './button.js';
import { useI18n } from '../../lib/i18n/index.js';

export interface ToastProps {
  readonly message: string;
  readonly variant?: 'success' | 'error';
  readonly onDismiss: () => void;
  readonly dismissLabel?: string;
}

export function Toast({ message, variant = 'success', onDismiss, dismissLabel }: ToastProps) {
  const { t } = useI18n();
  const resolvedDismissLabel = dismissLabel ?? t('activity.dismissNotification');
  return (
    <div
      role={variant === 'error' ? 'alert' : 'status'}
      aria-live={variant === 'error' ? 'assertive' : 'polite'}
      className={cn(
        'fixed right-5 top-20 z-50 flex max-w-md items-center gap-3 rounded-lg border px-4 py-3 shadow-xl',
        variant === 'error'
          ? 'border-red-500/50 bg-red-950 text-red-100'
          : 'border-emerald-500/50 bg-emerald-950 text-emerald-100',
      )}
    >
      <i
        className={variant === 'error' ? 'ti ti-alert-circle' : 'ti ti-circle-check'}
        aria-hidden="true"
      />
      <span className="text-sm">{message}</span>
      <Button size="icon" variant="ghost" aria-label={resolvedDismissLabel} onClick={onDismiss}>
        <i className="ti ti-x" aria-hidden="true" />
      </Button>
    </div>
  );
}
