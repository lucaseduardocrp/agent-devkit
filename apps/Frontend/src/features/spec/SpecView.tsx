import { ActionsMenu } from '../../components/ui/actions-menu.js';
import { HistoryViewer } from '../audit/HistoryViewer.js';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  ApiClient,
  SpecificationDto,
  SpecTemplateDto,
  SpecTemplateSectionDto,
} from '../../lib/api-client.js';
import { ResizableSidebar } from '../../components/layout/ResizableSidebar.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Select } from '../../components/ui/select.js';
import { Skeleton, SkeletonInput, SkeletonText } from '../../components/ui/skeleton.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Toast } from '../../components/ui/toast.js';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog.js';
import { useI18n, type I18nContextValue } from '../../lib/i18n/I18nContext.js';
import type { CustomAgentDto } from '../agents/agent-types.js';
import { MarkdownViewer } from '../brain/MarkdownViewer.js';
import { SpecWorkflowAction } from './SpecWorkflowAction.js';
import { GenerateTestPlanFromSource } from '../testplans/GenerateTestPlanFromSource.js';
import { useActivityRunner } from '../activities/ActivityCenter.js';
import { usePermissions } from '../workspaces/permissions.js';
import { AttachmentPanel } from '../shared/AttachmentPanel.js';
import { MarkdownImageTextarea } from '../shared/MarkdownImageTextarea.js';
import type { Attachment } from '../shared/attachment-types.js';
import { discardDrafts, saveWithDrafts } from '../shared/media.js';

type Translate = I18nContextValue['t'];

const getDefaultSections = (t: Translate): readonly SpecTemplateSectionDto[] => [
  { id: 'problem', title: t('spec.sectionProblem'), required: true },
  { id: 'actors', title: t('spec.sectionActors'), required: true },
  { id: 'requirements', title: t('spec.sectionRequirements'), required: true },
  { id: 'acceptance', title: t('spec.sectionAcceptance'), required: true },
  {
    id: 'dependencies',
    title: t('spec.sectionDependencies'),
    guidance: t('spec.sectionDependenciesGuidance'),
    required: false,
  },
];

type SpecPage = 'create' | 'settings';
type ToastState = { message: string; variant: 'success' | 'error' };

export interface SpecViewProps {
  readonly apiClient: ApiClient;
  readonly activeWorkspaceId: string | null;
  readonly canManageTemplates?: boolean;
  readonly isReadOnly?: boolean;
  readonly canPublishToBrain?: boolean;
}

const emptySections = (templateSections: readonly SpecTemplateSectionDto[]) =>
  templateSections.map((section) => ({
    templateSectionId: section.id,
    title: section.title,
    content: '',
  }));

export function SpecView({
  apiClient,
  activeWorkspaceId,
  canManageTemplates = true,
  isReadOnly = false,
  canPublishToBrain = true,
}: SpecViewProps) {
  const { t } = useI18n();
  const { runActivity } = useActivityRunner();
  const permissions = usePermissions();
  const canDeleteSpec = !isReadOnly && permissions.can('specs', 'delete');
  const canGenerateTestPlans = permissions.can('testplans', 'edit');
  const defaultSections = getDefaultSections(t);
  const [page, setPage] = useState<SpecPage>('create');
  const [templates, setTemplates] = useState<readonly SpecTemplateDto[]>([]);
  const [specs, setSpecs] = useState<readonly SpecificationDto[]>([]);
  const [agents, setAgents] = useState<readonly CustomAgentDto[]>([]);
  const [editingTemplateId, setEditingTemplateId] = useState<string>();
  const editingTemplate = templates.find((item) => item.id === editingTemplateId);
  const [templateName, setTemplateName] = useState(() => t('spec.defaultTemplate'));
  const [templateSections, setTemplateSections] =
    useState<readonly SpecTemplateSectionDto[]>(defaultSections);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [selectedSpec, setSelectedSpec] = useState<SpecificationDto | null>(null);
  // Read after awaits: the person may open another Spec while a request is pending.
  const selectedSpecRef = useRef(selectedSpec);
  selectedSpecRef.current = selectedSpec;
  const [title, setTitle] = useState(() => t('spec.defaultSpecificationTitle'));
  const [sections, setSections] = useState<SpecificationDto['sections']>(
    emptySections(defaultSections),
  );
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  // Unsaved edits, so leaving them (opening another spec or a new one) drops their drafts.
  const editing = useRef({ sections, attachments });
  editing.current = { sections, attachments };
  const [agentId, setAgentId] = useState('');
  const [message, setMessage] = useState('');
  const [toast, setToast] = useState<ToastState | null>(null);
  const [specToDelete, setSpecToDelete] = useState<SpecificationDto | null>(null);
  const [templateToDelete, setTemplateToDelete] = useState<SpecTemplateDto | null>(null);
  const [isDeletingSpec, setIsDeletingSpec] = useState(false);
  const [isSpecEditing, setIsSpecEditing] = useState(true);
  const isEditingSpec = isSpecEditing && !isReadOnly;
  const [isTemplateEditing, setIsTemplateEditing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [pendingAction, setPendingAction] = useState<
    'template' | 'spec' | 'chat' | 'proposal' | null
  >(null);
  const [parentId, setParentId] = useState<string>();
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set());
  const reloadSequence = useRef(0);
  const contextCleared = (saved: SpecificationDto) => {
    setSelectedSpec(saved);
    setSpecs((all) => all.map((item) => (item.id === saved.id ? saved : item)));
    setMessage('');
  };

  const reportError = (fallback: string, value: unknown) => {
    const message = value instanceof Error ? value.message : fallback;
    setToast({ message, variant: 'error' });
  };

  const reportSuccess = (message: string) => {
    setToast({ message, variant: 'success' });
  };

  const openSpec = useCallback((specification: SpecificationDto) => {
    discardDrafts(editing.current);
    setSelectedSpec(specification);
    setTitle(specification.title);
    setSections(specification.sections);
    setAttachments(specification.attachments ?? []);
    setAgentId(specification.agentId ?? '');
    setSelectedTemplateId(specification.templateId ?? '');
    setParentId(specification.parentId);
    setIsSpecEditing(false);
    setPage('create');
  }, []);

  const reload = useCallback(async () => {
    const sequence = ++reloadSequence.current;
    setTemplates([]);
    setSpecs([]);
    setAgents([]);
    setEditingTemplateId(undefined);
    setTemplateName(t('spec.defaultTemplate'));
    setTemplateSections(getDefaultSections(t));
    setSelectedTemplateId('');
    setSelectedSpec(null);
    setTemplateToDelete(null);
    setSpecToDelete(null);
    setIsTemplateEditing(false);
    setExpandedIds(new Set());
    if (!activeWorkspaceId) {
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    apiClient.setWorkspaceId(activeWorkspaceId);
    try {
      const [templateList, specificationList, agentList] = await Promise.all([
        apiClient.getSpecTemplates(),
        apiClient.getSpecifications(),
        apiClient.getAgents(),
      ]);
      if (sequence !== reloadSequence.current) return;
      setTemplates(templateList);
      setSpecs(specificationList);
      setExpandedIds(new Set(specificationList.map((specification) => specification.id)));
      setAgents(agentList);
      const firstTemplate = templateList[0];
      if (firstTemplate) {
        setEditingTemplateId(firstTemplate.id);
        setTemplateName(firstTemplate.name);
        setTemplateSections(firstTemplate.sections);
        setIsTemplateEditing(false);
        setSelectedTemplateId((current) => current || firstTemplate.id);
        setSections((current) =>
          current.some((section) => section.content)
            ? current
            : emptySections(firstTemplate.sections),
        );
      }
      // Readers cannot draft, so they land on a saved specification instead of a blank form.
      const firstSpecification = isReadOnly ? specificationList[0] : undefined;
      if (firstSpecification) openSpec(firstSpecification);
    } catch (value) {
      if (sequence !== reloadSequence.current) return;
      reportError(t('spec.loadFailed'), value);
    } finally {
      if (sequence === reloadSequence.current) setIsLoading(false);
    }
  }, [activeWorkspaceId, apiClient, isReadOnly, openSpec, t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const applyTemplateToSpec = (template: SpecTemplateDto) => {
    setSelectedTemplateId(template.id);
    setSections(emptySections(template.sections));
  };

  const editTemplate = (template: SpecTemplateDto) => {
    setEditingTemplateId(template.id);
    setTemplateName(template.name);
    setTemplateSections(template.sections);
    setIsTemplateEditing(false);
  };

  const newSpec = (newParentId?: string) => {
    const template = templates.find((item) => item.id === selectedTemplateId);
    discardDrafts(editing.current);
    setSelectedSpec(null);
    setTitle(
      newParentId ? t('spec.defaultSubspecificationTitle') : t('spec.defaultSpecificationTitle'),
    );
    setSections(emptySections(template?.sections ?? defaultSections));
    setAttachments([]);
    setAgentId('');
    setMessage('');
    setParentId(newParentId);
    setIsSpecEditing(true);
    setPage('create');
  };

  const saveTemplate = async () => {
    setPendingAction('template');
    try {
      const saved = await apiClient.saveSpecTemplate({
        id: editingTemplateId,
        name: templateName,
        sections: templateSections,
      });
      setTemplates((all) => [saved, ...all.filter((item) => item.id !== saved.id)]);
      setEditingTemplateId(saved.id);
      setIsTemplateEditing(false);
      reportSuccess(t('spec.templateSaved'));
    } catch (value) {
      reportError(t('spec.templateSaveFailed'), value);
    } finally {
      setPendingAction(null);
    }
  };

  const deleteTemplate = async (template: SpecTemplateDto) => {
    setPendingAction('template');
    try {
      await apiClient.deleteSpecTemplate(template.id);
      const remaining = templates.filter((item) => item.id !== template.id);
      setTemplates(remaining);
      const next = remaining[0];
      setEditingTemplateId(next?.id);
      setTemplateName(next?.name ?? t('spec.defaultTemplate'));
      setTemplateSections(next?.sections ?? defaultSections);
      setIsTemplateEditing(false);
      if (selectedTemplateId === template.id) setSelectedTemplateId(next?.id ?? '');
      setTemplateToDelete(null);
      reportSuccess(t('spec.templateDeleted'));
    } catch (value) {
      reportError(t('spec.templateDeleteFailed'), value);
    } finally {
      setPendingAction(null);
    }
  };

  const persistCurrentSpec = async () => {
    // Pasted and attached files are drafts until this save uploads them.
    const saved = await saveWithDrafts(apiClient, 'spec', { sections, attachments }, (files) =>
      apiClient.saveSpecification({
        id: selectedSpec?.id,
        templateId: selectedTemplateId || undefined,
        agentId: agentId || undefined,
        parentId,
        title,
        ...files,
      }),
    );
    setSections(saved.sections);
    setSelectedSpec(saved);
    setAttachments(saved.attachments ?? []);
    setSpecs((all) => [saved, ...all.filter((item) => item.id !== saved.id)]);
    setIsSpecEditing(false);
    return saved;
  };

  const saveSpec = async () => {
    setPendingAction('spec');
    try {
      await persistCurrentSpec();
      reportSuccess(t('spec.specificationSaved'));
    } catch (value) {
      reportError(t('spec.specificationSaveFailed'), value);
    } finally {
      setPendingAction(null);
    }
  };

  const chat = async () => {
    setPendingAction('chat');
    try {
      const specification =
        !selectedSpec || isSpecEditing ? await persistCurrentSpec() : selectedSpec;
      const saved = await runActivity(
        { kind: 'agent', title: `Agente trabalhando em “${specification.title}”` },
        () => apiClient.chatSpecification(specification.id, agentId, message.trim()),
      );
      setSelectedSpec(saved);
      setSpecs((all) => all.map((item) => (item.id === saved.id ? saved : item)));
      setTitle(saved.title);
      setSections(saved.sections);
      setMessage('');
      reportSuccess(t('spec.agentAnswered'));
    } catch (value) {
      reportError(t('spec.chatFailed'), value);
    } finally {
      setPendingAction(null);
    }
  };

  const applyAgentProposal = async () => {
    const specification = selectedSpec!;
    const proposal = specification.proposal!;
    const sectionUpdates = new Map(
      proposal.sections
        .filter((section) => section.content.trim())
        .map((section) => [section.templateSectionId, section.content]),
    );
    const proposedSections = sections.map((section) => ({
      ...section,
      content: sectionUpdates.get(section.templateSectionId) ?? section.content,
    }));
    const proposedTitle = proposal.title?.trim() || title;
    const titleChanged = proposedTitle !== title;
    const sectionsChanged = proposedSections.some(
      (section, index) => section.content !== sections[index]!.content,
    );
    const hasChanges = titleChanged || sectionsChanged;
    if (!hasChanges) {
      const { proposal: _proposal, ...withoutProposal } = specification;
      setSelectedSpec(withoutProposal);
      reportError(t('spec.proposalNoChanges'), undefined);
      return;
    }
    setPendingAction('proposal');
    try {
      const saved = await apiClient.saveSpecification({
        id: specification.id,
        templateId: specification.templateId,
        agentId,
        parentId,
        title: proposedTitle,
        sections: proposedSections,
      });
      setSelectedSpec(saved);
      setSpecs((all) => all.map((item) => (item.id === saved.id ? saved : item)));
      setTitle(saved.title);
      setSections(saved.sections);
      setIsSpecEditing(false);
      reportSuccess(t('spec.proposalApplied'));
    } catch (value) {
      reportError(t('spec.specificationSaveFailed'), value);
    } finally {
      setPendingAction(null);
    }
  };

  const download = async (specification: SpecificationDto) => {
    try {
      const markdown = await runActivity(
        { kind: 'download', title: `Baixando “${specification.title}.md”` },
        () => apiClient.exportSpecification(specification.id),
      );
      const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${specification.title}.md`;
      link.click();
      URL.revokeObjectURL(url);
      reportSuccess(t('spec.specificationExported'));
    } catch (value) {
      reportError(t('spec.exportFailed'), value);
    }
  };

  const deleteSpec = async (specification: SpecificationDto) => {
    setIsDeletingSpec(true);
    try {
      await apiClient.deleteSpecification(specification.id);
      setSpecs((all) => {
        const removed = new Set([specification.id]);
        let found = true;
        while (found) {
          found = false;
          for (const item of all) {
            if (item.parentId && removed.has(item.parentId) && !removed.has(item.id)) {
              removed.add(item.id);
              found = true;
            }
          }
        }
        return all.filter((item) => !removed.has(item.id));
      });
      if (selectedSpecRef.current?.id === specification.id) newSpec();
      setSpecToDelete(null);
      reportSuccess(t('spec.specificationDeleted'));
    } catch (value) {
      reportError(t('spec.deleteFailed'), value);
    } finally {
      setIsDeletingSpec(false);
    }
  };

  return (
    <div
      className="flex h-full min-h-0 w-full max-w-full overflow-hidden"
      data-testid="screen-spec"
    >
      <ResizableSidebar
        aria-label={t('spec.saved')}
        data-testid="spec-navigation-sidebar"
        defaultWidth={280}
        minWidth={220}
        maxWidth="container"
        resizeLabel={t('spec.resize')}
        className="overflow-hidden border-r border-border bg-surface-1"
      >
        <nav className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
          {!isReadOnly && (
            <Button
              variant={page === 'create' ? 'secondary' : 'ghost'}
              className="justify-start"
              aria-current={page === 'create' ? 'page' : undefined}
              onClick={() => newSpec()}
            >
              <i className="ti ti-file-plus" aria-hidden="true" /> {t('spec.createNav')}
            </Button>
          )}
          <Button
            variant={page === 'settings' ? 'secondary' : 'ghost'}
            className="justify-start"
            aria-current={page === 'settings' ? 'page' : undefined}
            onClick={() => setPage('settings')}
          >
            <i className="ti ti-settings" aria-hidden="true" /> {t('spec.settingsNav')}
          </Button>
          <h3 className="mt-5 text-sm font-semibold text-[var(--text-secondary)]">
            {t('spec.saved')}
          </h3>
          {specs.length === 0 && !isLoading && (
            <p className="text-sm text-[var(--text-secondary)]">{t('spec.empty')}</p>
          )}
          <SpecificationTree
            specifications={specs}
            expandedIds={expandedIds}
            selectedId={selectedSpec?.id}
            t={t}
            onToggle={(id) =>
              setExpandedIds((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onOpen={openSpec}
          />
        </nav>
      </ResizableSidebar>

      <main className="min-w-0 flex-1 overflow-y-auto p-5">
        {isLoading ? (
          <SpecLoadingSkeleton t={t} />
        ) : page === 'create' && isReadOnly && !selectedSpec ? (
          <p className="text-sm text-[var(--text-secondary)]">{t('spec.empty')}</p>
        ) : page === 'create' ? (
          <CreatePage
            clearControl={null}
            templates={templates}
            selectedTemplateId={selectedTemplateId}
            setSelectedTemplateId={setSelectedTemplateId}
            applyTemplate={applyTemplateToSpec}
            title={title}
            setTitle={setTitle}
            sections={sections}
            setSections={setSections}
            attachments={attachments}
            setAttachments={setAttachments}
            selectedSpec={selectedSpec}
            t={t}
            canEdit={!isReadOnly}
            canDelete={canDeleteSpec}
            isEditing={isEditingSpec}
            edit={() => setIsSpecEditing(true)}
            pending={pendingAction === 'spec'}
            save={() => void saveSpec()}
            reset={newSpec}
            createChild={() => selectedSpec && newSpec(selectedSpec.id)}
            deleteSpec={() => selectedSpec && setSpecToDelete(selectedSpec)}
            download={() => selectedSpec && void download(selectedSpec)}
            historyControl={
              selectedSpec && (
                <HistoryViewer
                  key={`history-${selectedSpec.id}`}
                  apiClient={apiClient}
                  workspaceId={activeWorkspaceId}
                  entityType="specification"
                  entityId={selectedSpec.id}
                  entityTitle={selectedSpec.title}
                />
              )
            }
            publishControl={
              selectedSpec &&
              !isReadOnly &&
              canPublishToBrain && (
                <SpecWorkflowAction
                  key={`publish-${selectedSpec.id}`}
                  apiClient={apiClient}
                  spec={selectedSpec}
                  action="publish"
                  disabled={isSpecEditing || pendingAction !== null}
                  onCleared={contextCleared}
                />
              )
            }
            testPlanControl={
              selectedSpec && canGenerateTestPlans ? (
                <GenerateTestPlanFromSource
                  apiClient={apiClient}
                  title={selectedSpec.title}
                  content={selectedSpec.sections
                    .filter((section) => section.content.trim())
                    .map((section) => `## ${section.title}\n\n${section.content.trim()}`)
                    .join('\n\n')}
                  sourceType="spec"
                  sourceId={selectedSpec.id}
                  disabled={isEditingSpec || pendingAction !== null}
                />
              ) : null
            }
          />
        ) : (
          <SettingsPage
            historyControl={
              editingTemplateId && (
                <HistoryViewer
                  key={editingTemplateId}
                  apiClient={apiClient}
                  workspaceId={activeWorkspaceId}
                  entityType="template"
                  entityId={editingTemplateId}
                  entityTitle={templateName}
                />
              )
            }
            canManageTemplates={canManageTemplates}
            t={t}
            templates={templates}
            editingTemplateId={editingTemplateId}
            templateName={templateName}
            templateSections={templateSections}
            pending={pendingAction === 'template'}
            isEditing={isTemplateEditing}
            edit={() => setIsTemplateEditing(true)}
            editTemplate={editTemplate}
            newTemplate={() => {
              setEditingTemplateId(undefined);
              setTemplateName(t('spec.newTemplate'));
              setTemplateSections(getDefaultSections(t));
              setIsTemplateEditing(true);
            }}
            setTemplateName={setTemplateName}
            setTemplateSections={setTemplateSections}
            saveTemplate={() => void saveTemplate()}
            requestDeleteTemplate={
              editingTemplate ? () => setTemplateToDelete(editingTemplate) : undefined
            }
          />
        )}
      </main>

      {page === 'create' && (
        <AgentPanel
          agents={agents}
          t={t}
          canChat={!isReadOnly}
          agentId={agentId}
          setAgentId={setAgentId}
          selectedSpec={selectedSpec}
          message={message}
          setMessage={setMessage}
          pending={pendingAction === 'chat'}
          proposalPending={pendingAction === 'proposal'}
          applyProposal={() => void applyAgentProposal()}
          send={() => void chat()}
          clearControl={
            selectedSpec &&
            !isReadOnly && (
              <SpecWorkflowAction
                key={`sidebar-clear-${selectedSpec.id}`}
                apiClient={apiClient}
                spec={selectedSpec}
                action="clear"
                disabled={
                  pendingAction !== null ||
                  (selectedSpec.messages.length === 0 && !selectedSpec.proposal)
                }
                onCleared={contextCleared}
                iconOnly
              />
            )
          }
        />
      )}
      {toast && (
        <Toast
          message={toast.message}
          variant={toast.variant}
          dismissLabel={t('spec.closeNotification')}
          onDismiss={() => setToast(null)}
        />
      )}
      <ConfirmationDialog
        open={Boolean(specToDelete)}
        title={t('common.delete')}
        description={t('spec.deleteConfirm', { title: specToDelete?.title ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        destructive
        isLoading={isDeletingSpec}
        onCancel={() => setSpecToDelete(null)}
        onConfirm={() => specToDelete && void deleteSpec(specToDelete)}
      />
      <ConfirmationDialog
        open={Boolean(templateToDelete)}
        title={t('spec.deleteTemplate')}
        description={t('spec.deleteTemplateConfirm', { name: templateToDelete?.name ?? '' })}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        destructive
        isLoading={pendingAction === 'template'}
        onCancel={() => setTemplateToDelete(null)}
        onConfirm={() => templateToDelete && void deleteTemplate(templateToDelete)}
      />
    </div>
  );
}

interface SpecificationTreeProps {
  readonly specifications: readonly SpecificationDto[];
  readonly expandedIds: ReadonlySet<string>;
  readonly selectedId?: string;
  readonly t: Translate;
  readonly onToggle: (id: string) => void;
  readonly onOpen: (specification: SpecificationDto) => void;
}

function SpecificationTree({
  specifications,
  expandedIds,
  selectedId,
  t,
  onToggle,
  onOpen,
}: SpecificationTreeProps) {
  const knownIds = new Set(specifications.map((specification) => specification.id));
  const roots = specifications.filter(
    (specification) => !specification.parentId || !knownIds.has(specification.parentId),
  );

  const renderBranch = (items: readonly SpecificationDto[], depth: number): ReactNode =>
    items.map((specification) => {
      const children = specifications.filter((item) => item.parentId === specification.id);
      const expanded = expandedIds.has(specification.id);
      return (
        <div key={specification.id}>
          <div
            className="flex min-w-0 items-center rounded-md hover:bg-surface-2"
            style={{ paddingLeft: `${depth * 16}px` }}
          >
            {children.length > 0 ? (
              <button
                type="button"
                className="grid h-8 w-7 shrink-0 place-items-center text-[var(--text-secondary)]"
                aria-expanded={expanded}
                aria-label={t(expanded ? 'spec.collapse' : 'spec.expand', {
                  title: specification.title,
                })}
                onClick={() => onToggle(specification.id)}
              >
                <i
                  className={`ti ${expanded ? 'ti-chevron-down' : 'ti-chevron-right'}`}
                  aria-hidden="true"
                />
              </button>
            ) : (
              <span className="w-7 shrink-0" aria-hidden="true" />
            )}
            <button
              type="button"
              className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-2 text-left text-sm ${
                selectedId === specification.id
                  ? 'font-medium text-primary'
                  : 'text-[var(--text-secondary)]'
              }`}
              aria-current={selectedId === specification.id ? 'page' : undefined}
              onClick={() => onOpen(specification)}
            >
              <i className="ti ti-file-description shrink-0" aria-hidden="true" />
              <span className="truncate">{specification.title}</span>
              {children.length > 0 && (
                <span className="ml-auto shrink-0 text-xs opacity-70" aria-hidden="true">
                  {children.length}
                </span>
              )}
            </button>
          </div>
          {children.length > 0 && expanded && renderBranch(children, depth + 1)}
        </div>
      );
    });

  return <div className="space-y-0.5">{renderBranch(roots, 0)}</div>;
}

interface CreatePageProps {
  clearControl: ReactNode;
  historyControl: ReactNode;
  publishControl: ReactNode;
  testPlanControl: ReactNode;
  t: Translate;
  templates: readonly SpecTemplateDto[];
  selectedTemplateId: string;
  setSelectedTemplateId(value: string): void;
  applyTemplate(template: SpecTemplateDto): void;
  title: string;
  setTitle(value: string): void;
  sections: SpecificationDto['sections'];
  setSections(
    value:
      | SpecificationDto['sections']
      | ((current: SpecificationDto['sections']) => SpecificationDto['sections']),
  ): void;
  selectedSpec: SpecificationDto | null;
  attachments: readonly Attachment[];
  setAttachments(value: Attachment[]): void;
  canEdit: boolean;
  canDelete: boolean;
  isEditing: boolean;
  edit(): void;
  pending: boolean;
  save(): void;
  reset(): void;
  createChild(): void;
  deleteSpec(): void;
  download(): void;
}

function CreatePage(props: CreatePageProps) {
  return (
    <section className="mx-auto max-w-5xl space-y-4" aria-labelledby="spec-create-title">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 id="spec-create-title" className="text-xl font-semibold">
            {props.t('spec.createTitle')}
          </h1>
          <p className="text-sm text-[var(--text-secondary)]">{props.t('spec.createSubtitle')}</p>
        </div>
        <ActionsMenu key={props.selectedSpec?.id ?? 'new'}>
          {props.historyControl}
          {props.publishControl}
          {props.testPlanControl}
          {props.clearControl}

          {props.selectedSpec && (
            <Button variant="secondary" onClick={() => props.download()}>
              <i className="ti ti-download" aria-hidden="true" />
              {props.t('spec.exportMarkdown')}
            </Button>
          )}

          {props.selectedSpec && props.canEdit && !props.isEditing && (
            <Button onClick={() => props.edit()}>
              <i className="ti ti-edit" aria-hidden="true" />
              {props.t('common.edit')}
            </Button>
          )}

          {props.selectedSpec && props.canEdit && (
            <Button variant="secondary" onClick={() => props.createChild()}>
              <i className="ti ti-file-plus" aria-hidden="true" />
              {props.t('spec.newSubspecification')}
            </Button>
          )}

          {props.canEdit && (
            <Button variant="secondary" onClick={() => props.reset()}>
              <i className="ti ti-file-plus" aria-hidden="true" />
              {props.t('spec.newSpecification')}
            </Button>
          )}

          {props.selectedSpec && props.canDelete && (
            <Button data-destructive variant="destructive" onClick={() => props.deleteSpec()}>
              <i className="ti ti-trash" aria-hidden="true" />
              {props.t('common.delete')}
            </Button>
          )}
        </ActionsMenu>
      </header>
      <div className="space-y-3 rounded-lg border border-border bg-surface-1 p-4">
        <label className="block text-sm font-medium" htmlFor="spec-template">
          {props.t('spec.template')}
        </label>
        <Select
          id="spec-template"
          aria-label={props.t('spec.template')}
          value={props.selectedTemplateId}
          disabled={!props.isEditing}
          onChange={(event) => {
            props.setSelectedTemplateId(event.target.value);
            const template = props.templates.find((item) => item.id === event.target.value);
            if (template) props.applyTemplate(template);
          }}
        >
          <option value="">{props.t('spec.defaultTemplate')}</option>
          {props.templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name}
            </option>
          ))}
        </Select>
        <label className="block text-sm font-medium" htmlFor="spec-title">
          {props.t('spec.title')}
        </label>
        <Input
          id="spec-title"
          aria-label={props.t('spec.title')}
          value={props.title}
          readOnly={!props.isEditing}
          onChange={(event) => props.setTitle(event.target.value)}
        />
        {props.sections.map((section) => (
          <div className="min-w-0 text-sm" key={section.templateSectionId}>
            <span className="mb-1 block font-medium">{section.title}</span>
            {props.isEditing ? (
              <MarkdownImageTextarea
                scope="spec"
                quiet
                aria-label={section.title}
                className="min-h-40 font-mono text-sm leading-relaxed"
                value={section.content}
                onValueChange={(content) =>
                  props.setSections((all) =>
                    all.map((item) =>
                      item.templateSectionId === section.templateSectionId
                        ? { ...item, content }
                        : item,
                    ),
                  )
                }
              />
            ) : (
              <div
                role="region"
                aria-label={section.title}
                className="min-h-20 overflow-x-auto rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-4"
              >
                <MarkdownViewer content={section.content} showModeToggle={false} />
              </div>
            )}
          </div>
        ))}
        {props.isEditing && (
          <p className="text-xs text-[var(--text-muted)]">{props.t('spec.imageHint')}</p>
        )}
        <AttachmentPanel
          scope="spec"
          attachments={props.attachments}
          disabled={!props.isEditing}
          onChange={(attachments) => props.setAttachments(attachments)}
        />
        {props.canEdit && (
          <div className="flex flex-wrap gap-2">
            <Button
              isLoading={props.pending}
              disabled={!props.isEditing}
              onClick={() => props.save()}
            >
              {props.t('spec.saveSpecification')}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

interface SettingsPageProps {
  historyControl: ReactNode;
  t: Translate;
  canManageTemplates: boolean;
  templates: readonly SpecTemplateDto[];
  editingTemplateId?: string;
  templateName: string;
  templateSections: readonly SpecTemplateSectionDto[];
  pending: boolean;
  isEditing: boolean;
  edit(): void;
  editTemplate(template: SpecTemplateDto): void;
  newTemplate(): void;
  setTemplateName(value: string): void;
  setTemplateSections(
    value:
      | readonly SpecTemplateSectionDto[]
      | ((current: readonly SpecTemplateSectionDto[]) => readonly SpecTemplateSectionDto[]),
  ): void;
  saveTemplate(): void;
  /** Present while a saved template is open for editing. */
  requestDeleteTemplate?: () => void;
}

function SettingsPage(props: SettingsPageProps) {
  return (
    <section className="mx-auto max-w-5xl space-y-5" aria-labelledby="spec-settings-title">
      <header>
        <h1 id="spec-settings-title" className="text-xl font-semibold">
          {props.t('spec.settingsTitle')}
        </h1>
        <p className="text-sm text-[var(--text-secondary)]">{props.t('spec.settingsSubtitle')}</p>
      </header>
      <div className="rounded-lg border border-border bg-surface-1 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="font-semibold">{props.t('spec.templates')}</h2>
          {props.canManageTemplates && (
            <ActionsMenu key={props.editingTemplateId ?? 'new-template'}>
              {props.historyControl}
              {props.requestDeleteTemplate && (
                <Button
                  variant="destructive"
                  disabled={props.pending || props.isEditing}
                  data-destructive
                  onClick={props.requestDeleteTemplate}
                >
                  {props.t('spec.deleteTemplate')}
                </Button>
              )}
              {props.editingTemplateId && !props.isEditing && (
                <Button size="sm" onClick={() => props.edit()}>
                  {props.t('common.edit')}
                </Button>
              )}
              <Button variant="secondary" size="sm" onClick={() => props.newTemplate()}>
                {props.t('spec.newTemplate')}
              </Button>
            </ActionsMenu>
          )}
        </div>
        {!props.canManageTemplates ? (
          <p className="text-sm text-[var(--text-secondary)]">{props.t('spec.managersOnly')}</p>
        ) : (
          <>
            {props.templates.length > 0 && (
              <Select
                aria-label={props.t('spec.templateToEdit')}
                value={props.editingTemplateId ?? ''}
                disabled={props.isEditing}
                onChange={(event) => {
                  const template = props.templates.find((item) => item.id === event.target.value);
                  if (template) props.editTemplate(template);
                  else props.newTemplate();
                }}
              >
                <option value="">{props.t('spec.newTemplate')}</option>
                {props.templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </Select>
            )}
            <label className="mt-3 block text-sm font-medium" htmlFor="template-title">
              {props.t('spec.title')}
            </label>
            <Input
              id="template-title"
              className="mt-3"
              aria-label={props.t('spec.templateName')}
              value={props.templateName}
              readOnly={!props.isEditing}
              onChange={(event) => props.setTemplateName(event.target.value)}
            />
            {props.templateSections.map((section, index) => (
              <div className="mt-2 flex gap-2" key={section.id}>
                <Input
                  aria-label={props.t('spec.section', { number: index + 1 })}
                  value={section.title}
                  readOnly={!props.isEditing}
                  onChange={(event) =>
                    props.setTemplateSections((all) =>
                      all.map((item) =>
                        item.id === section.id ? { ...item, title: event.target.value } : item,
                      ),
                    )
                  }
                />
                <Button
                  variant="destructive"
                  disabled={!props.isEditing}
                  onClick={() =>
                    props.setTemplateSections((all) => all.filter((item) => item.id !== section.id))
                  }
                >
                  {props.t('spec.remove')}
                </Button>
              </div>
            ))}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={!props.isEditing}
                onClick={() =>
                  props.setTemplateSections((all) => [
                    ...all,
                    {
                      id: crypto.randomUUID(),
                      title: props.t('spec.newSection'),
                      required: false,
                    },
                  ])
                }
              >
                {props.t('spec.addSection')}
              </Button>
              <Button
                isLoading={props.pending}
                disabled={!props.isEditing}
                onClick={() => props.saveTemplate()}
              >
                {props.t('spec.saveTemplate')}
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

interface AgentPanelProps {
  clearControl: ReactNode;
  t: Translate;
  canChat: boolean;
  agents: readonly CustomAgentDto[];
  agentId: string;
  setAgentId(value: string): void;
  selectedSpec: SpecificationDto | null;
  message: string;
  setMessage(value: string): void;
  pending: boolean;
  proposalPending: boolean;
  applyProposal(): void;
  send(): void;
}

function AgentPanel(props: AgentPanelProps) {
  return (
    <ResizableSidebar
      aria-label={props.t('spec.collaboration')}
      data-testid="spec-agent-sidebar"
      defaultWidth={360}
      minWidth={280}
      maxWidth="container"
      resizeEdge="left"
      resizeLabel={props.t('spec.resize')}
      className="overflow-hidden border-l border-border bg-surface-1"
    >
      <section className="flex min-h-0 flex-1 flex-col p-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-semibold">{props.t('spec.collaboration')}</h2>
          {props.clearControl}
        </div>
        {props.canChat && (
          <Select
            aria-label={props.t('spec.collaboration')}
            className="mt-3"
            value={props.agentId}
            onChange={(event) => props.setAgentId(event.target.value)}
          >
            <option value="">{props.t('spec.selectAgent')}</option>
            {props.agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </Select>
        )}
        <div className="thin-scrollbar my-3 min-h-0 flex-1 space-y-4 overflow-y-auto overflow-x-hidden pr-1">
          {props.canChat && !props.selectedSpec && (
            <p className="text-sm text-[var(--text-secondary)]">{props.t('spec.saveBeforeChat')}</p>
          )}
          {props.selectedSpec?.messages.map((item) => (
            <article
              key={item.id}
              className={`min-w-0 rounded-lg border p-3 text-sm ${
                item.role === 'assistant'
                  ? 'border-blue-500/20 bg-blue-500/10'
                  : 'border-border bg-surface-2'
              }`}
            >
              <header className="mb-2 flex items-center gap-2 text-xs font-semibold text-[var(--text-secondary)]">
                <i
                  className={`ti ${item.role === 'assistant' ? 'ti-sparkles' : 'ti-user'}`}
                  aria-hidden="true"
                />
                {item.role === 'assistant' ? 'Agent' : props.t('spec.you')}
              </header>
              {item.role === 'assistant' ? (
                <MarkdownViewer
                  content={item.content}
                  showModeToggle={false}
                  className="min-w-0 overflow-hidden [&_pre]:max-w-full"
                />
              ) : (
                <p className="break-words whitespace-pre-wrap text-[var(--text-primary)]">
                  {item.content}
                </p>
              )}
            </article>
          ))}
        </div>
        {props.canChat && (
          <>
            {props.selectedSpec?.proposal && (
              <div className="mb-3 rounded-lg border border-blue-500/30 bg-blue-500/10 p-3">
                <p className="mb-2 text-sm text-[var(--text-secondary)]">
                  {props.t('spec.proposalReady')}
                </p>
                <Button
                  className="w-full"
                  isLoading={props.proposalPending}
                  onClick={() => props.applyProposal()}
                >
                  {props.t('spec.applyProposal')}
                </Button>
              </div>
            )}
            <Textarea
              aria-label={props.t('spec.message')}
              value={props.message}
              onChange={(event) => props.setMessage(event.target.value)}
              placeholder={props.t('spec.messagePlaceholder')}
            />
            <Button
              className="mt-2"
              isLoading={props.pending}
              disabled={!props.agentId || !props.message.trim()}
              onClick={() => props.send()}
            >
              {props.t('spec.send')}
            </Button>
          </>
        )}
      </section>
    </ResizableSidebar>
  );
}

function SpecLoadingSkeleton({ t }: { readonly t: Translate }) {
  return (
    <section
      role="status"
      aria-label={t('spec.loading')}
      data-testid="spec-loading-skeleton"
      className="mx-auto max-w-5xl space-y-4"
    >
      <Skeleton className="h-7 w-40 rounded" />
      <SkeletonText lines={2} />
      <div className="space-y-4 rounded-lg border border-border bg-surface-1 p-4">
        <SkeletonInput />
        <SkeletonInput />
        <Skeleton className="h-28 w-full rounded" />
        <Skeleton className="h-28 w-full rounded" />
      </div>
    </section>
  );
}
