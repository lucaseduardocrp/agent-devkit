import React, { useState, useEffect, useCallback } from 'react';
import { cn } from '../../lib/utils.js';
import { Button } from '../../components/ui/button.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Select } from '../../components/ui/select.js';
import { Badge } from '../../components/ui/badge.js';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from '../../components/ui/card.js';
import { MarkdownViewer } from '../brain/MarkdownViewer.js';
import { AgentModal, type AgentLlmModelOption } from './AgentModal.js';
import { AgentTopology } from './AgentTopology.js';
import type { AgentRun, Issue } from '../issues/issue-types.js';
import { ApiClient } from '../../lib/api-client.js';
import type {
  CustomAgentDto,
  CreateAgentDto,
  UpdateAgentDto,
  AgentRole,
  ExecuteAgentResponse,
  AgentWorkflowDto,
  AgentWorkflowRuleDto,
  AgentWorkflowStepDto,
  AgentWorkflowToolset,
} from './agent-types.js';
import { useActivityRunner } from '../activities/ActivityCenter.js';
import { useI18n } from '../../lib/i18n/index.js';
import { usePermissions } from '../workspaces/permissions.js';

export interface AgentsViewProps {
  readonly apiClient?: ApiClient;
  readonly activeWorkspaceId?: string | null;
  readonly isReadOnly?: boolean;
  readonly className?: string;
}

const defaultApiClient = new ApiClient();

const roleBadgeMap: Record<AgentRole, 'success' | 'default' | 'pro' | 'outline'> = {
  QA: 'success',
  DOCUMENTATION: 'default',
  REFACTOR: 'pro',
  CUSTOM: 'outline',
};

const workflowToolNames: Record<AgentWorkflowToolset, readonly string[]> = {
  all: [],
  agents: [
    'agents_create',
    'agents_delete',
    'agents_execute',
    'agents_update',
    'agents_workflow_update',
  ],
  integrations: ['integrations_delete', 'integrations_save', 'integrations_test'],
  brain: [
    'brain_add_relation',
    'brain_create_document',
    'brain_delete_document',
    'brain_publish_document',
    'brain_remove_relation',
    'brain_sync',
    'brain_update_document',
  ],
  issues: [
    'issues_cancel_run',
    'issues_comment',
    'issues_create',
    'issues_delete',
    'issues_delete_rate',
    'issues_inbox_update',
    'issues_run_server',
    'issues_set_budget',
    'issues_set_rate',
    'issues_update',
  ],
  pbi: [
    'pbi_create',
    'pbi_create_issue',
    'pbi_delete',
    'pbi_link',
    'pbi_pull',
    'pbi_push',
    'pbi_sync_children',
    'pbi_unlink',
    'pbi_update',
  ],
  spec: [
    'spec_chat',
    'spec_clear_chat',
    'spec_delete',
    'spec_delete_template',
    'spec_generate_from_brain',
    'spec_publish_to_brain',
    'spec_save',
    'spec_save_chat_reply',
    'spec_save_template',
    'spec_update_sections',
  ],
  testplans: [
    'testplans_create_suite',
    'testplans_delete',
    'testplans_delete_suite',
    'testplans_generate',
    'testplans_import_cases',
    'testplans_push_suite',
    'testplans_save',
    'testplans_update',
    'testplans_update_suite',
  ],
  design: [
    'design_chat',
    'design_create_project',
    'design_delete_project',
    'design_delete_system',
    'design_generate_system',
    'design_save_new_project',
    'design_save_system',
    'design_update_files',
  ],
  e2e: [
    'e2e_cancel',
    'e2e_create',
    'e2e_delete',
    'e2e_import_cases',
    'e2e_link_case',
    'e2e_publish_run',
    'e2e_pull_scripts',
    'e2e_run',
    'e2e_run_test',
    'e2e_save_plan',
    'e2e_set_execution',
    'e2e_set_reporting',
    'e2e_update',
    'e2e_update_script',
  ],
  releasenotes: [
    'release_notes_create',
    'release_notes_delete',
    'release_notes_generate',
    'release_notes_update',
  ],
  audit: [],
  workspaces: [
    'workspaces_add_member',
    'workspaces_create',
    'workspaces_delete',
    'workspaces_delete_group',
    'workspaces_list',
    'workspaces_list_groups',
    'workspaces_list_members',
    'workspaces_rename',
    'workspaces_remove_member',
    'workspaces_save_group',
    'workspaces_select',
    'workspaces_update_member',
  ],
};

export function AgentsView({
  apiClient = defaultApiClient,
  activeWorkspaceId,
  isReadOnly = false,
  className,
}: AgentsViewProps): React.JSX.Element {
  const { t } = useI18n();
  const { can } = usePermissions();
  const canDeleteAgents = can('agents', 'delete');
  const canViewIssues = can('issues');
  const canConfigureIntegrations = can('integrations', 'edit');
  const getRoleLabel = (role: AgentRole): string => {
    if (role === 'QA') return t('agents.roleQa');
    if (role === 'DOCUMENTATION') return t('agents.roleDocumentation');
    if (role === 'REFACTOR') return t('agents.roleRefactoring');
    if (role === 'CUSTOM') return t('agents.roleCustomized');
    return role;
  };
  const { runActivity } = useActivityRunner();
  const [activeViewTab, setActiveViewTab] = useState<'catalog' | 'playground' | 'map' | 'workflow'>(
    'catalog',
  );
  const [agents, setAgents] = useState<readonly CustomAgentDto[]>([]);
  const [topologyIssues, setTopologyIssues] = useState<readonly Issue[]>([]);
  const [topologyRuns, setTopologyRuns] = useState<readonly AgentRun[]>([]);
  const [isTopologyLoading, setIsTopologyLoading] = useState(false);
  const [topologyError, setTopologyError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Filter & Search
  const [roleFilter, setRoleFilter] = useState<AgentRole | 'ALL'>('ALL');
  const [searchQuery, setSearchQuery] = useState('');

  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<CustomAgentDto | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Playground Execution state
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');
  const [playgroundPrompt, setPlaygroundPrompt] = useState('');
  const [useKnowledge, setUseKnowledge] = useState(true);
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionResult, setExecutionResult] = useState<ExecuteAgentResponse | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [isSecurityBlock, setIsSecurityBlock] = useState(false);
  const [showInstructionsPreview, setShowInstructionsPreview] = useState(false);
  const [llmProviders, setLlmProviders] = useState<readonly { id: string; label: string }[]>([]);
  const [availableLlmModels, setAvailableLlmModels] = useState<readonly AgentLlmModelOption[]>([]);
  const [selectedLlmProvider, setSelectedLlmProvider] = useState('');
  const [workflow, setWorkflow] = useState<AgentWorkflowDto>({
    enabled: false,
    autonomy: 'balanced',
    finalReview: true,
    uncertaintyBehavior: 'ask',
    issueCreationBehavior: 'ask',
    defaultAction: 'allow',
    steps: [],
    rules: [],
  });
  const [workflowProviderOptions, setWorkflowProviderOptions] = useState<
    readonly { id: string; name: string }[]
  >([]);
  const [isWorkflowLoading, setIsWorkflowLoading] = useState(false);
  const [isWorkflowSaving, setIsWorkflowSaving] = useState(false);
  const [workflowError, setWorkflowError] = useState<string | null>(null);
  const [workflowStatus, setWorkflowStatus] = useState<string | null>(null);

  const loadAgents = useCallback(async () => {
    if (activeWorkspaceId === null) {
      setIsLoading(true);
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      if (activeWorkspaceId) {
        apiClient.setWorkspaceId(activeWorkspaceId);
      }
      const data = await apiClient.getAgents();
      const list: readonly CustomAgentDto[] = Array.isArray(data) ? data : [];
      try {
        const configuredIntegrations = await apiClient.getIntegrations();
        const providers = configuredIntegrations
          .filter((item) => item.category === 'LLM' && item.isEnabled)
          .map((item) => ({ id: item.providerId, label: providerLabel(item.providerId) }));
        const modelOptions = configuredIntegrations.flatMap((item) => {
          if (item.category !== 'LLM' || !item.isEnabled) return [];
          const model = item.settings.model;
          if (typeof model !== 'string' || !model.trim()) return [];
          return [
            {
              providerId: item.providerId,
              providerLabel: providerLabel(item.providerId),
              model: model.trim(),
            },
          ];
        });
        setLlmProviders(providers);
        setAvailableLlmModels(modelOptions);
        setSelectedLlmProvider((current) =>
          providers.some((provider) => provider.id === current)
            ? current
            : (providers[0]?.id ?? ''),
        );
      } catch {
        setLlmProviders([]);
        setAvailableLlmModels([]);
      }
      setAgents(list);
      const first = list[0];
      if (first) {
        setSelectedAgentId((current) => current || first.id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('agents.loadFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [apiClient, activeWorkspaceId, t]);

  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);

  const loadWorkflow = useCallback(async () => {
    if (activeWorkspaceId === null) return;
    setIsWorkflowLoading(true);
    setWorkflowError(null);
    try {
      if (activeWorkspaceId) apiClient.setWorkspaceId(activeWorkspaceId);
      const [savedWorkflow, pbiProviders, testProviders] = await Promise.all([
        apiClient.getAgentWorkflow(),
        apiClient.getPbiProviders().catch(() => []),
        apiClient.getTestManagementProviders().catch(() => []),
      ]);
      setWorkflow(savedWorkflow);
      setWorkflowProviderOptions(
        [
          ...pbiProviders.map((provider) => ({
            id: provider.providerId,
            name: provider.providerId,
          })),
          ...testProviders
            .filter((provider) => provider.configured)
            .map((provider) => ({ id: provider.id, name: provider.id })),
        ].filter(
          (provider, index, all) => all.findIndex((item) => item.id === provider.id) === index,
        ),
      );
    } catch (err) {
      setWorkflowError(err instanceof Error ? err.message : t('agents.workflowLoadFailed'));
    } finally {
      setIsWorkflowLoading(false);
    }
  }, [activeWorkspaceId, apiClient, t]);

  useEffect(() => {
    void loadWorkflow();
  }, [loadWorkflow]);

  const loadTopology = useCallback(async () => {
    if (activeWorkspaceId === null) return;
    setIsTopologyLoading(true);
    setTopologyError(null);
    try {
      if (activeWorkspaceId) apiClient.setWorkspaceId(activeWorkspaceId);
      const [latestAgents, issues, runs] = await Promise.all([
        apiClient.getAgents(),
        // The map shows issue runs only to members who can see issues.
        canViewIssues ? apiClient.getIssues() : Promise.resolve([]),
        canViewIssues ? apiClient.getAgentRuns() : Promise.resolve([]),
      ]);
      setAgents(Array.isArray(latestAgents) ? latestAgents : []);
      setTopologyIssues(issues);
      setTopologyRuns(runs);
    } catch (err) {
      setTopologyError(err instanceof Error ? err.message : t('agents.mapLoadFailed'));
    } finally {
      setIsTopologyLoading(false);
    }
  }, [activeWorkspaceId, apiClient, canViewIssues, t]);

  useEffect(() => {
    if (activeViewTab !== 'map') return;
    void loadTopology();
    const timer = window.setInterval(() => void loadTopology(), 10_000);
    return () => window.clearInterval(timer);
  }, [activeViewTab, loadTopology]);

  const handleOpenCreateModal = () => {
    setEditingAgent(null);
    setIsModalOpen(true);
  };

  const handleOpenEditModal = (agent: CustomAgentDto) => {
    setEditingAgent(agent);
    setIsModalOpen(true);
  };

  const handleSaveAgent = async (data: CreateAgentDto | UpdateAgentDto) => {
    setIsSaving(true);
    try {
      if (editingAgent) {
        await apiClient.updateAgent(editingAgent.id, data);
      } else {
        await apiClient.createAgent(data as CreateAgentDto);
      }
      await loadAgents();
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteAgent = async (id: string) => {
    try {
      await apiClient.deleteAgent(id);
      if (selectedAgentId === id) {
        setSelectedAgentId('');
        setExecutionResult(null);
      }
      await loadAgents();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('agents.deleteFailed'));
    }
  };

  const handleExecutePlayground = async () => {
    const trimmedPrompt = playgroundPrompt.trim();
    if (!trimmedPrompt) {
      setExecutionError(t('agents.promptRequired'));
      setIsSecurityBlock(false);
      return;
    }
    if (!selectedAgentId) {
      setExecutionError(t('agents.agentRequired'));
      setIsSecurityBlock(false);
      return;
    }

    setIsExecuting(true);
    setExecutionError(null);
    setIsSecurityBlock(false);
    setExecutionResult(null);

    try {
      const res = await runActivity(
        {
          kind: 'agent',
          title: t('agents.executingAgent', { name: selectedAgent?.name ?? '' }),
        },
        () =>
          apiClient.executeAgent(selectedAgentId, {
            prompt: trimmedPrompt,
            useKnowledge,
            ...(selectedLlmProvider ? { llmProvider: selectedLlmProvider } : {}),
          }),
      );
      setExecutionResult(res);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t('agents.executionFailed');
      setExecutionError(msg);
      if (
        msg.toLowerCase().includes('prompt injection') ||
        msg.toLowerCase().includes('segurança') ||
        msg.toLowerCase().includes('inseguro')
      ) {
        setIsSecurityBlock(true);
      }
    } finally {
      setIsExecuting(false);
    }
  };

  const updateWorkflowStep = (stepId: string, update: Partial<AgentWorkflowStepDto>) => {
    setWorkflow((current) => ({
      ...current,
      steps: current.steps.map((step) => (step.id === stepId ? { ...step, ...update } : step)),
    }));
    setWorkflowStatus(null);
  };

  const moveWorkflowStep = (index: number, offset: -1 | 1) => {
    setWorkflow((current) => {
      const target = index + offset;
      if (target < 0 || target >= current.steps.length) return current;
      const steps = [...current.steps];
      [steps[index], steps[target]] = [steps[target]!, steps[index]!];
      return { ...current, steps };
    });
    setWorkflowStatus(null);
  };

  const addWorkflowStep = () => {
    const step: AgentWorkflowStepDto = {
      id:
        globalThis.crypto?.randomUUID?.() ??
        `step-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: '',
      instructions: '',
      reviewRequired: false,
    };
    setWorkflow((current) => ({ ...current, steps: [...current.steps, step] }));
    setWorkflowStatus(null);
  };

  const addWorkflowRule = () => {
    const rule: AgentWorkflowRuleDto = {
      id:
        globalThis.crypto?.randomUUID?.() ??
        `rule-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: `${t('agents.workflowRule')} ${workflow.rules.length + 1}`,
      toolset: 'pbi',
      effect: 'allow',
    };
    setWorkflow((current) => ({ ...current, rules: [...current.rules, rule] }));
    setWorkflowStatus(null);
  };

  const updateWorkflowRule = (id: string, patch: Partial<AgentWorkflowRuleDto>) => {
    setWorkflow((current) => ({
      ...current,
      rules: current.rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
    }));
    setWorkflowStatus(null);
  };

  const saveWorkflow = async () => {
    if (workflow.enabled && workflow.steps.length === 0 && workflow.rules.length === 0) {
      setWorkflowError(t('agents.workflowNoSteps'));
      return;
    }
    if (workflow.steps.some((step) => !step.name.trim() || !step.instructions.trim())) {
      setWorkflowError(t('agents.workflowStepRequired'));
      return;
    }
    if (
      workflow.rules.some(
        (rule) => !rule.name.trim() || (rule.allowedProviders?.length && !rule.toolName),
      )
    ) {
      setWorkflowError(t('agents.workflowRuleInvalid'));
      return;
    }
    setIsWorkflowSaving(true);
    setWorkflowError(null);
    setWorkflowStatus(null);
    try {
      const saved = await apiClient.saveAgentWorkflow(workflow);
      setWorkflow(saved);
      setWorkflowStatus(t('agents.workflowSaved'));
    } catch (err) {
      setWorkflowError(err instanceof Error ? err.message : t('agents.workflowSaveFailed'));
    } finally {
      setIsWorkflowSaving(false);
    }
  };

  const handleSelectAndTestAgent = (agentId: string) => {
    setSelectedAgentId(agentId);
    setExecutionResult(null);
    setActiveViewTab('playground');
  };

  // Filtered agents
  const filteredAgents = agents.filter((agent) => {
    const matchesRole = roleFilter === 'ALL' || agent.role === roleFilter;
    const matchesSearch =
      agent.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      agent.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      agent.slug.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesRole && matchesSearch;
  });

  const selectedAgent = agents.find((a) => a.id === selectedAgentId);
  // Losing edit access while on the playground falls back to the catalog.
  const visibleTab = isReadOnly && activeViewTab === 'playground' ? 'catalog' : activeViewTab;

  return (
    <div className={cn('flex flex-col gap-6 p-6', className)} data-testid="agents-view">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <i className="ti ti-robot text-2xl text-[var(--fill-accent)]" aria-hidden="true" />
            <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">
              {t('agents.customAgents')}
            </h1>
          </div>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            {t('agents.customAgentsSubtitle')}
          </p>
        </div>

        {!isReadOnly && (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              onClick={handleOpenCreateModal}
              data-testid="create-agent-button"
              className="self-start sm:self-auto"
            >
              <i className="ti ti-plus mr-1.5 text-base" aria-hidden="true" />
              <span>{t('agents.newAgent')}</span>
            </Button>
          </div>
        )}
      </div>

      {/* Tabs Switcher: Catálogo vs Playground */}
      <div className="flex items-center border-b border-[var(--border)] gap-6 text-sm font-medium">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setActiveViewTab('catalog')}
          className={cn(
            'flex items-center gap-2 rounded-none border-b-2 px-1 pb-3 pt-2 font-medium transition-colors hover:bg-transparent',
            visibleTab === 'catalog'
              ? 'border-[var(--fill-accent)] text-[var(--fill-accent)] font-semibold'
              : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
          )}
          data-testid="tab-catalog"
          leftIcon={<i className="ti ti-layout-grid text-base" aria-hidden="true" />}
        >
          <span>{t('runtime.agentCatalog')}</span>
          <span className="ml-1 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
            {agents.length}
          </span>
        </Button>

        {/* Running an agent is a write: members without edit access have no playground. */}
        {!isReadOnly && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setActiveViewTab('playground')}
            className={cn(
              'flex items-center gap-2 rounded-none border-b-2 px-1 pb-3 pt-2 font-medium transition-colors hover:bg-transparent',
              visibleTab === 'playground'
                ? 'border-[var(--fill-accent)] text-[var(--fill-accent)] font-semibold'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
            data-testid="tab-playground"
            leftIcon={<i className="ti ti-terminal-2 text-base" aria-hidden="true" />}
          >
            <span>{t('agents.playground')}</span>
            {selectedAgent && (
              <span className="ml-1 max-w-[140px] truncate rounded bg-[var(--surface-2)] px-2 py-0.5 text-[10px] font-normal text-[var(--text-secondary)]">
                {selectedAgent.name}
              </span>
            )}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          onClick={() => setActiveViewTab('map')}
          className={cn(
            'flex items-center gap-2 rounded-none border-b-2 px-1 pb-3 pt-2 font-medium transition-colors hover:bg-transparent',
            visibleTab === 'map'
              ? 'border-[var(--fill-accent)] text-[var(--fill-accent)] font-semibold'
              : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
          )}
          data-testid="tab-map"
          leftIcon={<i className="ti ti-sitemap text-base" aria-hidden="true" />}
        >
          <span>{t('agents.map')}</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => setActiveViewTab('workflow')}
          className={cn(
            'flex items-center gap-2 rounded-none border-b-2 px-1 pb-3 pt-2 font-medium transition-colors hover:bg-transparent',
            visibleTab === 'workflow'
              ? 'border-[var(--fill-accent)] text-[var(--fill-accent)] font-semibold'
              : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
          )}
          data-testid="tab-workflow"
          leftIcon={<i className="ti ti-route text-base" aria-hidden="true" />}
        >
          <span>{t('agents.workflow')}</span>
        </Button>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-center justify-between rounded-lg border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-400"
        >
          <div className="flex items-center gap-2">
            <i className="ti ti-alert-circle text-lg" aria-hidden="true" />
            <span>{error}</span>
          </div>
          <Button variant="outline" className="h-[40px]" onClick={() => void loadAgents()}>
            {t('common.retry')}
          </Button>
        </div>
      )}

      {visibleTab === 'map' && (
        <AgentTopology
          agents={agents}
          issues={topologyIssues}
          runs={topologyRuns}
          isLoading={isLoading || isTopologyLoading}
          error={topologyError}
          onRefresh={() => void loadTopology()}
          canCreateAgents={!isReadOnly}
        />
      )}

      {visibleTab === 'workflow' && (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5" data-testid="workflow-panel">
          <Card>
            <CardHeader>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <i className="ti ti-route text-[var(--fill-accent)]" aria-hidden="true" />
                    {t('agents.workflow')}
                  </CardTitle>
                </div>
                <Button
                  type="button"
                  variant={workflow.enabled ? 'default' : 'outline'}
                  aria-pressed={workflow.enabled}
                  disabled={isReadOnly || isWorkflowLoading}
                  onClick={() => {
                    setWorkflow((current) => ({ ...current, enabled: !current.enabled }));
                    setWorkflowStatus(null);
                  }}
                  data-testid="workflow-enabled-toggle"
                >
                  <i
                    className={cn(
                      'ti mr-2 text-base',
                      workflow.enabled ? 'ti-toggle-right' : 'ti-toggle-left',
                    )}
                    aria-hidden="true"
                  />
                  {t('agents.workflowEnabled')}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Card className="border-[var(--border)] bg-[var(--surface-1)]">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">{t('agents.workflowControls')}</CardTitle>
                </CardHeader>
                <CardContent className="grid items-start gap-4 md:grid-cols-2">
                  <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                    {t('agents.workflowAutonomy')}
                    <Select
                      value={workflow.autonomy}
                      disabled={isReadOnly || isWorkflowLoading}
                      onChange={(event) =>
                        setWorkflow((current) => ({
                          ...current,
                          autonomy: event.target.value as AgentWorkflowDto['autonomy'],
                        }))
                      }
                    >
                      <option value="supervised">{t('agents.workflowAutonomySupervised')}</option>
                      <option value="balanced">{t('agents.workflowAutonomyBalanced')}</option>
                      <option value="autonomous">{t('agents.workflowAutonomyAutonomous')}</option>
                    </Select>
                  </label>
                  <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                    {t('agents.workflowUncertainty')}
                    <Select
                      value={workflow.uncertaintyBehavior}
                      disabled={isReadOnly || isWorkflowLoading}
                      onChange={(event) =>
                        setWorkflow((current) => ({
                          ...current,
                          uncertaintyBehavior: event.target
                            .value as AgentWorkflowDto['uncertaintyBehavior'],
                        }))
                      }
                    >
                      <option value="ask">{t('agents.workflowUncertaintyAsk')}</option>
                      <option value="assume">{t('agents.workflowUncertaintyAssume')}</option>
                    </Select>
                  </label>
                  <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                    {t('agents.workflowIssueCreation')}
                    <Select
                      value={workflow.issueCreationBehavior}
                      disabled={isReadOnly || isWorkflowLoading}
                      onChange={(event) =>
                        setWorkflow((current) => ({
                          ...current,
                          issueCreationBehavior: event.target
                            .value as AgentWorkflowDto['issueCreationBehavior'],
                        }))
                      }
                    >
                      <option value="ask">{t('agents.workflowIssueCreationAsk')}</option>
                      <option value="allow">{t('agents.workflowIssueCreationAllow')}</option>
                    </Select>
                  </label>
                  <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                    {t('agents.workflowDefaultAction')}
                    <Select
                      value={workflow.defaultAction}
                      disabled={isReadOnly || isWorkflowLoading}
                      onChange={(event) =>
                        setWorkflow((current) => ({
                          ...current,
                          defaultAction: event.target.value as AgentWorkflowDto['defaultAction'],
                        }))
                      }
                    >
                      <option value="allow">{t('agents.workflowDefaultAllow')}</option>
                      <option value="deny">{t('agents.workflowDefaultDeny')}</option>
                    </Select>
                  </label>
                  <div className="flex flex-col items-start gap-2 text-sm text-[var(--text-secondary)]">
                    {t('agents.workflowFinalReview')}
                    <Button
                      type="button"
                      variant={workflow.finalReview ? 'default' : 'outline'}
                      aria-pressed={workflow.finalReview}
                      disabled={isReadOnly || isWorkflowLoading}
                      onClick={() =>
                        setWorkflow((current) => ({
                          ...current,
                          finalReview: !current.finalReview,
                        }))
                      }
                    >
                      <i
                        className={cn(
                          'ti mr-2',
                          workflow.finalReview ? 'ti-shield-check' : 'ti-shield-off',
                        )}
                        aria-hidden="true"
                      />
                      {workflow.finalReview
                        ? t('agents.workflowReviewRequired')
                        : t('agents.workflowReviewOptional')}
                    </Button>
                  </div>
                </CardContent>
              </Card>
              {isReadOnly && (
                <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-300">
                  {t('agents.workflowPermissionRequired')}
                </p>
              )}
              {workflowError && (
                <div
                  role="alert"
                  className="flex items-center justify-between gap-3 rounded-md border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300"
                >
                  <span>{workflowError}</span>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void loadWorkflow()}
                  >
                    {t('common.retry')}
                  </Button>
                </div>
              )}
              {workflowStatus && (
                <p
                  role="status"
                  className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-300"
                >
                  {workflowStatus}
                </p>
              )}
              {isWorkflowLoading ? (
                <div className="h-20 animate-pulse rounded-lg bg-[var(--surface-2)]" />
              ) : (
                workflow.steps.map((step, index) => (
                  <Card key={step.id} className="border-[var(--border)] bg-[var(--surface-1)]">
                    <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 pb-3">
                      <CardTitle className="text-base">
                        {t('agents.workflowStep', { number: index + 1 })}
                      </CardTitle>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label={t('agents.moveWorkflowStepUp', { number: index + 1 })}
                          disabled={isReadOnly || index === 0}
                          onClick={() => moveWorkflowStep(index, -1)}
                        >
                          <i className="ti ti-arrow-up" aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          aria-label={t('agents.moveWorkflowStepDown', { number: index + 1 })}
                          disabled={isReadOnly || index === workflow.steps.length - 1}
                          onClick={() => moveWorkflowStep(index, 1)}
                        >
                          <i className="ti ti-arrow-down" aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-red-400"
                          aria-label={t('agents.removeWorkflowStep', { number: index + 1 })}
                          disabled={isReadOnly}
                          onClick={() => {
                            setWorkflow((current) => ({
                              ...current,
                              steps: current.steps.filter((item) => item.id !== step.id),
                            }));
                            setWorkflowStatus(null);
                          }}
                        >
                          <i className="ti ti-trash" aria-hidden="true" />
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent className="grid gap-4 md:grid-cols-2">
                      <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                        {t('agents.workflowStepName')}
                        <Input
                          value={step.name}
                          placeholder={t('agents.workflowStepNamePlaceholder')}
                          disabled={isReadOnly}
                          onChange={(event) =>
                            updateWorkflowStep(step.id, { name: event.target.value })
                          }
                        />
                      </label>
                      <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                        {t('agents.workflowAgent')}
                        <Select
                          value={step.agentId ?? ''}
                          disabled={isReadOnly}
                          onChange={(event) =>
                            updateWorkflowStep(step.id, {
                              agentId: event.target.value || undefined,
                            })
                          }
                        >
                          <option value="">{t('agents.workflowRequestedAgent')}</option>
                          {agents.map((agent) => (
                            <option key={agent.id} value={agent.id}>
                              {agent.name}
                            </option>
                          ))}
                        </Select>
                      </label>
                      <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)] md:col-span-2">
                        {t('agents.workflowInstructions')}
                        <Textarea
                          value={step.instructions}
                          rows={4}
                          placeholder={t('agents.workflowInstructionsPlaceholder')}
                          disabled={isReadOnly}
                          onChange={(event) =>
                            updateWorkflowStep(step.id, { instructions: event.target.value })
                          }
                        />
                      </label>
                      <div className="md:col-span-2">
                        <Button
                          type="button"
                          size="sm"
                          variant={step.reviewRequired ? 'default' : 'outline'}
                          aria-pressed={step.reviewRequired ?? false}
                          disabled={isReadOnly}
                          onClick={() =>
                            updateWorkflowStep(step.id, {
                              reviewRequired: !step.reviewRequired,
                            })
                          }
                        >
                          <i
                            className={cn(
                              'ti mr-2',
                              step.reviewRequired ? 'ti-user-check' : 'ti-user-question',
                            )}
                            aria-hidden="true"
                          />
                          {t('agents.workflowStepReview')}
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
              <Card className="border-[var(--border)] bg-[var(--surface-1)]">
                <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
                  <CardTitle className="text-base">{t('agents.workflowRules')}</CardTitle>
                  {!isReadOnly && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={addWorkflowRule}
                      disabled={workflow.rules.length >= 100}
                    >
                      <i className="ti ti-plus mr-2" aria-hidden="true" />
                      {t('agents.workflowAddRule')}
                    </Button>
                  )}
                </CardHeader>
                <CardContent className="space-y-3">
                  {workflow.rules.map((rule) => (
                    <div
                      key={rule.id}
                      className="grid items-start gap-3 rounded-lg border border-[var(--border)] p-3 md:grid-cols-2"
                    >
                      <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                        {t('agents.workflowRuleName')}
                        <Input
                          value={rule.name}
                          disabled={isReadOnly}
                          onChange={(event) =>
                            updateWorkflowRule(rule.id, { name: event.target.value })
                          }
                        />
                      </label>
                      <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                        {t('agents.workflowRuleModule')}
                        <Select
                          value={rule.toolset}
                          disabled={isReadOnly}
                          onChange={(event) =>
                            updateWorkflowRule(rule.id, {
                              toolset: event.target.value as AgentWorkflowToolset,
                            })
                          }
                        >
                          <option value="all">{t('agents.workflowModuleAll')}</option>
                          <option value="agents">{t('agents.workflowModuleAgents')}</option>
                          <option value="integrations">
                            {t('agents.workflowModuleIntegrations')}
                          </option>
                          <option value="brain">{t('agents.workflowModuleBrain')}</option>
                          <option value="issues">{t('agents.workflowModuleIssues')}</option>
                          <option value="pbi">{t('agents.workflowModulePbi')}</option>
                          <option value="spec">{t('agents.workflowModuleSpec')}</option>
                          <option value="testplans">{t('agents.workflowModuleTestPlans')}</option>
                          <option value="design">{t('agents.workflowModuleDesign')}</option>
                          <option value="e2e">{t('agents.workflowModuleE2e')}</option>
                          <option value="releasenotes">
                            {t('agents.workflowModuleReleaseNotes')}
                          </option>
                          <option value="audit">{t('agents.workflowModuleAudit')}</option>
                          <option value="workspaces">{t('agents.workflowModuleWorkspaces')}</option>
                        </Select>
                      </label>
                      <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                        {t('agents.workflowRuleAction')}
                        <Input
                          value={rule.toolName ?? ''}
                          list={`workflow-actions-${rule.id}`}
                          placeholder={t('agents.workflowAllActions')}
                          disabled={isReadOnly}
                          onChange={(event) =>
                            updateWorkflowRule(rule.id, {
                              toolName: event.target.value.trim() || undefined,
                            })
                          }
                        />
                        <datalist id={`workflow-actions-${rule.id}`}>
                          {workflowToolNames[rule.toolset].map((toolName) => (
                            <option key={toolName} value={toolName} />
                          ))}
                        </datalist>
                      </label>
                      <label className="flex flex-col gap-2 text-sm text-[var(--text-secondary)]">
                        {t('agents.workflowAllowedProviders')}
                        <Input
                          value={(rule.allowedProviders ?? []).join(', ')}
                          list={`workflow-providers-${rule.id}`}
                          placeholder={t('agents.workflowAllProviders')}
                          disabled={isReadOnly || !rule.toolName}
                          onChange={(event) => {
                            const providers = event.target.value
                              .split(',')
                              .map((provider) => provider.trim())
                              .filter(Boolean);
                            updateWorkflowRule(rule.id, {
                              allowedProviders: providers.length
                                ? [...new Set(providers)]
                                : undefined,
                            });
                          }}
                        />
                        <datalist id={`workflow-providers-${rule.id}`}>
                          {workflowProviderOptions.map((provider) => (
                            <option key={provider.id} value={provider.id}>
                              {provider.name}
                            </option>
                          ))}
                        </datalist>
                      </label>
                      <div className="flex flex-wrap gap-2 md:col-span-2">
                        <Button
                          type="button"
                          size="sm"
                          variant={rule.requireApproval ? 'default' : 'outline'}
                          aria-pressed={rule.requireApproval ?? false}
                          disabled={isReadOnly}
                          onClick={() =>
                            updateWorkflowRule(rule.id, {
                              requireApproval: !rule.requireApproval,
                            })
                          }
                        >
                          {t('agents.workflowRequireApproval')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={rule.effect === 'deny' ? 'destructive' : 'default'}
                          aria-pressed={rule.effect === 'deny'}
                          disabled={isReadOnly}
                          onClick={() =>
                            updateWorkflowRule(rule.id, {
                              effect: rule.effect === 'deny' ? 'allow' : 'deny',
                            })
                          }
                        >
                          {rule.effect === 'deny'
                            ? t('agents.workflowActionBlocked')
                            : t('agents.workflowActionAllowed')}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant={rule.createIssueForAction ? 'default' : 'outline'}
                          aria-pressed={rule.createIssueForAction ?? false}
                          disabled={isReadOnly}
                          onClick={() =>
                            updateWorkflowRule(rule.id, {
                              createIssueForAction: !rule.createIssueForAction,
                            })
                          }
                        >
                          {t('agents.workflowCreateIssuePerAction')}
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8 text-red-400"
                          aria-label={t('agents.workflowRemoveRule', { name: rule.name })}
                          disabled={isReadOnly}
                          onClick={() =>
                            setWorkflow((current) => ({
                              ...current,
                              rules: current.rules.filter((item) => item.id !== rule.id),
                            }))
                          }
                        >
                          <i className="ti ti-trash" aria-hidden="true" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
              {!isWorkflowLoading && workflow.steps.length === 0 && (
                <p className="rounded-lg border border-dashed border-[var(--border)] p-5 text-center text-sm text-[var(--text-muted)]">
                  {t('agents.workflowNoSteps')}
                </p>
              )}
              {!isReadOnly && !isWorkflowLoading && (
                <div className="flex flex-wrap justify-between gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={addWorkflowStep}
                    disabled={workflow.steps.length >= 20}
                  >
                    <i className="ti ti-plus mr-2" aria-hidden="true" />
                    {t('agents.addWorkflowStep')}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void saveWorkflow()}
                    isLoading={isWorkflowSaving}
                  >
                    <i className="ti ti-device-floppy mr-2" aria-hidden="true" />
                    {isWorkflowSaving ? t('agents.savingWorkflow') : t('agents.saveWorkflow')}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* View Mode 1: Catalog */}
      {visibleTab === 'catalog' && (
        <div className="flex flex-col gap-6" data-testid="catalog-view-panel">
          {/* Filter and Search Bar */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-1">
              {(['ALL', 'QA', 'DOCUMENTATION', 'REFACTOR', 'CUSTOM'] as const).map((r) => (
                <Button
                  key={r}
                  type="button"
                  size="sm"
                  variant={roleFilter === r ? 'default' : 'ghost'}
                  onClick={() => setRoleFilter(r)}
                  className={cn(
                    'h-8 px-3 text-xs font-medium',
                    roleFilter === r
                      ? 'bg-[var(--fill-accent)] text-[#0d1b2c] hover:bg-[var(--fill-accent-hover)]'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
                  )}
                >
                  {r === 'ALL'
                    ? t('common.all')
                    : t(
                        r === 'QA'
                          ? 'agents.roleQa'
                          : r === 'DOCUMENTATION'
                            ? 'agents.roleDocumentation'
                            : r === 'REFACTOR'
                              ? 'agents.roleRefactoring'
                              : 'agents.roleCustomFilter',
                      )}
                </Button>
              ))}
            </div>

            <div className="w-full sm:w-72">
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('agents.searchPlaceholder')}
                className="text-xs"
              />
            </div>
          </div>

          {/* Agents Cards Grid */}
          {isLoading ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {[1, 2, 3].map((i) => (
                <div
                  key={i}
                  className="h-44 animate-pulse rounded-xl border border-[var(--border)] bg-[var(--surface-2)]"
                />
              ))}
            </div>
          ) : filteredAgents.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[var(--border)] p-12 text-center">
              <i className="ti ti-robot-off text-4xl text-[var(--text-muted)]" aria-hidden="true" />
              <h3 className="mt-3 text-base font-semibold text-[var(--text-primary)]">
                {t('agents.noSearchResults')}
              </h3>
              {searchQuery || roleFilter !== 'ALL' ? (
                <p className="mt-1 text-sm text-[var(--text-secondary)]">
                  {t('agents.adjustFilters')}
                </p>
              ) : (
                !isReadOnly && (
                  <>
                    <p className="mt-1 text-sm text-[var(--text-secondary)]">
                      {t('agents.createFirstAgent')}
                    </p>
                    <Button onClick={handleOpenCreateModal} className="mt-4 h-[40px]">
                      {t('runtime.createAgent')}
                    </Button>
                  </>
                )
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredAgents.map((agent) => {
                const roleVariant = roleBadgeMap[agent.role] ?? 'default';
                const resolvedRoleLabel = getRoleLabel(agent.role);
                const isSelected = agent.id === selectedAgentId;
                const canDeleteAgent = canDeleteAgents && !agent.isSystem;

                return (
                  <Card
                    key={agent.id}
                    className={cn(
                      'flex flex-col transition-all hover:border-[var(--fill-accent)]/50',
                      isSelected && 'ring-2 ring-[var(--fill-accent)]',
                    )}
                    data-testid={`agent-card-${agent.slug}`}
                  >
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <CardTitle className="truncate text-base">{agent.name}</CardTitle>
                          <span className="text-xs text-[var(--text-muted)]">@{agent.slug}</span>
                        </div>
                        <Badge variant={roleVariant}>{resolvedRoleLabel}</Badge>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <span className="rounded bg-[var(--surface-1)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
                          {agent.model || t('runtime.noAgentModel')}
                        </span>
                        <span className="rounded bg-[var(--surface-1)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
                          temp {agent.temperature}
                        </span>
                        {agent.isSystem && (
                          <span className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-medium text-sky-400">
                            {t('agents.systemBadge')}
                          </span>
                        )}
                      </div>
                    </CardHeader>

                    <CardContent className="flex-1 py-2">
                      <CardDescription className="line-clamp-3 text-xs">
                        {agent.description || t('agents.noDescription')}
                      </CardDescription>
                    </CardContent>

                    {(!isReadOnly || canDeleteAgent) && (
                      <CardFooter className="flex items-center justify-between border-t border-[var(--border)] pt-3 text-xs">
                        {!isReadOnly && (
                          <Button
                            variant={isSelected ? 'default' : 'outline'}
                            onClick={() => handleSelectAndTestAgent(agent.id)}
                            data-testid={`test-agent-btn-${agent.slug}`}
                            className="h-[40px] px-3.5 text-xs"
                          >
                            <i className="ti ti-player-play mr-1.5 text-xs" aria-hidden="true" />
                            <span>{t('runtime.testInPlayground')}</span>
                          </Button>
                        )}

                        <div className="ml-auto flex items-center gap-1">
                          {!isReadOnly && (
                            <IconButton
                              variant="ghost"
                              icon={<i className="ti ti-edit text-base" aria-hidden="true" />}
                              label={t('agents.editAgentLabel', { name: agent.name })}
                              onClick={() => handleOpenEditModal(agent)}
                            />
                          )}

                          {canDeleteAgent && (
                            <IconButton
                              variant="ghost"
                              icon={<i className="ti ti-trash text-base" aria-hidden="true" />}
                              label={t('agents.deleteAgentLabel', { name: agent.name })}
                              onClick={() => {
                                if (
                                  window.confirm(t('agents.deleteConfirm', { name: agent.name }))
                                ) {
                                  void handleDeleteAgent(agent.id);
                                }
                              }}
                              className="text-red-400 hover:text-red-300"
                            />
                          )}
                        </div>
                      </CardFooter>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* View Mode 2: Dedicated Playground Console */}
      {visibleTab === 'playground' && (
        <div
          className="flex flex-col gap-6 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-6 shadow-sm"
          data-testid="playground-view-panel"
        >
          {/* Playground Header */}
          <div className="flex flex-col gap-4 border-b border-[var(--border)] pb-5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-[var(--fill-accent)]/20 bg-[var(--fill-accent)]/10 text-[var(--fill-accent)]">
                <i className="ti ti-terminal-2 text-xl" aria-hidden="true" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-[var(--text-primary)]">
                  {t('agents.playgroundTitle')}
                </h2>
                <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                  {t('agents.playgroundGuidance')}
                </p>
              </div>
            </div>

            {/* Agent Picker */}
            <div className="flex items-center gap-2.5">
              <label
                htmlFor="playground-agent-select"
                className="shrink-0 text-xs font-medium text-[var(--text-secondary)]"
              >
                {t('agents.activeAgent')}
              </label>
              <Select
                id="playground-agent-select"
                value={selectedAgentId}
                onChange={(e) => {
                  setSelectedAgentId(e.target.value);
                  setExecutionResult(null);
                  setExecutionError(null);
                }}
                containerClassName="w-auto shrink-0"
                className="h-[40px] w-60 text-xs font-medium"
                data-testid="playground-agent-select"
              >
                {agents.length === 0 ? (
                  <option value="">{t('agents.noAgents')}</option>
                ) : (
                  agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} ({a.role})
                    </option>
                  ))
                )}
              </Select>
              <label htmlFor="playground-llm-select" className="sr-only">
                {t('agents.aiProvider')}
              </label>
              <Select
                id="playground-llm-select"
                value={selectedLlmProvider}
                onChange={(event) => setSelectedLlmProvider(event.target.value)}
                containerClassName="w-auto shrink-0"
                className="h-[40px] w-52 text-xs font-medium"
                data-testid="playground-llm-select"
              >
                {llmProviders.length === 0 ? (
                  <option value="">
                    {canConfigureIntegrations ? t('runtime.configureAi') : t('agents.defaultModel')}
                  </option>
                ) : (
                  llmProviders.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                    </option>
                  ))
                )}
              </Select>
            </div>
          </div>

          {/* Selected Agent Quick Details */}
          {selectedAgent && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-2)]/50 p-3.5 text-xs transition-colors">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2.5">
                  <Badge variant={roleBadgeMap[selectedAgent.role] ?? 'default'}>
                    {getRoleLabel(selectedAgent.role)}
                  </Badge>
                  <span className="font-semibold text-[var(--text-primary)]">
                    {selectedAgent.name}
                  </span>
                  <span className="text-[var(--text-muted)]">•</span>
                  <span className="text-[var(--text-secondary)]">
                    {t('agents.model')}:{' '}
                    <span className="font-mono text-[var(--text-primary)]">
                      {selectedAgent.model || t('agents.defaultModel')}
                    </span>
                  </span>
                  <span className="text-[var(--text-muted)]">•</span>
                  <span className="text-[var(--text-secondary)]">
                    {t('agents.temperature')}:{' '}
                    <span className="font-mono text-[var(--text-primary)]">
                      {selectedAgent.temperature ?? 0.2}
                    </span>
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowInstructionsPreview((p) => !p)}
                  className="h-[32px] px-2.5 text-xs text-[var(--fill-accent)] hover:text-[var(--fill-accent)]"
                >
                  <i
                    className={cn(
                      'ti mr-1.5 transition-transform duration-200',
                      showInstructionsPreview ? 'ti-chevron-up' : 'ti-chevron-down',
                    )}
                    aria-hidden="true"
                  />
                  <span>
                    {showInstructionsPreview
                      ? t('agents.hideInstructions')
                      : t('agents.showInstructions')}
                  </span>
                </Button>
              </div>
              {showInstructionsPreview && (
                <div className="mt-3.5 max-h-56 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4 shadow-inner">
                  <MarkdownViewer
                    content={selectedAgent.instructions}
                    showModeToggle={false}
                    documentTitle={selectedAgent.name}
                  />
                </div>
              )}
            </div>
          )}

          {/* Prompt Input & Execution Form */}
          <div className="flex flex-col gap-4">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <label
                  htmlFor="playground-prompt"
                  className="flex items-center gap-1.5 text-xs font-medium text-[var(--text-secondary)]"
                >
                  <i className="ti ti-prompt text-[var(--fill-accent)]" aria-hidden="true" />
                  <span>{t('runtime.userTaskInput')}</span>
                </label>
                <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                  <kbd className="rounded border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-secondary)]">
                    Ctrl + Enter
                  </kbd>
                  <span>{t('runtime.toExecute')}</span>
                </div>
              </div>
              <Textarea
                id="playground-prompt"
                value={playgroundPrompt}
                onChange={(e) => setPlaygroundPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    void handleExecutePlayground();
                  }
                }}
                placeholder={t('agents.detailedPromptPlaceholder')}
                rows={5}
                className="min-h-[120px] resize-y p-3.5 text-xs font-mono leading-relaxed"
                data-testid="playground-prompt-input"
              />
            </div>

            {/* Actions Bar */}
            <div className="flex flex-wrap items-center justify-between gap-4 pt-1">
              <label className="group flex cursor-pointer select-none items-center gap-2.5 rounded-lg border border-[var(--border)] bg-[var(--surface-2)]/50 px-3.5 py-2 text-xs transition-colors hover:border-[var(--border-hover)] hover:bg-[var(--surface-2)]">
                <input
                  type="checkbox"
                  checked={useKnowledge}
                  onChange={(e) => setUseKnowledge(e.target.checked)}
                  aria-label={t('runtime.workspaceRag')}
                  className="h-4 w-4 cursor-pointer rounded border-[var(--border)] text-[var(--fill-accent)] focus:ring-0 focus:ring-offset-0"
                />
                <div className="flex items-center gap-1.5 text-[var(--text-secondary)] group-hover:text-[var(--text-primary)]">
                  <i
                    className="ti ti-database text-sm text-[var(--text-muted)] group-hover:text-[var(--fill-accent)]"
                    aria-hidden="true"
                  />
                  <span>{t('runtime.workspaceRag')}</span>
                </div>
              </label>

              <Button
                onClick={() => {
                  void handleExecutePlayground();
                }}
                disabled={isExecuting}
                data-testid="playground-execute-button"
                className="h-[40px] px-5"
              >
                {isExecuting ? (
                  <>
                    <i className="ti ti-loader-2 mr-2 animate-spin text-base" aria-hidden="true" />
                    <span>{t('agents.executing')}</span>
                  </>
                ) : (
                  <>
                    <i className="ti ti-sparkles mr-2 text-base" aria-hidden="true" />
                    <span>{t('runtime.executeAgent')}</span>
                  </>
                )}
              </Button>
            </div>
          </div>

          {/* Security Alert if Prompt Injection was Blocked */}
          {isSecurityBlock && (
            <div
              role="alert"
              className="flex items-start gap-3 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-red-300 shadow-sm"
              data-testid="prompt-injection-alert"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-red-500/20 text-red-400">
                <i className="ti ti-shield-x text-lg" aria-hidden="true" />
              </div>
              <div>
                <div className="text-sm font-semibold text-red-200">
                  {t('agents.injectionBlockedTitle')}
                </div>
                <p className="mt-1 text-xs text-red-200/90 leading-relaxed">
                  {t('agents.injectionBlockedDesc')}
                </p>
              </div>
            </div>
          )}

          {/* Generic Execution Error */}
          {executionError && !isSecurityBlock && (
            <div
              role="alert"
              className="flex items-center gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3.5 text-xs text-amber-300"
            >
              <i className="ti ti-alert-triangle text-base text-amber-400" aria-hidden="true" />
              <span>{executionError}</span>
            </div>
          )}

          {/* Execution Output Panel */}
          {executionResult && (
            <div
              className="flex flex-col gap-4 rounded-xl border border-[var(--border)] bg-[var(--surface-2)]/40 p-5 shadow-sm"
              data-testid="playground-output-panel"
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] pb-3 text-xs text-[var(--text-secondary)]">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="font-semibold text-[var(--text-primary)]">
                    <i className="ti ti-robot mr-1 text-[var(--fill-accent)]" aria-hidden="true" />
                    {executionResult.agent.name}
                  </Badge>
                  {executionResult.chunksUsed > 0 && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-0.5 text-xs text-emerald-400">
                      <i className="ti ti-database text-xs" aria-hidden="true" />
                      {executionResult.chunksUsed} {t('agents.contextChunksUsed')}
                    </span>
                  )}
                  {executionResult.provider && (
                    <span className="inline-flex items-center rounded-full border border-[var(--border)] px-2.5 py-0.5 text-xs">
                      {t('agents.provider')} {executionResult.provider}
                    </span>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setExecutionResult(null)}
                  className="h-[32px] px-2.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                  <i className="ti ti-clear-all mr-1 text-sm" aria-hidden="true" />
                  <span>{t('common.clear')}</span>
                </Button>
              </div>

              <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4 shadow-inner">
                <MarkdownViewer content={executionResult.content} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modal for Create/Edit */}
      <AgentModal
        isOpen={isModalOpen && !isReadOnly}
        onClose={() => setIsModalOpen(false)}
        onSave={handleSaveAgent}
        initialData={editingAgent}
        isSaving={isSaving}
        availableLlmModels={availableLlmModels}
        agents={agents}
      />
    </div>
  );
}

function providerLabel(providerId: string): string {
  const labels: Record<string, string> = {
    gemini: 'Google Gemini',
    openai: 'OpenAI',
    claude: 'Anthropic Claude',
    anthropic: 'Anthropic Claude',
    groq: 'Groq',
    ollama: 'Ollama',
  };
  return labels[providerId] ?? providerId;
}
