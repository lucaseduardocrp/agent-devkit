import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import { Modal } from '../../components/ui/modal.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { PbiItem, PbiProvider, PbiProviderId, PbiPushField } from './pbi-types.js';
import {
  FieldMappingEditor,
  type MappingSourceOption,
} from '../field-mapping/FieldMappingEditor.js';
import type { FieldValue } from '../field-mapping/types.js';

const providerNames: Record<PbiProviderId, string> = {
  azure_devops: 'Azure DevOps',
  trello: 'Trello',
  github_projects: 'GitHub Projects',
  jira: 'Jira',
};
const copy = {
  'pt-BR': {
    publish: 'Publicar',
    platform: 'Plataforma',
    linked: 'vinculado',
    loading: 'Carregando campos da plataforma...',
    loadError: 'Não foi possível carregar os campos da plataforma.',
    retry: 'Tentar novamente',
    select: 'Selecione...',
    none: 'Não atribuído',
    required: 'Obrigatório',
    unresolved: 'Não foi possível mapear “{source}”. Selecione um valor.',
    missing: 'Selecione um valor.',
    updateHint: 'O item vinculado será atualizado na plataforma.',
    createHint: 'O item será criado na plataforma escolhida e vinculado ao registro do ADK.',
    cancel: 'Cancelar',
    submit: 'Fazer push',
    labels: {
      workItemType: 'Tipo do work item',
      iterationPath: 'Iteration path',
      areaPath: 'Area path',
      assignee: 'Responsável',
      state: 'Estado',
      board: 'Board',
      list: 'Lista',
      member: 'Membro',
      issueType: 'Tipo da issue',
      status: 'Status',
      repository: 'Repositório (owner/nome)',
      project: 'Projeto',
    } as Record<string, string>,
  },
  'en-US': {
    publish: 'Publish',
    platform: 'Platform',
    linked: 'linked',
    loading: 'Loading platform fields...',
    loadError: 'Could not load the platform fields.',
    retry: 'Try again',
    select: 'Select...',
    none: 'Unassigned',
    required: 'Required',
    unresolved: 'Could not map “{source}”. Select a value.',
    missing: 'Select a value.',
    updateHint: 'The linked item will be updated on the platform.',
    createHint: 'The item will be created on the selected platform and linked to ADK.',
    cancel: 'Cancel',
    submit: 'Push',
    labels: {
      workItemType: 'Work item type',
      iterationPath: 'Iteration path',
      areaPath: 'Area path',
      assignee: 'Assignee',
      state: 'State',
      board: 'Board',
      list: 'List',
      member: 'Member',
      issueType: 'Issue type',
      status: 'Status',
      repository: 'Repository (owner/name)',
      project: 'Project',
    } as Record<string, string>,
  },
} as const;

/** ADK fields offered as mapping sources, with their label when the copy has none. */
const coreSourceLabels: Record<string, string> = {
  title: 'Title',
  description: 'Description',
  status: 'Status',
};

/** A required field without an acceptable value; shown in red and blocks the push. */
function isFieldInvalid(field: PbiPushField, value: string): boolean {
  if (!field.required) return false;
  if (!value.trim()) return true;
  return !field.allowCustom && !field.options.some((option) => option.value === value);
}

interface Props {
  apiClient: ApiClient;
  item: PbiItem | null;
  providers: readonly PbiProvider[];
  busy?: boolean;
  onClose: () => void;
  onSubmit: (
    item: PbiItem,
    providerId: PbiProviderId,
    fields: Record<string, string>,
    templateId?: string,
  ) => void;
}

/**
 * Push dialog driven by the provider push contract: each provider lists the fields it needs
 * (iteration, project, list...) and the ADK values it could map (assignee, state). Fields that
 * could not be mapped are highlighted until a value is chosen.
 */
export function PbiPushDialog({ apiClient, item, providers, busy, onClose, onSubmit }: Props) {
  const { locale } = useI18n();
  const c = copy[locale];
  const [providerId, setProviderId] = useState<PbiProviderId | null>(null);
  const [fields, setFields] = useState<PbiPushField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [update, setUpdate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState(0);
  // Choices sent to the backend; only fields that reload the contract change it.
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [templateId, setTemplateId] = useState('');
  const [templateVersion, setTemplateVersion] = useState(0);
  const [preview, setPreview] = useState<Record<string, FieldValue>>({});
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const valuesRef = useRef(values);
  valuesRef.current = values;

  useEffect(() => {
    if (!item) return;
    const first =
      providers.find(
        (provider) => !item.links.some((link) => link.providerId === provider.providerId),
      ) ?? providers[0];
    setProviderId(first?.providerId ?? null);
    setChosen({});
    setTemplateId('');
  }, [item, providers]);

  useEffect(() => {
    if (!item || !providerId) return;
    let active = true;
    setLoading(true);
    setError(null);
    void apiClient
      .getPbiPushContract(item.id, providerId, chosen)
      .then(
        (contract) => {
          if (!active) return;
          setFields(contract.fields);
          setUpdate(contract.update);
          // Keep what the person already picked for fields that are still offered.
          const previous = valuesRef.current;
          setValues(
            Object.fromEntries(
              contract.fields.map((field) => {
                const kept = previous[field.key];
                const keep =
                  kept !== undefined &&
                  !field.readOnly &&
                  (field.allowCustom ||
                    kept === '' ||
                    field.options.some((option) => option.value === kept));
                return [field.key, keep ? kept : field.value];
              }),
            ),
          );
        },
        (cause: unknown) => {
          if (active) setError(cause instanceof Error ? cause.message : c.loadError);
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [apiClient, item, providerId, chosen, request, c.loadError]);

  const changeProvider = (next: PbiProviderId) => {
    setFields([]);
    setValues({});
    setChosen({});
    setProviderId(next);
    setTemplateId('');
  };
  const destination = providers.find((provider) => provider.providerId === providerId);
  const settingScope =
    destination?.settings.project ??
    destination?.settings.projectKey ??
    destination?.settings.boardId ??
    destination?.settings.projectNumber;
  const scope =
    values.board ??
    values.project ??
    (typeof settingScope === 'string' || typeof settingScope === 'number'
      ? String(settingScope)
      : '');
  const itemType = values.workItemType ?? values.issueType ?? '';
  useEffect(() => {
    if (!item || !providerId || !templateId) {
      setPreview({});
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    let active = true;
    setPreviewLoading(true);
    setPreviewError(null);
    void apiClient
      .previewPbiFields(item.id, providerId, templateId, scope, itemType)
      .then(
        (result) => {
          if (active) setPreview(result.values);
        },
        (cause: unknown) => {
          if (active) setPreviewError(cause instanceof Error ? cause.message : String(cause));
        },
      )
      .finally(() => {
        if (active) setPreviewLoading(false);
      });
    return () => {
      active = false;
    };
  }, [apiClient, item, providerId, templateId, scope, itemType, templateVersion]);
  const sources: MappingSourceOption[] = item
    ? [
        ...Object.entries(coreSourceLabels).map(([key, fallback]) => ({
          value: `core::${key}`,
          label: c.labels[key] ?? fallback,
          source: { kind: 'core' as const, key },
        })),
        ...Object.entries(
          item.sourceData.customFields &&
            typeof item.sourceData.customFields === 'object' &&
            !Array.isArray(item.sourceData.customFields)
            ? (item.sourceData.customFields as Record<string, unknown>)
            : {},
        ).flatMap(([sourceProvider, fields]) =>
          fields && typeof fields === 'object' && !Array.isArray(fields)
            ? Object.keys(fields as Record<string, unknown>).map((key) => ({
                value: `custom:${sourceProvider}:${key}`,
                label: `${sourceProvider} · ${key}`,
                source: { kind: 'custom' as const, providerId: sourceProvider, key },
              }))
            : [],
        ),
      ]
    : [];
  const change = (field: PbiPushField, value: string) => {
    setValues((current) => ({ ...current, [field.key]: value }));
    if (field.reloadOnChange) setChosen({ ...valuesRef.current, [field.key]: value });
  };
  const invalid = fields.some((field) => isFieldInvalid(field, values[field.key] ?? ''));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!item || !providerId || invalid || loading || previewError || previewLoading) return;
    if (templateId) onSubmit(item, providerId, values, templateId);
    else onSubmit(item, providerId, values);
  };

  return (
    <Modal open={Boolean(item)} onClose={onClose} labelledBy="pbi-push-title">
      {item && (
        <form
          onSubmit={submit}
          className="max-h-[90vh] w-[min(92vw,560px)] space-y-4 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-6"
        >
          <h2 id="pbi-push-title" className="text-lg font-semibold">
            {c.publish} “{item.title}”
          </h2>
          <label className="block text-sm">
            {c.platform}
            <Select
              value={providerId ?? ''}
              onChange={(event) => changeProvider(event.target.value as PbiProviderId)}
              containerClassName="mt-1"
            >
              {providers.map((provider) => (
                <option key={provider.providerId} value={provider.providerId}>
                  {providerNames[provider.providerId]}
                  {item.links.some((link) => link.providerId === provider.providerId)
                    ? ` · ${c.linked}`
                    : ''}
                </option>
              ))}
            </Select>
          </label>
          {error ? (
            <div role="alert" className="flex items-center gap-2 text-sm text-red-300">
              <span>{error}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setRequest((value) => value + 1)}
              >
                {c.retry}
              </Button>
            </div>
          ) : (
            loading &&
            !fields.length && (
              <p role="status" className="text-sm text-[var(--text-muted)]">
                {c.loading}
              </p>
            )
          )}
          {fields.map((field) => {
            const value = values[field.key] ?? '';
            const fieldInvalid = isFieldInvalid(field, value);
            const id = `pbi-push-${field.key}`;
            const hintId = `${id}-hint`;
            const label = c.labels[field.key] ?? field.label;
            const hint = fieldInvalid
              ? field.status === 'unresolved' && field.source && !value
                ? c.unresolved.replace('{source}', field.source)
                : c.missing
              : null;
            return (
              <div key={field.key} className="text-sm">
                <label htmlFor={id} className="block">
                  {label}
                  {field.required && (
                    <span className="ml-1 text-red-400" title={c.required}>
                      *
                    </span>
                  )}
                </label>
                {field.allowCustom ? (
                  <>
                    <Input
                      id={id}
                      list={`${id}-options`}
                      value={value}
                      disabled={field.readOnly || loading}
                      variant={fieldInvalid ? 'error' : 'default'}
                      aria-invalid={fieldInvalid}
                      aria-describedby={hint ? hintId : undefined}
                      onChange={(event) =>
                        setValues((current) => ({ ...current, [field.key]: event.target.value }))
                      }
                      onBlur={(event) => {
                        if (field.reloadOnChange) change(field, event.target.value.trim());
                      }}
                      className="mt-1"
                    />
                    <datalist id={`${id}-options`}>
                      {field.options.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </datalist>
                  </>
                ) : (
                  <Select
                    id={id}
                    value={value}
                    disabled={field.readOnly || loading}
                    variant={fieldInvalid ? 'error' : 'default'}
                    aria-invalid={fieldInvalid}
                    aria-describedby={hint ? hintId : undefined}
                    onChange={(event) => change(field, event.target.value)}
                    containerClassName="mt-1"
                  >
                    <option value="">{field.required ? c.select : c.none}</option>
                    {field.options.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.detail ? `${option.label} · ${option.detail}` : option.label}
                      </option>
                    ))}
                  </Select>
                )}
                {hint && (
                  <p id={hintId} className="mt-1 text-xs text-red-300">
                    {hint}
                  </p>
                )}
              </div>
            );
          })}
          {fields.length > 0 && (
            <p className="text-xs text-[var(--text-muted)]">
              {update ? c.updateHint : c.createHint}
            </p>
          )}
          {providerId &&
            fields.length > 0 &&
            !(providerId === 'trello' && item?.kind === 'pbi') &&
            typeof apiClient.getFieldMappingTemplates === 'function' &&
            typeof apiClient.getPbiFieldCatalog === 'function' && (
              <FieldMappingEditor
                apiClient={apiClient}
                entityType="pbi"
                providerId={providerId}
                scope={scope}
                itemType={itemType}
                sources={sources}
                selectedId={templateId}
                onSelected={setTemplateId}
                onSaved={() => setTemplateVersion((value) => value + 1)}
              />
            )}
          {previewLoading && (
            <p role="status" className="text-xs">
              {locale === 'pt-BR' ? 'Validando mapeamento...' : 'Validating mapping...'}
            </p>
          )}
          {previewError && (
            <p role="alert" className="text-xs text-red-300">
              {previewError}
            </p>
          )}
          {templateId && !previewError && !previewLoading && Object.keys(preview).length > 0 && (
            <div className="rounded border border-[var(--border)] p-2 text-xs">
              <strong>{locale === 'pt-BR' ? 'Prévia dos campos' : 'Field preview'}</strong>
              {Object.entries(preview).map(([key, value]) => (
                <p key={key}>
                  {key}: {Array.isArray(value) ? value.join(', ') : String(value)}
                </p>
              ))}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {c.cancel}
            </Button>
            <Button
              type="submit"
              disabled={
                busy ||
                loading ||
                invalid ||
                !fields.length ||
                Boolean(previewError) ||
                previewLoading
              }
              isLoading={loading}
            >
              {c.submit}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
