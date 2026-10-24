import React, { useEffect, useId, useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { Modal } from '../../../components/ui/modal.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { cn } from '../../../lib/utils.js';
import type { ApiRunTarget, LoadScenarioInput } from '../api-test-types.js';
import { peakVus, totalSeconds } from './load-model.js';

/** Load tests hit real systems: starting one asks for an explicit authorization. */
export function LoadRunDialog({
  open,
  scenario,
  target,
  starting,
  onStart,
  onClose,
}: {
  readonly open: boolean;
  readonly scenario: LoadScenarioInput;
  readonly target: ApiRunTarget;
  readonly starting: boolean;
  readonly onStart: () => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const id = useId();
  const [authorized, setAuthorized] = useState(false);
  useEffect(() => setAuthorized(false), [open]);
  const facts: [string, string, string][] = [
    ['ti-users', t('apiTests.peakVus'), String(peakVus(scenario))],
    ['ti-clock', t('apiTests.durationSec'), `${totalSeconds(scenario)} s`],
    ['ti-api', t('apiTests.loadUi.requestsCount'), String(scenario.requests.length)],
    [
      target === 'local' ? 'ti-device-laptop' : 'ti-cloud',
      t('apiTests.target'),
      t(target === 'local' ? 'apiTests.targetLocal' : 'apiTests.targetRemote'),
    ],
  ];
  return (
    <Modal open={open} onClose={onClose} labelledBy={id}>
      <div
        className="flex w-[min(94vw,560px)] flex-col gap-5 rounded-lg border border-border bg-surface-1 p-6 shadow-2xl"
        data-testid="load-run-dialog"
      >
        <div className="flex flex-col gap-1">
          <h2 id={id} className="text-lg font-semibold text-[var(--text-primary)]">
            {t('apiTests.loadUi.runTitle')}
          </h2>
          <p className="text-sm text-[var(--text-secondary)]">{scenario.name}</p>
        </div>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--border)]">
          {facts.map(([icon, label, value]) => (
            <div key={label} className="flex items-center gap-3 bg-[var(--surface-1)] p-3">
              <i className={cn('ti text-lg text-[var(--text-muted)]', icon)} aria-hidden="true" />
              <div className="min-w-0">
                <dt className="text-xs text-[var(--text-muted)]">{label}</dt>
                <dd className="truncate text-sm font-medium text-[var(--text-primary)]">{value}</dd>
              </div>
            </div>
          ))}
        </dl>
        <p className="text-xs text-[var(--text-muted)]">{t('apiTests.loadLimits')}</p>
        <label className="flex items-start gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-warning)] p-3 text-sm text-[var(--text-primary)]">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={authorized}
            onChange={(event) => setAuthorized(event.target.checked)}
            data-testid="authorized"
          />
          {t('apiTests.authorized')}
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            isLoading={starting}
            disabled={!authorized || starting}
            onClick={onStart}
            data-testid="run-load"
          >
            <i className="ti ti-player-play" aria-hidden="true" />
            {t('apiTests.runLoad')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
