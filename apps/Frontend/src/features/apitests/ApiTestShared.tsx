import React, { useEffect, useState } from 'react';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Input } from '../../components/ui/input.js';
import { Modal } from '../../components/ui/modal.js';
import { Select } from '../../components/ui/select.js';
import { Textarea } from '../../components/ui/textarea.js';
import type { ApiClient } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import type {
  ApiRunStatus,
  ApiRunTarget,
  GenerationRequest,
  KeyValue,
  SourceType,
  Variable,
} from './api-test-types.js';
import { VariableInput } from './VariableInput.js';

const STATUS_VARIANT: Record<
  ApiRunStatus,
  'success' | 'destructive' | 'warning' | 'outline' | 'default'
> = {
  queued: 'outline',
  running: 'default',
  passed: 'success',
  failed: 'destructive',
  error: 'warning',
  cancelled: 'outline',
};

export function RunStatusBadge({ status }: { readonly status: ApiRunStatus }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Badge variant={STATUS_VARIANT[status]} data-testid="run-status">
      {status === 'running' && <i className="ti ti-loader mr-1 animate-spin" aria-hidden="true" />}
      {t(`apiTests.status.${status}`)}
    </Badge>
  );
}

/**
 * Rows of key/value pairs with an on/off switch, as in Postman and Bruno. With `lockKeys` the
 * keys come from elsewhere (the path params of the URL) and only the values are edited.
 */
export function KeyValueEditor({
  rows,
  onChange,
  readOnly,
  keyPlaceholder,
  valuePlaceholder,
  lockKeys,
}: {
  readonly rows: readonly KeyValue[];
  readonly onChange: (rows: KeyValue[]) => void;
  readonly readOnly?: boolean;
  readonly keyPlaceholder?: string;
  readonly valuePlaceholder?: string;
  readonly lockKeys?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const update = (index: number, patch: Partial<KeyValue>) =>
    onChange(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <input
            type="checkbox"
            aria-label={t('apiTests.enabled')}
            checked={row.enabled !== false}
            disabled={readOnly}
            onChange={(event) =>
              update(index, { enabled: event.target.checked ? undefined : false })
            }
          />
          <VariableInput
            mono
            aria-label={keyPlaceholder ?? t('apiTests.key')}
            value={row.key}
            placeholder={keyPlaceholder ?? t('apiTests.key')}
            disabled={readOnly || lockKeys}
            onValueChange={(key) => update(index, { key })}
          />
          <VariableInput
            mono
            aria-label={row.key || (valuePlaceholder ?? t('apiTests.value'))}
            value={row.value}
            placeholder={valuePlaceholder ?? t('apiTests.value')}
            disabled={readOnly}
            onValueChange={(value) => update(index, { value })}
          />
          {!readOnly && !lockKeys && (
            <IconButton
              variant="ghost"
              icon={
                <i className="ti ti-trash text-sm text-[var(--text-danger)]" aria-hidden="true" />
              }
              label={t('apiTests.remove')}
              onClick={() => onChange(rows.filter((_, position) => position !== index))}
            />
          )}
        </div>
      ))}
      {!readOnly && !lockKeys && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start text-xs"
          onClick={() => onChange([...rows, { key: '', value: '' }])}
        >
          <i className="ti ti-plus mr-1" aria-hidden="true" />
          {t('apiTests.addRow')}
        </Button>
      )}
    </div>
  );
}

/** Variables with a "secret" switch; secret values are write-only (the API never returns them). */
export function VariablesEditor({
  variables,
  onChange,
  readOnly,
}: {
  readonly variables: readonly Variable[];
  readonly onChange: (variables: Variable[]) => void;
  readonly readOnly?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const update = (index: number, patch: Partial<Variable>) =>
    onChange(variables.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  return (
    <div className="flex flex-col gap-2">
      {variables.map((variable, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            className="font-mono"
            aria-label={t('apiTests.key')}
            value={variable.key}
            placeholder={t('apiTests.key')}
            disabled={readOnly}
            onChange={(event) => update(index, { key: event.target.value })}
          />
          <Input
            aria-label={variable.key || t('apiTests.value')}
            type={variable.secret ? 'password' : 'text'}
            value={variable.value}
            placeholder={
              variable.secret && variable.hasValue ? t('apiTests.secretKept') : t('apiTests.value')
            }
            disabled={readOnly}
            onChange={(event) => update(index, { value: event.target.value })}
          />
          <label className="flex shrink-0 items-center gap-1 text-xs text-[var(--text-secondary)]">
            <input
              type="checkbox"
              checked={Boolean(variable.secret)}
              disabled={readOnly}
              onChange={(event) => update(index, { secret: event.target.checked })}
            />
            {t('apiTests.secret')}
          </label>
          {!readOnly && (
            <IconButton
              variant="ghost"
              icon={
                <i className="ti ti-trash text-sm text-[var(--text-danger)]" aria-hidden="true" />
              }
              label={t('apiTests.remove')}
              onClick={() => onChange(variables.filter((_, position) => position !== index))}
            />
          )}
        </div>
      ))}
      {!readOnly && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start text-xs"
          onClick={() => onChange([...variables, { key: '', value: '' }])}
        >
          <i className="ti ti-plus mr-1" aria-hidden="true" />
          {t('apiTests.addVariable')}
        </Button>
      )}
    </div>
  );
}

export function TargetSelect({
  value,
  onChange,
}: {
  readonly value: ApiRunTarget;
  readonly onChange: (target: ApiRunTarget) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <Select
      aria-label={t('apiTests.target')}
      value={value}
      onChange={(event) => onChange(event.target.value as ApiRunTarget)}
      data-testid="run-target"
    >
      <option value="remote">{t('apiTests.targetRemote')}</option>
      <option value="local">{t('apiTests.targetLocal')}</option>
    </Select>
  );
}

interface SourceOption {
  readonly type: SourceType;
  readonly id: string;
  readonly title: string;
}

/** Loads the items the user can pick as sources, one list per type, on demand. */
async function loadSourceOptions(apiClient: ApiClient, type: SourceType): Promise<SourceOption[]> {
  switch (type) {
    case 'testPlan':
      return (await apiClient.getAllSavedTestPlans()).map((plan) => ({
        type,
        id: plan.id,
        title: plan.title,
      }));
    case 'testSuite':
      return (await apiClient.getTestSuites()).map((suite) => ({
        type,
        id: suite.id,
        title: suite.name,
      }));
    case 'brain':
      return (await apiClient.getKnowledgeDocuments()).map((document) => ({
        type,
        id: document.pageId,
        title: document.title,
      }));
    case 'spec':
      return (await apiClient.getSpecifications()).map((spec) => ({
        type,
        id: spec.id,
        title: spec.title,
      }));
    case 'pbi':
      return (await apiClient.getPbiItems()).map((item) => ({
        type,
        id: item.id,
        title: `${item.title}`,
      }));
  }
}

/**
 * Generation with the workspace's AI provider (server mode). The same sources can be used from an
 * assistant through MCP (integration_prepare_generation / load_prepare_generation, host mode).
 */
export function GenerateDialog({
  open,
  kind,
  apiClient,
  collectionId,
  onClose,
  onGenerated,
}: {
  readonly open: boolean;
  readonly kind: 'integration' | 'load';
  readonly apiClient: ApiClient;
  readonly collectionId?: string;
  readonly onClose: () => void;
  readonly onGenerated: (result: { collectionId?: string; scenarioId?: string }) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [type, setType] = useState<SourceType>('testPlan');
  const [options, setOptions] = useState<SourceOption[]>([]);
  const [selected, setSelected] = useState<SourceOption[]>([]);
  const [filter, setFilter] = useState('');
  const [instructions, setInstructions] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setOptions([]);
    loadSourceOptions(apiClient, type)
      .then((list) => active && setOptions(list))
      .catch(() => active && setOptions([]));
    return () => {
      active = false;
    };
  }, [apiClient, open, type]);

  const visible = options
    .filter((option) => option.title.toLowerCase().includes(filter.trim().toLowerCase()))
    .slice(0, 50);
  const toggle = (option: SourceOption) =>
    setSelected((current) =>
      current.some((item) => item.type === option.type && item.id === option.id)
        ? current.filter((item) => !(item.type === option.type && item.id === option.id))
        : [...current, option],
    );

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const request: GenerationRequest = {
        sources: selected.map(({ type: sourceType, id }) => ({ type: sourceType, id })),
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(kind === 'load' && collectionId ? { collectionId } : {}),
      };
      const result = await apiClient.generateApiTests(kind, request);
      onGenerated({
        ...(result.collection ? { collectionId: result.collection.id } : {}),
        ...(result.scenario ? { scenarioId: result.scenario.id } : {}),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const types: SourceType[] = ['testPlan', 'testSuite', 'brain', 'spec', 'pbi'];
  return (
    <Modal open={open} onClose={onClose} labelledBy="generate-title">
      <div
        className="flex max-h-[calc(100vh-2rem)] w-[min(94vw,672px)] flex-col gap-4 overflow-y-auto rounded-lg border border-border bg-surface-1 p-6 shadow-2xl"
        data-testid="generate-dialog"
      >
        <h2 id="generate-title" className="text-lg font-semibold text-[var(--text-primary)]">
          {t(
            kind === 'integration'
              ? 'apiTests.generateIntegrationTitle'
              : 'apiTests.generateLoadTitle',
          )}
        </h2>
        <p className="text-xs text-[var(--text-secondary)]">{t('apiTests.generateHint')}</p>
        <div className="flex flex-wrap gap-1">
          {types.map((value) => (
            <Button
              key={value}
              size="sm"
              variant={type === value ? 'default' : 'ghost'}
              onClick={() => setType(value)}
            >
              {t(`apiTests.sources.${value}`)}
            </Button>
          ))}
        </div>
        <Input
          leftIcon={<i className="ti ti-search" aria-hidden="true" />}
          value={filter}
          placeholder={t('apiTests.searchSources')}
          onChange={(event) => setFilter(event.target.value)}
        />
        <ul className="max-h-48 overflow-y-auto rounded-md border border-[var(--border)]">
          {visible.length === 0 && (
            <li className="p-3 text-xs text-[var(--text-muted)]">{t('apiTests.noSources')}</li>
          )}
          {visible.map((option) => {
            const checked = selected.some(
              (item) => item.type === option.type && item.id === option.id,
            );
            return (
              <li
                key={`${option.type}:${option.id}`}
                className="border-b border-[var(--border)] last:border-0"
              >
                <label className="flex cursor-pointer items-center gap-2 px-3 py-2 text-xs text-[var(--text-primary)]">
                  <input type="checkbox" checked={checked} onChange={() => toggle(option)} />
                  {option.title}
                </label>
              </li>
            );
          })}
        </ul>
        {selected.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {selected.map((item) => (
              <span
                key={`${item.type}:${item.id}`}
                className="rounded bg-[var(--surface-2)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]"
              >
                {t(`apiTests.sources.${item.type}`)}: {item.title}
              </span>
            ))}
          </div>
        )}
        <Textarea
          value={instructions}
          rows={4}
          placeholder={t(
            kind === 'integration'
              ? 'apiTests.instructionsPlaceholder'
              : 'apiTests.loadInstructionsPlaceholder',
          )}
          onChange={(event) => setInstructions(event.target.value)}
        />
        {kind === 'integration' && (
          <Input
            value={baseUrl}
            placeholder={t('apiTests.baseUrlPlaceholder')}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        )}
        {error && (
          <p role="alert" className="text-xs text-red-400">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            {t('apiTests.close')}
          </Button>
          <Button
            isLoading={busy}
            disabled={busy || (selected.length === 0 && !instructions.trim())}
            onClick={() => void generate()}
            data-testid="generate-submit"
          >
            <i className="ti ti-sparkles mr-1.5" aria-hidden="true" />
            {t('apiTests.generate')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
