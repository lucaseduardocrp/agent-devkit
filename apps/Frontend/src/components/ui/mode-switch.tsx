import { Button } from './button.js';
import { useI18n } from '../../lib/i18n/index.js';

export type ViewMode = 'preview' | 'code';

interface ModeSwitchProps {
  readonly mode: ViewMode;
  readonly onChange: (mode: ViewMode) => void;
  readonly ariaLabel: string;
}

export function ModeSwitch({ mode, onChange, ariaLabel }: ModeSwitchProps) {
  const { t } = useI18n();
  const buttonClass =
    'flex h-7 w-7 shrink-0 items-center justify-center rounded p-0 leading-none [&_i]:block [&_i]:text-base [&_i]:leading-none';
  return (
    <div
      className="inline-flex h-8 items-center gap-0.5 rounded-md border border-border bg-surface-2 p-0.5"
      role="group"
      aria-label={ariaLabel}
    >
      <Button
        type="button"
        size="icon"
        variant={mode === 'preview' ? 'secondary' : 'ghost'}
        className={buttonClass}
        aria-label={t('common.preview')}
        title={t('common.preview')}
        onClick={() => onChange('preview')}
      >
        <i className="ti ti-eye" aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon"
        variant={mode === 'code' ? 'secondary' : 'ghost'}
        className={buttonClass}
        aria-label={t('common.code')}
        title={t('common.code')}
        onClick={() => onChange('code')}
      >
        <i className="ti ti-code" aria-hidden="true" />
      </Button>
    </div>
  );
}
