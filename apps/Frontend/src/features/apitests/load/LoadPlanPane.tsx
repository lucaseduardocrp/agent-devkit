import React from 'react';
import { Button } from '../../../components/ui/button.js';
import { IconButton } from '../../../components/ui/icon-button.js';
import { Input } from '../../../components/ui/input.js';
import { SearchableSelect } from '../../../components/ui/searchable-select.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { cn } from '../../../lib/utils.js';
import {
  LOAD_METRICS,
  LOAD_PROFILE_TYPES,
  type ApiRequestSpec,
  type LoadProfileType,
  type LoadScenarioInput,
  type LoadStage,
  type LoadThreshold,
} from '../api-test-types.js';
import { RequestRowsSkeleton } from '../ApiTestSkeletons.js';
import { MethodLabel } from '../integration/integration-parts.js';
import { AreaChart } from './load-charts.js';
import { PROFILE_ICON, metricUnit, peakVus, stagePoints, totalSeconds } from './load-model.js';

function Section({
  title,
  hint,
  aside,
  children,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly aside?: React.ReactNode;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-4 border-t border-[var(--border)] pt-6 first:border-0 first:pt-0">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h3>
          {hint && <p className="text-xs text-[var(--text-muted)]">{hint}</p>}
        </div>
        {aside}
      </header>
      {children}
    </section>
  );
}

const OPERATORS: { value: LoadThreshold['operator']; label: string }[] = [
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
];

/** The plan of a scenario: test type, load over time, requests and pass/fail criteria. */
export function LoadPlanPane({
  draft,
  requests,
  loadingRequests = false,
  preset,
  readOnly,
  onChange,
  onPreset,
  onApplyProfile,
}: {
  readonly draft: LoadScenarioInput;
  readonly requests: readonly { request: ApiRequestSpec; path: string[] }[];
  /** The scenario's collection is still being read, so its requests are not known yet. */
  readonly loadingRequests?: boolean;
  readonly preset: { vus: number; durationSec: number };
  readonly readOnly: boolean;
  readonly onChange: (draft: LoadScenarioInput) => void;
  readonly onPreset: (preset: { vus: number; durationSec: number }) => void;
  readonly onApplyProfile: (profile: LoadProfileType) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const total = totalSeconds(draft);
  const peak = peakVus(draft);
  const totalWeight = draft.requests.reduce((sum, item) => sum + Math.max(0, item.weight), 0);

  const setStage = (index: number, patch: Partial<LoadStage>) =>
    onChange({
      ...draft,
      profile: 'custom',
      stages: draft.stages.map((stage, position) =>
        position === index ? { ...stage, ...patch } : stage,
      ),
    });
  const setThreshold = (index: number, patch: Partial<LoadThreshold>) =>
    onChange({
      ...draft,
      thresholds: draft.thresholds.map((item, position) =>
        position === index ? { ...item, ...patch } : item,
      ),
    });
  const setWeight = (requestId: string, weight: number) =>
    onChange({
      ...draft,
      requests: draft.requests.map((item) =>
        item.requestId === requestId ? { ...item, weight } : item,
      ),
    });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6" data-testid="load-plan">
      <Section
        title={t('apiTests.testType')}
        hint={t(`apiTests.profiles.${draft.profile}.description`)}
      >
        <div
          className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7"
          role="radiogroup"
          aria-label={t('apiTests.testType')}
        >
          {LOAD_PROFILE_TYPES.map((profile) => (
            <button
              key={profile}
              type="button"
              role="radio"
              aria-checked={draft.profile === profile}
              disabled={readOnly}
              onClick={() => onApplyProfile(profile)}
              title={t(`apiTests.profiles.${profile}.description`)}
              className={cn(
                'flex h-[72px] flex-col items-start justify-between rounded-lg border p-3 text-left transition-colors disabled:cursor-default',
                draft.profile === profile
                  ? 'border-[var(--border-accent)] bg-[var(--bg-accent)]'
                  : 'border-[var(--border)] hover:border-[var(--border-strong)] hover:bg-[var(--fill-ghost-hover)]',
              )}
              data-testid={`profile-${profile}`}
            >
              <i
                className={cn(
                  'ti text-lg',
                  PROFILE_ICON[profile],
                  draft.profile === profile
                    ? 'text-[var(--text-accent)]'
                    : 'text-[var(--text-muted)]',
                )}
                aria-hidden="true"
              />
              <span className="text-sm font-medium text-[var(--text-primary)]">
                {t(`apiTests.profiles.${profile}.name`)}
              </span>
            </button>
          ))}
        </div>
        {!readOnly && draft.profile !== 'custom' && (
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5 text-xs text-[var(--text-secondary)]">
              {t('apiTests.peakVus')}
              <Input
                type="number"
                min={1}
                className="w-32"
                value={preset.vus}
                onChange={(event) => onPreset({ ...preset, vus: Number(event.target.value) })}
              />
            </label>
            <label className="flex flex-col gap-1.5 text-xs text-[var(--text-secondary)]">
              {t('apiTests.durationSec')}
              <Input
                type="number"
                min={10}
                className="w-32"
                value={preset.durationSec}
                onChange={(event) =>
                  onPreset({ ...preset, durationSec: Number(event.target.value) })
                }
              />
            </label>
            <Button variant="secondary" onClick={() => onApplyProfile(draft.profile)}>
              <i className="ti ti-wand" aria-hidden="true" />
              {t('apiTests.applyPreset')}
            </Button>
          </div>
        )}
      </Section>

      <Section
        title={t('apiTests.loadUi.loadProfile')}
        hint={t('apiTests.loadUi.loadProfileHint')}
        aside={
          <span
            className="font-mono text-xs text-[var(--text-secondary)]"
            data-testid="plan-summary"
          >
            {t('apiTests.planSummary', { vus: peak, seconds: total })}
          </span>
        }
      >
        <AreaChart
          title={t('apiTests.series.vus')}
          points={stagePoints(draft)}
          formatX={(x) => `${Math.round(x)}s`}
          formatY={(y) => `${Math.round(y)} VUs`}
          height={140}
          step
          data-testid="plan-chart"
        />
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-[72px_minmax(0,1fr)_minmax(0,1fr)_40px] gap-2 px-1 text-xs text-[var(--text-muted)]">
            <span />
            <span>{t('apiTests.durationSec')}</span>
            <span>{t('apiTests.targetVus')}</span>
            <span />
          </div>
          {draft.stages.map((stage, index) => (
            <div
              key={index}
              className="grid grid-cols-[72px_minmax(0,1fr)_minmax(0,1fr)_40px] items-center gap-2"
            >
              <span className="px-1 text-xs text-[var(--text-secondary)]">
                {t('apiTests.stage', { n: index + 1 })}
              </span>
              <Input
                type="number"
                min={1}
                aria-label={`${t('apiTests.stage', { n: index + 1 })} · ${t('apiTests.durationSec')}`}
                value={stage.durationSec}
                disabled={readOnly}
                onChange={(event) => setStage(index, { durationSec: Number(event.target.value) })}
              />
              <Input
                type="number"
                min={0}
                aria-label={`${t('apiTests.stage', { n: index + 1 })} · ${t('apiTests.targetVus')}`}
                value={stage.targetVus}
                disabled={readOnly}
                onChange={(event) => setStage(index, { targetVus: Number(event.target.value) })}
              />
              {!readOnly && draft.stages.length > 1 ? (
                <IconButton
                  icon={
                    <i
                      className="ti ti-trash text-sm text-[var(--text-danger)]"
                      aria-hidden="true"
                    />
                  }
                  label={t('apiTests.remove')}
                  onClick={() =>
                    onChange({
                      ...draft,
                      profile: 'custom',
                      stages: draft.stages.filter((_, position) => position !== index),
                    })
                  }
                />
              ) : (
                <span />
              )}
            </div>
          ))}
          {!readOnly && (
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() =>
                onChange({
                  ...draft,
                  profile: 'custom',
                  stages: [...draft.stages, { durationSec: 60, targetVus: peak || 10 }],
                })
              }
            >
              <i className="ti ti-plus" aria-hidden="true" />
              {t('apiTests.addStage')}
            </Button>
          )}
        </div>
        <label className="flex flex-wrap items-center gap-3 text-xs text-[var(--text-secondary)]">
          {t('apiTests.thinkTime')}
          <Input
            type="number"
            min={0}
            className="w-32"
            value={draft.thinkTimeMs}
            disabled={readOnly}
            onChange={(event) => onChange({ ...draft, thinkTimeMs: Number(event.target.value) })}
          />
          ms
        </label>
      </Section>

      <Section title={t('apiTests.scenarioRequests')} hint={t('apiTests.loadUi.requestsHint')}>
        <ul className="flex flex-col divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
          {loadingRequests && <RequestRowsSkeleton />}
          {!loadingRequests && requests.length === 0 && (
            <li className="p-4 text-xs text-[var(--text-muted)]">{t('apiTests.noRequests')}</li>
          )}
          {requests.map(({ request, path }) => {
            const entry = draft.requests.find((item) => item.requestId === request.id);
            const share =
              entry && totalWeight
                ? Math.round((Math.max(0, entry.weight) / totalWeight) * 100)
                : 0;
            return (
              <li key={request.id} className="flex items-center gap-3 px-4 py-2">
                <input
                  type="checkbox"
                  aria-label={request.name}
                  checked={Boolean(entry)}
                  disabled={readOnly}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      requests: event.target.checked
                        ? [...draft.requests, { requestId: request.id, weight: 1 }]
                        : draft.requests.filter((item) => item.requestId !== request.id),
                    })
                  }
                />
                <MethodLabel method={request.method} className="w-10" />
                <span
                  className={cn(
                    'min-w-0 flex-1 truncate text-sm',
                    entry ? 'text-[var(--text-primary)]' : 'text-[var(--text-muted)]',
                  )}
                >
                  {[...path, request.name].join(' / ')}
                </span>
                {entry && (
                  <>
                    <div className="hidden w-32 items-center gap-2 sm:flex" title={`${share}%`}>
                      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
                        <div
                          className="h-full rounded-full bg-[var(--fill-accent)]"
                          style={{ width: `${share}%` }}
                        />
                      </div>
                      <span className="w-9 text-right font-mono text-[11px] text-[var(--text-muted)]">
                        {share}%
                      </span>
                    </div>
                    <Input
                      type="number"
                      min={0}
                      className="w-24"
                      aria-label={`${t('apiTests.weight')} · ${request.name}`}
                      value={entry.weight}
                      disabled={readOnly}
                      onChange={(event) => setWeight(request.id, Number(event.target.value))}
                    />
                  </>
                )}
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title={t('apiTests.thresholds')} hint={t('apiTests.thresholdsHint')}>
        <div className="flex flex-col gap-2">
          {draft.thresholds.map((threshold, index) => (
            <div
              key={index}
              className="grid grid-cols-[minmax(0,1.4fr)_88px_minmax(0,1fr)_56px_auto_40px] items-center gap-2"
            >
              <SearchableSelect
                label={t('apiTests.metric')}
                placeholder={t('apiTests.metric')}
                emptyMessage=""
                searchable={false}
                value={threshold.metric}
                disabled={readOnly}
                options={LOAD_METRICS.map((metric) => ({
                  value: metric,
                  label: t(`apiTests.metrics.${metric}`),
                }))}
                onChange={(metric) =>
                  setThreshold(index, { metric: metric as LoadThreshold['metric'] })
                }
              />
              <SearchableSelect
                label={t('apiTests.operator')}
                placeholder=""
                emptyMessage=""
                searchable={false}
                className="font-mono"
                value={threshold.operator}
                disabled={readOnly}
                options={OPERATORS}
                onChange={(operator) =>
                  setThreshold(index, { operator: operator as LoadThreshold['operator'] })
                }
              />
              <Input
                type="number"
                step="any"
                min={0}
                aria-label={t('apiTests.value')}
                className="font-mono"
                value={threshold.value}
                disabled={readOnly}
                onChange={(event) => setThreshold(index, { value: Number(event.target.value) })}
              />
              <span className="text-xs text-[var(--text-muted)]">
                {metricUnit(threshold.metric)}
              </span>
              <label className="flex items-center gap-2 whitespace-nowrap text-xs text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={Boolean(threshold.abortOnFail)}
                  disabled={readOnly}
                  onChange={(event) => setThreshold(index, { abortOnFail: event.target.checked })}
                />
                {t('apiTests.abortOnFail')}
              </label>
              {readOnly ? (
                <span />
              ) : (
                <IconButton
                  icon={
                    <i
                      className="ti ti-trash text-sm text-[var(--text-danger)]"
                      aria-hidden="true"
                    />
                  }
                  label={t('apiTests.remove')}
                  onClick={() =>
                    onChange({
                      ...draft,
                      thresholds: draft.thresholds.filter((_, position) => position !== index),
                    })
                  }
                />
              )}
            </div>
          ))}
          {!readOnly && (
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() =>
                onChange({
                  ...draft,
                  thresholds: [...draft.thresholds, { metric: 'p95', operator: 'lt', value: 500 }],
                })
              }
            >
              <i className="ti ti-plus" aria-hidden="true" />
              {t('apiTests.addThreshold')}
            </Button>
          )}
        </div>
      </Section>
    </div>
  );
}
