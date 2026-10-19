import React, { useState, useEffect } from 'react';
import { cn } from '../../lib/utils.js';
import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Select } from '../../components/ui/select.js';
import { MarkdownViewer } from '../brain/MarkdownViewer.js';
import { AGENT_TEMPLATES } from './agent-templates.js';
import { useI18n } from '../../lib/i18n/index.js';
import { usePermissions } from '../workspaces/permissions.js';
import type { AgentRole, CustomAgentDto, CreateAgentDto, UpdateAgentDto } from './agent-types.js';

export interface AgentLlmModelOption {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly model: string;
}

export interface AgentModalProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onSave: (data: CreateAgentDto | UpdateAgentDto) => Promise<void>;
  readonly initialData?: CustomAgentDto | null;
  readonly isSaving?: boolean;
  readonly availableLlmModels?: readonly AgentLlmModelOption[];
  readonly agents?: readonly CustomAgentDto[];
}

export function AgentModal({
  isOpen,
  onClose,
  onSave,
  initialData,
  isSaving = false,
  availableLlmModels = [],
  agents = [],
}: AgentModalProps): React.JSX.Element | null {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [role, setRole] = useState<AgentRole>('CUSTOM');
  const [model, setModel] = useState('');
  const [temperature, setTemperature] = useState(0.2);
  const [parentAgentId, setParentAgentId] = useState('');
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const [error, setError] = useState<string | null>(null);

  const eligibleParents = agents.filter((candidate) => {
    if (!initialData) return true;
    const seen = new Set<string>();
    let current: CustomAgentDto | undefined = candidate;
    while (current && !seen.has(current.id)) {
      if (current.id === initialData.id) return false;
      seen.add(current.id);
      current = agents.find((agent) => agent.id === current?.parentAgentId);
    }
    return true;
  });

  useEffect(() => {
    if (initialData) {
      setName(initialData.name);
      setSlug(initialData.slug);
      setDescription(initialData.description);
      setInstructions(initialData.instructions);
      setRole(initialData.role);
      setModel(initialData.model ?? '');
      setTemperature(initialData.temperature);
      setParentAgentId(initialData.parentAgentId ?? '');
    } else {
      setName('');
      setSlug('');
      setDescription('');
      setInstructions('');
      setRole('CUSTOM');
      setModel('');
      setTemperature(0.2);
      setParentAgentId('');
    }
    setTab('edit');
    setError(null);
  }, [initialData, isOpen]);

  if (!isOpen) return null;

  const handleApplyTemplate = (templateId: string) => {
    const tpl = AGENT_TEMPLATES.find((t) => t.id === templateId);
    /* v8 ignore next */
    if (!tpl) return;
    setName(t(tpl.nameKey));
    setDescription(t(tpl.descriptionKey));
    setInstructions(tpl.instructions);
    setRole(tpl.role);
    setModel(availableLlmModels.some((option) => option.model === tpl.model) ? tpl.model : '');
    setTemperature(tpl.temperature);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t('runtime.agentNameRequired'));
      return;
    }
    const trimmedInstructions = instructions.trim();
    if (!trimmedInstructions) {
      setError(t('runtime.agentInstructionsRequired'));
      return;
    }
    if (
      model &&
      !availableLlmModels.some((option) => option.model === model) &&
      model !== initialData?.model
    ) {
      setError(t('runtime.activeAiModelRequired'));
      return;
    }

    try {
      setError(null);
      await onSave({
        name: trimmedName,
        slug: slug.trim() || undefined,
        description: description.trim() || undefined,
        instructions: trimmedInstructions,
        role,
        model: model.trim(),
        temperature,
        parentAgentId: parentAgentId || null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('runtime.saveAgentFailed'));
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="agent-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
    >
      <div className="flex max-h-[92vh] w-[min(96vw,1800px)] flex-col rounded-xl border border-[var(--border)] bg-[var(--surface-1)] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--border)] px-6 py-4">
          <div className="flex items-center gap-2">
            <i className="ti ti-robot text-xl text-[var(--fill-accent)]" aria-hidden="true" />
            <h2 id="agent-modal-title" className="text-lg font-semibold text-[var(--text-primary)]">
              {initialData ? t('agents.editAgent') : t('runtime.agentInstructionTitle')}
            </h2>
          </div>
          <IconButton
            icon={<i className="ti ti-x text-lg" aria-hidden="true" />}
            label={t('runtime.closeModal')}
            onClick={onClose}
            size="sm"
          />
        </div>

        {/* Content / Form */}
        <form
          noValidate
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
          className="flex flex-1 flex-col overflow-hidden"
        >
          <div className="flex-1 space-y-4 overflow-y-auto p-6">
            {error && (
              <div
                role="alert"
                className="flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-400"
              >
                <i className="ti ti-alert-triangle text-base" aria-hidden="true" />
                <span>{error}</span>
              </div>
            )}

            {/* Template Selector for New Agents */}
            {!initialData && (
              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3">
                <label
                  htmlFor="template-select"
                  className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]"
                >
                  {t('runtime.predefinedTemplate')}
                </label>
                <div className="flex flex-wrap gap-2">
                  {AGENT_TEMPLATES.map((template) => (
                    <Button
                      key={template.id}
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleApplyTemplate(template.id)}
                      className="text-xs"
                    >
                      {t(template.nameKey)}
                    </Button>
                  ))}
                </div>
              </div>
            )}

            {/* Basic Info */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label
                  htmlFor="agent-name"
                  className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
                >
                  {t('runtime.agentName')}
                </label>
                <Input
                  id="agent-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('agents.namePlaceholder')}
                  required
                />
              </div>

              <div>
                <label
                  htmlFor="agent-slug"
                  className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
                >
                  {t('runtime.slugOptionalLabel')}
                </label>
                <Input
                  id="agent-slug"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value)}
                  placeholder={t('workspaces.slugExample')}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <label
                  htmlFor="agent-role"
                  className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
                >
                  {t('runtime.specialtyRole')}
                </label>
                <Select
                  id="agent-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as AgentRole)}
                >
                  <option value="QA">{t('runtime.roleQaTests')}</option>
                  <option value="DOCUMENTATION">{t('runtime.roleDocumentation')}</option>
                  <option value="REFACTOR">{t('runtime.roleRefactoring')}</option>
                  <option value="CUSTOM">{t('runtime.roleCustomized')}</option>
                </Select>
              </div>

              <div>
                <label
                  htmlFor="agent-model"
                  className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
                >
                  {t('agents.model')}
                </label>
                <Select id="agent-model" value={model} onChange={(e) => setModel(e.target.value)}>
                  <option value="">{t('runtime.noAgentModel')}</option>
                  {initialData?.model &&
                    !availableLlmModels.some((option) => option.model === initialData.model) && (
                      <option value={initialData.model} disabled>
                        {initialData.model} ({t('runtime.unavailableIntegration')})
                      </option>
                    )}
                  {availableLlmModels.map((option) => (
                    <option key={`${option.providerId}:${option.model}`} value={option.model}>
                      {option.providerLabel} — {option.model}
                    </option>
                  ))}
                </Select>
                {availableLlmModels.length === 0 && can('integrations', 'edit') && (
                  <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                    {t('runtime.agentWithoutModelHelp')}
                  </p>
                )}
              </div>

              <div>
                <label
                  htmlFor="agent-temperature"
                  className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
                >
                  {t('agents.temperature')} ({temperature})
                </label>
                <Input
                  id="agent-temperature"
                  type="number"
                  min="0"
                  max="2"
                  step="0.05"
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value) || 0)}
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="agent-parent"
                className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
              >
                {t('agents.parentAgent')}
              </label>
              <Select
                id="agent-parent"
                value={parentAgentId}
                onChange={(event) => setParentAgentId(event.target.value)}
              >
                <option value="">{t('agents.noParentAgent')}</option>
                {eligibleParents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </Select>
              <p className="mt-1 text-xs text-[var(--text-muted)]">{t('agents.parentAgentHelp')}</p>
            </div>

            <div>
              <label
                htmlFor="agent-description"
                className="mb-1 block text-xs font-medium text-[var(--text-secondary)]"
              >
                {t('runtime.shortDescription')}
              </label>
              <Input
                id="agent-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('runtime.shortAgentDescriptionPlaceholder')}
              />
            </div>

            {/* Instructions Markdown Editor / Preview */}
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label
                  htmlFor="agent-instructions"
                  className="text-xs font-medium text-[var(--text-secondary)]"
                >
                  {t('runtime.agentInstructionsMd')}
                </label>
                <div className="flex rounded-md border border-[var(--border)] p-0.5 text-xs">
                  <Button
                    type="button"
                    size="sm"
                    variant={tab === 'edit' ? 'default' : 'ghost'}
                    onClick={() => setTab('edit')}
                    className={cn(
                      'h-7 px-2.5 text-xs font-medium',
                      tab === 'edit'
                        ? 'bg-[var(--fill-accent)] text-[#0d1b2c]'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                    )}
                  >
                    {t('common.edit')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={tab === 'preview' ? 'default' : 'ghost'}
                    onClick={() => setTab('preview')}
                    className={cn(
                      'h-7 px-2.5 text-xs font-medium',
                      tab === 'preview'
                        ? 'bg-[var(--fill-accent)] text-[#0d1b2c]'
                        : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                    )}
                  >
                    {t('common.preview')}
                  </Button>
                </div>
              </div>

              {tab === 'edit' ? (
                <Textarea
                  id="agent-instructions"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  rows={10}
                  className="font-mono text-xs leading-relaxed"
                  placeholder={t('runtime.agentInstructionsPlaceholder')}
                  required
                />
              ) : (
                <div className="max-h-60 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-4">
                  {instructions.trim() ? (
                    <MarkdownViewer content={instructions} showModeToggle={false} />
                  ) : (
                    <p className="text-xs italic text-[var(--text-muted)]">
                      {t('runtime.noInstructionsYet')}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-3 border-t border-[var(--border)] px-6 py-4">
            <Button type="button" variant="outline" onClick={onClose} disabled={isSaving}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? (
                <>
                  <i className="ti ti-loader-2 animate-spin text-base" aria-hidden="true" />
                  <span>{t('runtime.saving')}</span>
                </>
              ) : (
                <span>{initialData ? t('runtime.updateAgent') : t('runtime.createAgent')}</span>
              )}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
