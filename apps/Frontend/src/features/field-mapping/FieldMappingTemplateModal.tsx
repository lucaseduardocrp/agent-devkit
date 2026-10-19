import { useId, useState } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Modal } from '../../components/ui/modal.js';
import { Select } from '../../components/ui/select.js';
import type {
  FieldDefinition,
  FieldMappingRule,
  FieldMappingTemplate,
  FieldSource,
} from './types.js';
import { useI18n } from '../../lib/i18n/index.js';

export interface MappingSourceOption {
  value: string;
  label: string;
  source: FieldSource;
}

interface Props {
  apiClient: ApiClient;
  entityType: 'pbi' | 'test_case';
  providerId: string;
  scope: string;
  itemType: string;
  sources: readonly MappingSourceOption[];
  definitions: readonly FieldDefinition[];
  /** Template being edited; omitted when creating a new one. */
  template?: FieldMappingTemplate;
  onClose: () => void;
  onSaved: (template: FieldMappingTemplate) => void;
  onDeleted: (id: string) => void;
}

export function sourceKey(source: FieldSource): string {
  return source.kind === 'constant'
    ? 'constant'
    : `${source.kind}:${source.providerId ?? ''}:${source.key ?? ''}`;
}

export function FieldMappingTemplateModal({
  apiClient,
  entityType,
  providerId,
  scope,
  itemType,
  sources,
  definitions,
  template,
  onClose,
  onSaved,
  onDeleted,
}: Props) {
  const { locale } = useI18n();
  const pt = locale === 'pt-BR';
  const titleId = useId();
  const [name, setName] = useState(template?.name ?? '');
  const [rules, setRules] = useState<FieldMappingRule[]>(template?.rules ?? []);
  const [search, setSearch] = useState('');
  const [choiceDrafts, setChoiceDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const updateRule = (targetFieldId: string, source: FieldSource | null) => {
    setRules((current) => [
      ...current.filter((rule) => rule.targetFieldId !== targetFieldId),
      ...(source ? [{ targetFieldId, source }] : []),
    ]);
  };
  const updateChoices = (targetFieldId: string, choices: Record<string, string>) => {
    setRules((current) =>
      current.map((rule) => (rule.targetFieldId === targetFieldId ? { ...rule, choices } : rule)),
    );
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await apiClient.saveFieldMappingTemplate(
        { name: name.trim(), entityType, providerId, scope, itemType, rules },
        template?.id,
      );
      onSaved(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };
  const remove = async (id: string) => {
    setSaving(true);
    setError(null);
    try {
      await apiClient.deleteFieldMappingTemplate(id);
      onDeleted(id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSaving(false);
    }
  };

  return (
    <Modal open labelledBy={titleId} closeOnBackdrop={!saving} onClose={onClose}>
      <div className="flex max-h-[calc(100vh-2rem)] w-[40rem] max-w-[calc(100vw-2rem)] flex-col gap-4 rounded-xl border border-border bg-surface-1 p-6 text-sm shadow-2xl">
        <h2 id={titleId} className="text-lg font-semibold text-[var(--text-primary)]">
          {template
            ? pt
              ? 'Editar template de campos'
              : 'Edit field template'
            : pt
              ? 'Novo template de campos'
              : 'New field template'}
        </h2>
        {error && (
          <p role="alert" className="text-red-300">
            {error}
          </p>
        )}
        <label className="block">
          {pt ? 'Nome do template' : 'Template name'}
          <Input
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
            className="mt-1"
          />
        </label>
        <label className="block">
          {pt ? 'Buscar campo de destino' : 'Find destination field'}
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="mt-1"
          />
        </label>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
          {definitions
            .filter(
              (field) =>
                !field.readOnly &&
                `${field.name} ${field.id}`
                  .toLocaleLowerCase()
                  .includes(search.toLocaleLowerCase()),
            )
            .map((field) => {
              const rule = rules.find((item) => item.targetFieldId === field.id);
              const selected = rule ? sourceKey(rule.source) : '';
              return (
                <div key={field.id} className="rounded border border-[var(--border)] p-2">
                  <label className="block">
                    {field.name}{' '}
                    <span className="text-xs text-[var(--text-muted)]">({field.id})</span>
                    <Select
                      value={selected}
                      containerClassName="mt-1"
                      onChange={(event) => {
                        const value = event.target.value;
                        updateRule(
                          field.id,
                          value === 'constant'
                            ? { kind: 'constant', value: '' }
                            : (sources.find((option) => option.value === value)?.source ?? null),
                        );
                      }}
                    >
                      <option value="">{pt ? 'Não preencher' : 'Leave unchanged'}</option>
                      {sources.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                      <option value="constant">{pt ? 'Valor fixo' : 'Fixed value'}</option>
                    </Select>
                  </label>
                  {rule?.source.kind === 'constant' && (
                    <label className="mt-2 block">
                      {pt ? 'Valor' : 'Value'}
                      {field.options?.length ? (
                        <Select
                          value={String(rule.source.value ?? '')}
                          onChange={(event) =>
                            updateRule(field.id, { kind: 'constant', value: event.target.value })
                          }
                          containerClassName="mt-1"
                        >
                          <option value="">{pt ? 'Selecione' : 'Select'}</option>
                          {field.options.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.name}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <Input
                          value={String(rule.source.value ?? '')}
                          onChange={(event) =>
                            updateRule(field.id, { kind: 'constant', value: event.target.value })
                          }
                          className="mt-1"
                        />
                      )}
                    </label>
                  )}
                  {rule &&
                  rule.source.kind !== 'constant' &&
                  ['single_select', 'multi_select', 'iteration'].includes(field.type) ? (
                    <div className="mt-2 space-y-2">
                      <span className="text-xs text-[var(--text-muted)]">
                        {pt ? 'Converter valores da origem' : 'Convert source values'}
                      </span>
                      {Object.entries(rule.choices ?? {}).map(([sourceValue, targetValue]) => (
                        <div key={sourceValue} className="flex items-center gap-2">
                          <Input
                            aria-label={pt ? 'Valor de origem' : 'Source value'}
                            value={sourceValue}
                            readOnly
                            className="min-w-0 flex-1"
                          />
                          {field.options?.length ? (
                            <Select
                              aria-label={pt ? 'Valor de destino' : 'Target value'}
                              value={targetValue}
                              onChange={(event) =>
                                updateChoices(field.id, {
                                  ...rule.choices,
                                  [sourceValue]: event.target.value,
                                })
                              }
                              containerClassName="min-w-0 flex-1"
                            >
                              <option value="">{pt ? 'Selecione' : 'Select'}</option>
                              {field.options.map((option) => (
                                <option key={option.id} value={option.id}>
                                  {option.name}
                                </option>
                              ))}
                            </Select>
                          ) : (
                            <Input
                              aria-label={pt ? 'Valor de destino' : 'Target value'}
                              value={targetValue}
                              onChange={(event) =>
                                updateChoices(field.id, {
                                  ...rule.choices,
                                  [sourceValue]: event.target.value,
                                })
                              }
                              placeholder={
                                pt ? 'ID ou valor de destino' : 'Destination ID or value'
                              }
                              className="min-w-0 flex-1"
                            />
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              const next = { ...rule.choices };
                              delete next[sourceValue];
                              updateChoices(field.id, next);
                            }}
                          >
                            {pt ? 'Remover' : 'Remove'}
                          </Button>
                        </div>
                      ))}
                      <div className="flex gap-2">
                        <Input
                          aria-label={pt ? 'Novo valor de origem' : 'New source value'}
                          value={choiceDrafts[field.id] ?? ''}
                          onChange={(event) =>
                            setChoiceDrafts((current) => ({
                              ...current,
                              [field.id]: event.target.value,
                            }))
                          }
                          placeholder={pt ? 'Valor de origem' : 'Source value'}
                          className="min-w-0 flex-1"
                        />
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            const value = choiceDrafts[field.id]?.trim();
                            if (!value) return;
                            updateChoices(field.id, {
                              ...rule.choices,
                              [value]: field.options?.[0]?.id ?? '',
                            });
                            setChoiceDrafts((current) => ({ ...current, [field.id]: '' }));
                          }}
                        >
                          {pt ? 'Adicionar valor' : 'Add value'}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
        </div>
        <div className="flex items-center gap-2">
          {template && (
            <Button
              type="button"
              variant="destructive"
              disabled={saving}
              onClick={() => void remove(template.id)}
            >
              {pt ? 'Excluir' : 'Delete'}
            </Button>
          )}
          <div className="ml-auto flex gap-2">
            <Button type="button" variant="outline" disabled={saving} onClick={onClose}>
              {pt ? 'Cancelar' : 'Cancel'}
            </Button>
            <Button type="button" disabled={saving || !name.trim()} onClick={() => void save()}>
              {pt ? 'Salvar template' : 'Save template'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
