import { useEffect, useState } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import type {
  FieldDefinition,
  FieldMappingRule,
  FieldMappingTemplate,
  FieldValue,
} from './types.js';
import { useI18n } from '../../lib/i18n/index.js';
import {
  FieldMappingTemplateModal,
  sourceKey,
  type MappingSourceOption,
} from './FieldMappingTemplateModal.js';

export type { MappingSourceOption } from './FieldMappingTemplateModal.js';

interface Props {
  apiClient: ApiClient;
  entityType: 'pbi' | 'test_case';
  providerId: string;
  scope: string;
  itemType: string;
  sources: readonly MappingSourceOption[];
  selectedId: string;
  onSelected: (id: string) => void;
  onSaved?: () => void;
  /** Values typed for the template fields, keyed by destination field. */
  values?: Readonly<Record<string, FieldValue>>;
  /** When given, every template field gets an input instead of a summary line. */
  onValuesChange?: (values: Record<string, FieldValue>) => void;
}

/** Picks a saved field template and shows the fields it fills; editing happens in a modal. */
export function FieldMappingEditor({
  apiClient,
  entityType,
  providerId,
  scope,
  itemType,
  sources,
  selectedId,
  onSelected,
  onSaved,
  values = {},
  onValuesChange,
}: Props) {
  const c = useI18n().messages.fieldMapping;
  const [templates, setTemplates] = useState<FieldMappingTemplate[]>([]);
  const [definitions, setDefinitions] = useState<FieldDefinition[]>([]);
  const [editing, setEditing] = useState<FieldMappingTemplate | 'new' | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const catalog =
      entityType === 'pbi'
        ? apiClient.getPbiFieldCatalog(
            providerId as 'azure_devops' | 'trello' | 'jira' | 'github_projects',
            scope,
            itemType,
          )
        : apiClient.getTestCaseFieldCatalog(providerId);
    void Promise.all([apiClient.getFieldMappingTemplates(entityType, providerId), catalog])
      .then(
        ([items, fields]) => {
          if (!active) return;
          setTemplates(items);
          setDefinitions(fields);
        },
        (cause: unknown) => {
          if (active) setError(cause instanceof Error ? cause.message : String(cause));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [apiClient, entityType, providerId, scope, itemType, retry]);

  const available = templates.filter(
    (item) =>
      (!item.scope || item.scope === scope) && (!item.itemType || item.itemType === itemType),
  );
  const selected = available.find((item) => item.id === selectedId);

  const sourceLabel = (rule: FieldMappingRule): string =>
    sources.find((option) => sourceKey(option.source) === sourceKey(rule.source))?.label ??
    [rule.source.providerId, rule.source.key].filter(Boolean).join(' · ');
  const describe = (rule: FieldMappingRule): string => {
    const field = definitions.find((item) => item.id === rule.targetFieldId);
    const source =
      rule.source.kind === 'constant'
        ? `${c.fixedValue}: ${
            field?.options?.find((option) => option.id === rule.source.value)?.name ??
            (String(rule.source.value ?? '') || '—')
          }`
        : sourceLabel(rule);
    const conversions = Object.keys(rule.choices ?? {}).length;
    return conversions ? `${source} · ${conversions} ${c.valueConversions}` : source;
  };
  const fieldInput = (
    rule: FieldMappingRule,
    change: (values: Record<string, FieldValue>) => void,
  ) => {
    const field = definitions.find((item) => item.id === rule.targetFieldId);
    const fixed = rule.source.kind === 'constant';
    // Fields filled from the case keep that source until a value is typed.
    const fromSource = fixed ? '' : `${c.useSource}: ${sourceLabel(rule)}`;
    const current = Object.hasOwn(values, rule.targetFieldId)
      ? values[rule.targetFieldId]
      : fixed
        ? rule.source.value
        : '';
    const update = (value: string) => {
      const next = { ...values };
      if (!fixed && !value) delete next[rule.targetFieldId];
      else next[rule.targetFieldId] = value;
      change(next);
    };
    const required = rule.required ?? field?.required ?? false;
    // Text inputs follow the destination field type so the browser validates what it can.
    const inputType =
      field?.type === 'number' ? 'number' : field?.type === 'date' ? 'date' : 'text';
    const control = field?.options?.length ? (
      <Select
        value={String(current ?? '')}
        onChange={(event) => update(event.target.value)}
        containerClassName="mt-1"
      >
        <option value="">{fromSource || c.select}</option>
        {field.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </Select>
    ) : field?.type === 'boolean' ? (
      <Select
        value={String(current ?? '')}
        onChange={(event) => update(event.target.value)}
        containerClassName="mt-1"
      >
        <option value="">{fromSource || c.select}</option>
        <option value="true">{c.yes}</option>
        <option value="false">{c.no}</option>
      </Select>
    ) : (
      <Input
        type={inputType}
        value={String(current ?? '')}
        placeholder={fromSource}
        onChange={(event) => update(event.target.value)}
        className="mt-1"
      />
    );
    return (
      <label key={rule.targetFieldId} className="block">
        {/* A single truncated line so every field's label takes the same height and the
            controls line up across columns, however long the field name or id gets. */}
        <span
          className="flex items-baseline gap-1 overflow-hidden"
          title={`${field?.name ?? rule.targetFieldId} (${rule.targetFieldId})`}
        >
          <span className="min-w-0 truncate">{field?.name ?? rule.targetFieldId}</span>
          {required && (
            <span className="shrink-0 text-red-400" title={c.required}>
              *
            </span>
          )}
          <span className="shrink-0 whitespace-nowrap text-xs text-[var(--text-muted)]">
            ({rule.targetFieldId})
          </span>
        </span>
        {control}
      </label>
    );
  };

  return (
    <section
      aria-label={c.fieldMapping}
      className="space-y-3 border-t border-[var(--border)] pt-4 text-sm"
    >
      <h3 className="font-semibold">{c.customFieldTemplate}</h3>
      {error && (
        <div role="alert" className="text-red-300">
          {error}{' '}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setRetry((value) => value + 1)}
          >
            {c.retry}
          </Button>
        </div>
      )}
      {loading ? (
        <p role="status">{c.loadingFields}</p>
      ) : (
        <>
          <div className="flex items-end gap-2">
            <label className="block min-w-0 flex-1">
              {c.savedTemplate}
              <Select
                value={selected?.id ?? ''}
                onChange={(event) => onSelected(event.target.value)}
                containerClassName="mt-1"
              >
                <option value="">{c.noTemplate}</option>
                {available.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </label>
            {selected && (
              <Button type="button" variant="outline" onClick={() => setEditing(selected)}>
                {c.edit}
              </Button>
            )}
            <Button type="button" variant="outline" onClick={() => setEditing('new')}>
              {c.newTemplate}
            </Button>
          </div>
          {selected &&
            (selected.rules.length && onValuesChange ? (
              <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {selected.rules.map((rule) => fieldInput(rule, onValuesChange))}
              </div>
            ) : selected.rules.length ? (
              <ul
                aria-label={c.templateFields}
                className="space-y-1 rounded border border-[var(--border)] p-2"
              >
                {selected.rules.map((rule) => (
                  <li key={rule.targetFieldId} className="flex flex-wrap gap-x-2">
                    <span className="font-medium">
                      {definitions.find((item) => item.id === rule.targetFieldId)?.name ??
                        rule.targetFieldId}
                    </span>
                    <span className="text-[var(--text-muted)]">← {describe(rule)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">{c.noFieldsFilled}</p>
            ))}
        </>
      )}
      {editing && (
        <FieldMappingTemplateModal
          apiClient={apiClient}
          entityType={entityType}
          providerId={providerId}
          scope={scope}
          itemType={itemType}
          sources={sources}
          definitions={definitions}
          {...(editing === 'new' ? {} : { template: editing })}
          onClose={() => setEditing(null)}
          onSaved={(result) => {
            setTemplates((current) => [result, ...current.filter((item) => item.id !== result.id)]);
            setEditing(null);
            onSelected(result.id);
            onSaved?.();
          }}
          onDeleted={(id) => {
            setTemplates((current) => current.filter((item) => item.id !== id));
            setEditing(null);
            onSelected('');
          }}
        />
      )}
    </section>
  );
}
