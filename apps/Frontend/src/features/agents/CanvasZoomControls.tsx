import React from 'react';
import { IconButton } from '../../components/ui/icon-button.js';
import { useI18n } from '../../lib/i18n/index.js';

interface CanvasZoomControlsProps {
  readonly zoom: number;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onReset: () => void;
  /** Prefix of the test ids: `<prefix>-zoom-out`, `-zoom-level`, `-zoom-in` and `-reset-view`. */
  readonly testIdPrefix: string;
}

/** Zoom out, the zoom level, zoom in and "fit to view": the toolbar of a pannable canvas. */
export function CanvasZoomControls({
  zoom,
  onZoomIn,
  onZoomOut,
  onReset,
  testIdPrefix,
}: CanvasZoomControlsProps): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-1">
      <IconButton
        variant="subtle"
        size="sm"
        icon={<i className="ti ti-minus" aria-hidden="true" />}
        label={t('agents.workflowZoomOut')}
        onClick={onZoomOut}
        data-testid={`${testIdPrefix}-zoom-out`}
      />
      <span
        className="min-w-[46px] text-center font-mono text-[11px] text-[var(--text-secondary)]"
        data-testid={`${testIdPrefix}-zoom-level`}
      >
        {`${Math.round(zoom * 100)}%`}
      </span>
      <IconButton
        variant="subtle"
        size="sm"
        icon={<i className="ti ti-plus" aria-hidden="true" />}
        label={t('agents.workflowZoomIn')}
        onClick={onZoomIn}
        data-testid={`${testIdPrefix}-zoom-in`}
      />
      <IconButton
        variant="subtle"
        size="sm"
        icon={<i className="ti ti-focus-centered" aria-hidden="true" />}
        label={t('agents.workflowResetView')}
        onClick={onReset}
        data-testid={`${testIdPrefix}-reset-view`}
      />
    </div>
  );
}
