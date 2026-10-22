import { ActionsMenu } from '../../components/ui/actions-menu.js';
import { HistoryViewer } from '../audit/HistoryViewer.js';
import { useState, useEffect, useCallback, useRef } from 'react';
import { cn } from '../../lib/utils.js';
import { Select } from '../../components/ui/select.js';
import { Button } from '../../components/ui/button.js';
import { Textarea } from '../../components/ui/textarea.js';
import { Input } from '../../components/ui/input.js';
import { CsvExportError, exportCasesCsv } from './export-csv.js';
import { createSuiteZip } from './export-suite-zip.js';
import { AzureExportFields } from './AzureExportFields.js';
import { TestSuiteTree, type AutomateSelection } from './TestSuiteTree.js';
import { TestCaseModal } from './TestCaseModal.js';
import { testCaseOrigin } from './test-case-fields.js';
import { PublishTestSuiteModal } from './PublishTestSuiteModal.js';
import { ImportTestCasesModal } from './ImportTestCasesModal.js';
import { SkeletonListItem, SkeletonTestPlan } from '../../components/ui/skeleton.js';
import { FormattedContent } from '../../components/ui/formatted-content.js';
import { Modal } from '../../components/ui/modal.js';
import type {
  ApiClient,
  AzureDevOpsMemberDto,
  PublishTestSuiteInput,
  GeneratedTestPlanDto,
  SavedTestPlanDto,
  TestSuiteDto,
} from '../../lib/api-client.js';
import { usePermissions } from '../workspaces/permissions.js';
import type { CustomAgentDto } from '../agents/agent-types.js';
import type { UserWorkspaceMembership } from '../workspaces/workspace-types.js';
import { useI18n, type I18nContextValue } from '../../lib/i18n/index.js';
import { useActivityRunner } from '../activities/ActivityCenter.js';

export interface TestCaseStep {
  readonly order?: number;
  readonly action: string;
  readonly expectedResult: string;
  readonly data?: string;
}

export interface TestCase {
  readonly id: string;
  /** Stable ID kept by the API across edits; set once the case is saved. */
  readonly caseId?: string;
  readonly title: string;
  readonly scenario: string;
  readonly steps?: readonly TestCaseStep[];
  /** Stored with the case: remote ids and the fields of an imported case. */
  readonly metadata?: Record<string, unknown>;
}

export interface TestPlansViewProps {
  readonly apiClient?: ApiClient;
  readonly workspaces?: readonly UserWorkspaceMembership[];
  readonly activeWorkspaceId?: string | null;
  readonly onSelectWorkspace?: (workspaceId: string) => void;
  readonly className?: string;
  readonly initialTab?: 'saved' | 'create';
  /** Hides creation and editing; set when the member cannot edit test plans. */
  readonly isReadOnly?: boolean;
  /** Opens a new E2E run that automates saved cases; absent when the member cannot. */
  readonly onAutomate?: (selection: AutomateSelection) => void;
  /** Opens the integrations, where test management platforms are configured. */
  readonly onOpenIntegrations?: () => void;
}

const getDefaultTestCases = (t: I18nContextValue['t']): readonly TestCase[] => [
  {
    id: 'CT-01',
    title: t('runtime.positiveScenario'),
    scenario: t('runtime.positiveScenarioDescription'),
    steps: [
      {
        order: 1,
        action: t('runtime.fillRequiredFields'),
        expectedResult: t('runtime.formWithoutErrors'),
      },
      {
        order: 2,
        action: t('runtime.clickSave'),
        expectedResult: t('runtime.savedWithSuccess'),
      },
    ],
  },
  {
    id: 'CT-02',
    title: t('runtime.requiredField'),
    scenario: t('runtime.requiredFieldDescription'),
    steps: [
      {
        order: 1,
        action: t('runtime.leaveNameBlank'),
        expectedResult: t('runtime.nameRemainsBlank'),
      },
      {
        order: 2,
        action: t('runtime.submitForm'),
        expectedResult: t('runtime.requiredValidationShown'),
      },
    ],
  },
  {
    id: 'CT-03',
    title: t('runtime.characterLimit'),
    scenario: t('runtime.characterLimitDescription'),
    steps: [
      {
        order: 1,
        action: t('runtime.enterLongDescription'),
        expectedResult: t('runtime.characterCounterExceeded'),
      },
      {
        order: 2,
        action: t('runtime.trySubmitForm'),
        expectedResult: t('runtime.submissionBlocked'),
      },
    ],
  },
  {
    id: 'CT-04',
    title: t('runtime.unauthorizedUser'),
    scenario: t('runtime.unauthorizedUserDescription'),
    steps: [
      {
        order: 1,
        action: t('runtime.authenticateViewer'),
        expectedResult: t('runtime.viewerSession'),
      },
      {
        order: 2,
        action: t('runtime.accessEditRoute'),
        expectedResult: t('runtime.accessDeniedRedirect'),
      },
    ],
  },
];

function toTestCases(plans: readonly GeneratedTestPlanDto[]): TestCase[] {
  return plans.map((plan, index) => ({
    id: `CT-${String(index + 1).padStart(2, '0')}`,
    caseId: typeof plan.metadata?.['caseId'] === 'string' ? plan.metadata['caseId'] : undefined,
    title: plan.title,
    scenario: plan.description,
    steps: plan.steps,
    ...(plan.metadata ? { metadata: plan.metadata } : {}),
  }));
}

export function TestPlansView({
  apiClient,
  workspaces = [],
  activeWorkspaceId = null,
  onSelectWorkspace: _onSelectWorkspace,
  className,
  initialTab,
  isReadOnly = false,
  onAutomate,
  onOpenIntegrations,
}: TestPlansViewProps) {
  const { t, formatDate } = useI18n();
  const { runActivity } = useActivityRunner();
  const { can } = usePermissions();
  const canEdit = !isReadOnly && can('testplans', 'edit');
  const canDelete = canEdit && can('testplans', 'delete');
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const defaultTestCases = getDefaultTestCases(t);
  const selectedWorkspaceId = activeWorkspaceId ?? workspaces[0]?.workspace.id ?? '';
  const [activeTab, setActiveTab] = useState<'saved' | 'create'>(
    canEdit ? (initialTab ?? 'create') : 'saved',
  );

  useEffect(() => {
    // Members who cannot edit only see the saved plans.
    if (!canEdit) setActiveTab('saved');
    else if (initialTab) setActiveTab(initialTab);
  }, [canEdit, initialTab]);

  useEffect(
    () => () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
    },
    [],
  );

  const showTemporarySuccess = (message: string, remoteUrl?: string) => {
    if (successTimerRef.current) clearTimeout(successTimerRef.current);
    setPublishedSuiteUrl(remoteUrl ?? null);
    setSuccessMessage(message);
    successTimerRef.current = setTimeout(() => setSuccessMessage(null), remoteUrl ? 10000 : 3000);
  };

  const [azureMembers, setAzureMembers] = useState<readonly AzureDevOpsMemberDto[]>([]);
  const [azureAreaPaths, setAzureAreaPaths] = useState<readonly string[]>([]);
  const [azureStates, setAzureStates] = useState<readonly string[]>([]);
  const [azureOptionsError, setAzureOptionsError] = useState(false);
  const [azureOptionsLoaded, setAzureOptionsLoaded] = useState(false);
  const [isLoadingMembers, setIsLoadingMembers] = useState(false);
  const [availableAgents, setAvailableAgents] = useState<readonly CustomAgentDto[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>('');

  const [story, setStory] = useState('');
  const [criteria, setCriteria] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [generatedCases, setGeneratedCases] = useState<readonly TestCase[] | null>(null);
  const [exportFormat, setExportFormat] = useState<'azure' | 'standard'>('azure');
  const [exportArea, setExportArea] = useState('');
  const [exportAssignee, setExportAssignee] = useState('');
  const [exportState, setExportState] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [savedPlans, setSavedPlans] = useState<readonly SavedTestPlanDto[]>([]);
  const [savedPlansPage, setSavedPlansPage] = useState(1);
  const [savedPlansTotal, setSavedPlansTotal] = useState(0);
  const [savedPlansTotalPages, setSavedPlansTotalPages] = useState(0);
  const [isLoadingSavedPlans, setIsLoadingSavedPlans] = useState(false);
  const [savedPlansError, setSavedPlansError] = useState<string | null>(null);
  const [selectedSavedId, setSelectedSavedId] = useState<string | null>(null);
  const [savedTitle, setSavedTitle] = useState('');
  const [selectedSuiteId, setSelectedSuiteId] = useState<string>('');
  const [testSuites, setTestSuites] = useState<readonly TestSuiteDto[]>([]);
  const [isLoadingTestSuites, setIsLoadingTestSuites] = useState(false);
  const [isCreatingSuite, setIsCreatingSuite] = useState(false);
  const [pushingSuiteId, setPushingSuiteId] = useState<string | null>(null);
  const [publishedSuiteUrl, setPublishedSuiteUrl] = useState<string | null>(null);
  const [suiteToPublish, setSuiteToPublish] = useState<TestSuiteDto | null>(null);
  // An import starts from a suite's menu (cases may go into it) or from the tree header.
  const [importTarget, setImportTarget] = useState<{ suite: TestSuiteDto | null } | null>(null);
  // Every Test Plan, for the suite tree; the paged list only covers plans outside suites.
  const [treePlans, setTreePlans] = useState<readonly SavedTestPlanDto[] | null>(null);

  // Delete plan state
  const [planToDelete, setPlanToDelete] = useState<SavedTestPlanDto | null>(null);
  const [isDeletingPlan, setIsDeletingPlan] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // Delete suite state
  const [suiteToDelete, setSuiteToDelete] = useState<TestSuiteDto | null>(null);
  const [deleteSuiteConfirmText, setDeleteSuiteConfirmText] = useState('');
  const [isDeletingSuite, setIsDeletingSuite] = useState(false);
  const [deleteSuiteError, setDeleteSuiteError] = useState<string | null>(null);

  // Edit test case state
  const [editingTestCase, setEditingTestCase] = useState<TestCase | null>(null);
  const [isSavingPlan, setIsSavingPlan] = useState(false);

  useEffect(() => {
    setSelectedAgentId('');
    setExportArea('');
    setExportAssignee('');
    setExportState('');
    setAzureMembers([]);
    setAzureAreaPaths([]);
    setAzureStates([]);
    setAzureOptionsError(false);
    setAzureOptionsLoaded(false);
  }, [selectedWorkspaceId]);

  const loadAzureExportOptions = useCallback(async () => {
    if (!apiClient) {
      setAzureMembers([]);
      setAzureAreaPaths([]);
      setAzureStates([]);
      setAzureOptionsError(false);
      setAzureOptionsLoaded(true);
      return;
    }

    setIsLoadingMembers(true);
    setAzureOptionsError(false);
    try {
      const azData = await apiClient.getAzureDevOpsProjectMembers(undefined, true);
      if (azData.configured && azData.project) {
        setAzureMembers(azData.members);
        setAzureAreaPaths(azData.areaPaths ?? []);
        setAzureStates(azData.states ?? []);
      } else {
        setAzureMembers([]);
        setAzureAreaPaths([]);
        setAzureStates([]);
      }
    } catch {
      setAzureMembers([]);
      setAzureAreaPaths([]);
      setAzureStates([]);
      setAzureOptionsError(true);
    } finally {
      setAzureOptionsLoaded(true);
      setIsLoadingMembers(false);
    }
  }, [apiClient]);

  useEffect(() => {
    let active = true;
    if (selectedWorkspaceId) {
      void apiClient
        ?.getAgents()
        .then((agentList) => active && setAvailableAgents(agentList))
        .catch(() => active && setAvailableAgents([]));
    } else {
      setAvailableAgents([]);
    }
    return () => {
      active = false;
    };
  }, [apiClient, selectedWorkspaceId]);

  const loadSavedPlans = useCallback(async () => {
    if (!apiClient || !selectedWorkspaceId) {
      setSavedPlans([]);
      setSavedPlansTotal(0);
      setSavedPlansTotalPages(0);
      return;
    }
    setIsLoadingSavedPlans(true);
    setSavedPlansError(null);
    try {
      const result = await apiClient.getSavedTestPlans(savedPlansPage, 8);
      setSavedPlans(result.items);
      setSavedPlansTotal(result.total);
      setSavedPlansTotalPages(result.totalPages);
      // Imported plans can fill many suites: the tree shows all of them, not one page.
      setTreePlans(
        result.totalPages > 1
          ? await apiClient.getAllSavedTestPlans().catch(() => null)
          : result.items,
      );
    } catch (error) {
      setSavedPlans([]);
      setSavedPlansError(
        error instanceof Error ? error.message : t('testplans.savedPlansLoadFailed'),
      );
    } finally {
      setIsLoadingSavedPlans(false);
    }
  }, [apiClient, savedPlansPage, selectedWorkspaceId, t]);

  useEffect(() => {
    void loadSavedPlans();
  }, [loadSavedPlans]);

  /* v8 ignore start -- suite requests are exercised by the end-to-end Test Plans workflow. */
  const loadTestSuites = useCallback(async () => {
    if (!apiClient || !selectedWorkspaceId) {
      setTestSuites([]);
      return;
    }
    setIsLoadingTestSuites(true);
    try {
      setTestSuites(await apiClient.getTestSuites());
    } catch {
      setTestSuites([]);
    } finally {
      setIsLoadingTestSuites(false);
    }
  }, [apiClient, selectedWorkspaceId]);
  useEffect(() => {
    void loadTestSuites();
  }, [loadTestSuites]);

  const createSuite = async (name: string, parentId?: string) => {
    if (!apiClient) return;
    setIsCreatingSuite(true);
    try {
      await apiClient.createTestSuite(name, parentId);
      await loadTestSuites();
    } catch (error) {
      setSavedPlansError(
        error instanceof Error ? error.message : t('testplans.savedPlansLoadFailed'),
      );
    } finally {
      setIsCreatingSuite(false);
    }
  };
  const renameSuite = async (id: string, name: string) => {
    if (!apiClient) return;
    try {
      await apiClient.updateTestSuite(id, { name });
      await loadTestSuites();
    } catch (error) {
      setSavedPlansError(
        error instanceof Error ? error.message : t('testplans.savedPlansLoadFailed'),
      );
    }
  };
  const pushSuite = async (input: PublishTestSuiteInput) => {
    if (!apiClient || !suiteToPublish) throw new Error(t('testplans.suitePushFailed'));
    setPushingSuiteId(suiteToPublish.id);
    try {
      return await runActivity(
        { kind: 'push', title: `Publicando suíte “${suiteToPublish.name}”` },
        () => apiClient.pushTestSuite(suiteToPublish.id, input),
      );
    } finally {
      setPushingSuiteId(null);
    }
  };
  /* v8 ignore stop */

  const handleDeleteSuite = async () => {
    if (!apiClient || !suiteToDelete) return;
    setIsDeletingSuite(true);
    setDeleteSuiteError(null);
    try {
      await apiClient.deleteTestSuite(suiteToDelete.id);
      await loadTestSuites();
      await loadSavedPlans();
      setSuiteToDelete(null);
      setDeleteSuiteConfirmText('');
      showTemporarySuccess(t('testplans.suiteDeleted'));
    } catch (error) {
      setDeleteSuiteError(
        error instanceof Error ? error.message : t('testplans.savedPlansLoadFailed'),
      );
    } finally {
      setIsDeletingSuite(false);
    }
  };

  useEffect(() => {
    setSavedPlansPage(1);
  }, [selectedWorkspaceId]);

  const currentWorkspace = workspaces.find((w) => w.workspace.id === selectedWorkspaceId);
  const handleGenerate = async () => {
    const trimmedStory = story.trim();
    if (!trimmedStory) {
      setErrorMessage(t('testplans.requirementRequired'));
      return;
    }
    if (selectedWorkspaceId && testSuites.length > 0 && !selectedSuiteId) {
      setErrorMessage(t('testplans.suiteRequired'));
      return;
    }

    setErrorMessage(null);
    setIsGenerating(true);

    const testPlanTitle = currentWorkspace
      ? `Plano de Testes - ${currentWorkspace.workspace.name}`
      : undefined;

    // External assignees are selected only during export, keeping plan creation provider-neutral.

    try {
      if (apiClient) {
        if (selectedWorkspaceId) {
          apiClient.setWorkspaceId(selectedWorkspaceId);
        }
        const res = await runActivity(
          { kind: 'agent', title: 'Agentes gerando plano de testes' },
          () =>
            apiClient.generateTestPlan(trimmedStory, {
              title: testPlanTitle,
              criteria: criteria.trim() || undefined,
              format: 'standard',
              workspaceId: selectedWorkspaceId || undefined,
              suiteId: selectedSuiteId || undefined,
              agentId: selectedAgentId.trim() || undefined,
            }),
        );
        if (selectedWorkspaceId && !res.savedPlan) {
          throw new Error(t('testplans.generatedNotSaved'));
        }
        const cases = toTestCases(res.savedPlan?.plans ?? res.plans);
        setGeneratedCases(cases.length > 0 ? cases : defaultTestCases);
        if (res.savedPlan) {
          setSavedPlans((current) => [
            res.savedPlan!,
            ...current.filter((p) => p.id !== res.savedPlan!.id),
          ]);
          setSelectedSavedId(res.savedPlan.id);
          setSavedTitle(res.savedPlan.title);
          setSelectedSuiteId(res.savedPlan.suiteId ?? '');
          await loadTestSuites();
          setSavedPlansTotal((current) => current + 1);
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, 300));
        setGeneratedCases(defaultTestCases);
      }
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Falha ao conectar ao gerador de testes.',
      );
      setGeneratedCases(null);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleClear = () => {
    setStory('');
    setCriteria('');
    setSelectedAgentId('');
    setExportArea('');
    setExportAssignee('');
    setExportState('');
    setGeneratedCases(null);
    setErrorMessage(null);
    setSelectedSavedId(null);
    setSavedTitle('');
    setSelectedSuiteId('');
  };

  const openSavedPlan = (plan: SavedTestPlanDto) => {
    setSelectedSavedId(plan.id);
    setSavedTitle(plan.title);
    setSelectedSuiteId(plan.suiteId ?? '');
    setStory(plan.plans[0]?.description ?? '');
    setCriteria('');
    setGeneratedCases(toTestCases(plan.plans));
    setActiveTab('saved');
  };

  const saveSelectedPlan = async (cases: readonly TestCase[] | null = generatedCases) => {
    if (!selectedSavedId || !cases) return;
    if (testSuites.length > 0 && !selectedSuiteId) {
      setErrorMessage(t('testplans.suiteRequired'));
      return;
    }
    setIsSavingPlan(true);
    setErrorMessage(null);
    try {
      if (apiClient) {
        const updated = await apiClient.updateSavedTestPlan(selectedSavedId, {
          title: savedTitle || 'Test Plan',
          plans: cases.map((item) => ({
            title: item.title,
            description: item.scenario,
            steps: item.steps ? [...item.steps] : [],
            // Keeping the ID lets the history follow each case across edits.
            ...(item.caseId ? { metadata: { caseId: item.caseId } } : {}),
          })),
          suiteId: selectedSuiteId || null,
        });
        setSavedPlans((current) =>
          current.map((plan) => (plan.id === updated.id ? updated : plan)),
        );
        setTreePlans((current) =>
          current ? current.map((plan) => (plan.id === updated.id ? updated : plan)) : current,
        );
        // New cases get their IDs from the API.
        setGeneratedCases(toTestCases(updated.plans));
      }
      showTemporarySuccess(t('testplans.changesSaved'));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t('testplans.saveChangesFailed'));
    } finally {
      setIsSavingPlan(false);
    }
  };

  const handleDeletePlan = async (planId: string) => {
    setIsDeletingPlan(true);
    setDeleteError(null);
    try {
      if (apiClient) {
        await apiClient.deleteSavedTestPlan(planId);
      }
      const nextPage =
        savedPlans.length === 1 && savedPlansPage > 1 ? savedPlansPage - 1 : savedPlansPage;
      setSavedPlansTotal((current) => Math.max(0, current - 1));
      if (selectedSavedId === planId) {
        setSelectedSavedId(null);
        setGeneratedCases(null);
        setSavedTitle('');
      }
      setPlanToDelete(null);
      if (nextPage !== savedPlansPage) {
        setSavedPlansPage(nextPage);
      } else {
        await loadSavedPlans();
      }
      showTemporarySuccess(t('testplans.planDeleted'));
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : 'Falha ao excluir plano de testes.');
    } finally {
      setIsDeletingPlan(false);
    }
  };

  const handleSaveTestCase = async (updatedCase: TestCase) => {
    if (!generatedCases) return;
    const known = generatedCases.some((tc) => tc.id === updatedCase.id);
    const next = known
      ? generatedCases.map((tc) => (tc.id === updatedCase.id ? updatedCase : tc))
      : [...generatedCases, updatedCase];
    setGeneratedCases(next);
    setEditingTestCase(null);
    // A saved Test Plan keeps the change at once, like PBIs and issues.
    if (activeTab === 'saved' && selectedSavedId) await saveSelectedPlan(next);
  };

  const openCase = (plan: SavedTestPlanDto, index: number) => {
    openSavedPlan(plan);
    setEditingTestCase(toTestCases(plan.plans)[index] ?? null);
  };

  const handleDeleteTestCase = (testCaseId: string) => {
    if (!generatedCases) return;
    setGeneratedCases(generatedCases.filter((tc) => tc.id !== testCaseId));
  };

  const handleAddTestCase = () => {
    const nextNum = (generatedCases?.length ?? 0) + 1;
    const newCase: TestCase = {
      id: `CT-${String(nextNum).padStart(2, '0')}`,
      title: t('testplans.newCaseTitle', { number: nextNum }),
      scenario: t('testplans.newCaseScenario'),
      steps: [
        {
          order: 1,
          action: t('testplans.newStepAction'),
          expectedResult: t('testplans.newStepExpected'),
        },
      ],
    };
    setGeneratedCases([...(generatedCases ?? []), newCase]);
    setEditingTestCase(newCase);
  };

  const caseHistory = (testCase: TestCase) =>
    apiClient && selectedSavedId && testCase.caseId ? (
      <HistoryViewer
        apiClient={apiClient}
        workspaceId={selectedWorkspaceId}
        entityType="testcase"
        entityId={`${selectedSavedId}:${testCase.caseId}`}
        entityTitle={`${testCase.id} — ${testCase.title}`}
        size="sm"
      />
    ) : null;

  const handleDownloadCsv = async () => {
    setIsDownloading(true);
    setErrorMessage(null);
    try {
      await runActivity({ kind: 'download', title: 'Exportando Test Plan em CSV' }, () => {
        const csvContent = exportCasesCsv(
          (generatedCases ?? []).map((item) => ({
            title: item.title,
            description: item.scenario,
            steps: item.steps ?? [],
          })),
          {
            format: exportFormat,
            areaPath: exportArea,
            assignedTo: exportAssignee,
            state: exportState,
          },
        );
        const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `TestPlan-${Date.now()}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        return Promise.resolve();
      });
    } catch (error) {
      const csvErrorKeys = {
        INCOMPLETE_CASE: 'testplans.csvIncompleteCase',
        MISSING_AZURE_DESTINATION: 'testplans.csvMissingDestination',
        INCOMPLETE_STEP: 'testplans.csvIncompleteStep',
      } as const;
      const csvErrorKey = error instanceof CsvExportError ? csvErrorKeys[error.code] : null;
      setErrorMessage(
        csvErrorKey
          ? t(csvErrorKey)
          : error instanceof Error
            ? error.message
            : t('testplans.csvDownloadFailed'),
      );
    } finally {
      setIsDownloading(false);
    }
  };

  const handleExportSuite = async (suite: TestSuiteDto) => {
    setIsDownloading(true);
    setErrorMessage(null);
    try {
      let availablePlans = savedPlans;
      if (apiClient) {
        const firstPage = await apiClient.getSavedTestPlans(1, 50);
        const remainingPages = await Promise.all(
          Array.from({ length: Math.max(0, firstPage.totalPages - 1) }, (_, index) =>
            apiClient.getSavedTestPlans(index + 2, 50),
          ),
        );
        availablePlans = [firstPage, ...remainingPages].flatMap((page) => page.items);
      }
      const suiteIds = new Set<string>([suite.id]);
      let didAddSuite = true;
      while (didAddSuite) {
        didAddSuite = false;
        for (const candidate of testSuites)
          if (
            candidate.parentId &&
            suiteIds.has(candidate.parentId) &&
            !suiteIds.has(candidate.id)
          ) {
            suiteIds.add(candidate.id);
            didAddSuite = true;
          }
      }
      const safeName = (value: string) =>
        value
          .trim()
          .replace(/[<>:"/\\|?*]+/g, '-')
          .replace(/\s+/g, ' ') || 'Test Plan';
      const files = availablePlans
        .filter((plan) => plan.suiteId && suiteIds.has(plan.suiteId))
        .map((plan, index) => ({
          path:
            safeName(suite.name) +
            '/' +
            String(index + 1).padStart(2, '0') +
            ' - ' +
            safeName(plan.title) +
            '.csv',
          content: exportCasesCsv(plan.plans, {
            format: exportFormat,
            areaPath: exportArea,
            assignedTo: exportAssignee,
            state: exportState,
          }),
        }));
      if (!files.length) throw new CsvExportError('INCOMPLETE_CASE');
      const blob = createSuiteZip(files);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', safeName(suite.name) + '.zip');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (error) {
      const csvErrorKeys = {
        INCOMPLETE_CASE: 'testplans.csvIncompleteCase',
        MISSING_AZURE_DESTINATION: 'testplans.csvMissingDestination',
        INCOMPLETE_STEP: 'testplans.csvIncompleteStep',
      } as const;
      const csvErrorKey = error instanceof CsvExportError ? csvErrorKeys[error.code] : null;
      setErrorMessage(csvErrorKey ? t(csvErrorKey) : t('testplans.csvDownloadFailed'));
    } finally {
      setIsDownloading(false);
    }
  };

  const selectedPlanObj = savedPlans.find((p) => p.id === selectedSavedId);

  return (
    <div className={cn('max-w-4xl space-y-5', className)} data-testid="screen-testplans">
      {/* Top Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <i className="ti ti-checklist text-2xl text-[var(--fill-accent)]" aria-hidden="true" />
            <h1 className="text-xl font-bold tracking-tight text-[var(--text-primary)]">
              {t('testplans.heading')}
            </h1>
          </div>
          <p className="mt-1 text-sm text-[var(--text-secondary)]">
            {activeTab === 'saved' ? t('testplans.savedSubtitle') : t('testplans.createSubtitle')}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {activeTab === 'saved' ? (
            canEdit && (
              <Button
                type="button"
                onClick={() => {
                  setActiveTab('create');
                  handleClear();
                }}
                data-testid="btn-new-test-plan"
                leftIcon={<i className="ti ti-plus text-base" aria-hidden="true" />}
              >
                {t('testplans.newPlan')}
              </Button>
            )
          ) : (
            <Button
              type="button"
              variant="outline"
              onClick={() => setActiveTab('saved')}
              data-testid="btn-view-saved-plans"
              leftIcon={<i className="ti ti-folder text-base" aria-hidden="true" />}
            >
              {t('testplans.viewSavedPlans', { count: savedPlansTotal })}
            </Button>
          )}
        </div>
      </div>

      {/* Tabs Navigation */}
      <div className="flex items-center border-b border-[var(--border)] gap-6 text-sm font-medium">
        <Button
          type="button"
          variant="ghost"
          onClick={() => setActiveTab('saved')}
          className={cn(
            'flex items-center gap-2 rounded-none border-b-2 px-1 pb-3 pt-2 font-medium transition-colors hover:bg-transparent',
            activeTab === 'saved'
              ? 'border-[var(--fill-accent)] text-[var(--fill-accent)] font-semibold'
              : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
          )}
          data-testid="tab-saved-test-plans"
          leftIcon={<i className="ti ti-folder text-base" aria-hidden="true" />}
        >
          <span>{t('runtime.savedTestPlans')}</span>
          <span className="ml-1 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs text-[var(--text-muted)]">
            {savedPlansTotal}
          </span>
        </Button>

        {canEdit && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              handleClear();
              setActiveTab('create');
            }}
            className={cn(
              'flex items-center gap-2 rounded-none border-b-2 px-1 pb-3 pt-2 font-medium transition-colors hover:bg-transparent',
              activeTab === 'create'
                ? 'border-[var(--fill-accent)] text-[var(--fill-accent)] font-semibold'
                : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
            data-testid="tab-create-test-plan"
            leftIcon={<i className="ti ti-wand text-base" aria-hidden="true" />}
          >
            <span>{t('runtime.registerGenerateTests')}</span>
          </Button>
        )}
      </div>

      {/* Feedback Messages */}
      {(generatedCases || activeTab === 'saved') && (
        <details
          className="rounded-lg border border-border bg-surface-1 p-4"
          aria-label={t('testplans.csvConfiguration')}
          onToggle={(event) => {
            if (event.currentTarget.open && exportFormat === 'azure' && !azureOptionsLoaded) {
              void loadAzureExportOptions();
            }
          }}
        >
          <summary className="cursor-pointer text-sm font-semibold focus-visible:outline-none focus-visible:ring-2">
            {t('testplans.csvConfiguration')}
          </summary>
          <div className="mt-3 space-y-3">
            <Select
              aria-label={t('testplans.csvFormat')}
              value={exportFormat}
              onChange={(event) => {
                const format = event.target.value as 'azure' | 'standard';
                setExportFormat(format);
                if (format === 'azure' && !azureOptionsLoaded) void loadAzureExportOptions();
              }}
            >
              <option value="azure">Azure DevOps Test Cases</option>
              <option value="standard">{t('runtime.standardCsv')}</option>
            </Select>
            {exportFormat === 'azure' && (
              <>
                <AzureExportFields
                  key={selectedWorkspaceId}
                  areas={azureAreaPaths}
                  members={azureMembers}
                  states={azureStates}
                  loading={isLoadingMembers}
                  error={azureOptionsError}
                  area={exportArea}
                  assignee={exportAssignee}
                  state={exportState}
                  onArea={setExportArea}
                  onAssignee={setExportAssignee}
                  onState={setExportState}
                  onRetry={() => void loadAzureExportOptions()}
                />
                <p className="text-xs text-muted">{t('testplans.csvAzureGuidance')}</p>
              </>
            )}
          </div>
        </details>
      )}
      {successMessage && (
        <div
          className="flex items-center rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-3 text-xs text-emerald-400"
          role="status"
        >
          <i className="ti ti-check mr-1.5 text-base" />
          <span>{successMessage}</span>
          {publishedSuiteUrl && (
            <a
              href={publishedSuiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ml-2 underline"
            >
              {t('testplans.openPublishedSuite')}
            </a>
          )}
        </div>
      )}

      {errorMessage && (
        <div
          className="flex items-center rounded-lg border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-400"
          role="alert"
        >
          <i className="ti ti-alert-triangle mr-1.5 text-base" />
          <span>{errorMessage}</span>
        </div>
      )}

      {/* TAB 1: SAVED TEST PLANS */}
      {activeTab === 'saved' && (
        <div className="space-y-5" data-testid="panel-saved-plans">
          {!selectedSavedId && (
            <TestSuiteTree
              suites={testSuites}
              plans={treePlans ?? savedPlans}
              onCreate={canEdit ? (name, parentId) => createSuite(name, parentId) : undefined}
              onCreatePlan={
                canEdit
                  ? (suiteId) => {
                      setSelectedSuiteId(suiteId);
                      handleClear();
                      setActiveTab('create');
                    }
                  : undefined
              }
              onRename={canEdit ? (id, name) => void renameSuite(id, name) : undefined}
              onDelete={canDelete ? (suite) => setSuiteToDelete(suite) : undefined}
              onOpenPlan={openSavedPlan}
              onDeletePlan={canDelete ? setPlanToDelete : undefined}
              onExportSuite={(suite) => void handleExportSuite(suite)}
              onPushSuite={
                canEdit
                  ? (suite) => {
                      setSuiteToPublish(suite);
                      setPublishedSuiteUrl(null);
                      setSuccessMessage(null);
                    }
                  : undefined
              }
              onImportCases={canEdit ? (suite) => setImportTarget({ suite }) : undefined}
              onImport={canEdit && apiClient ? () => setImportTarget({ suite: null }) : undefined}
              onOpenCase={openCase}
              onAutomate={onAutomate}
              pushingSuiteId={pushingSuiteId}
              isLoading={isLoadingTestSuites}
              isCreating={isCreatingSuite}
            />
          )}
          {/* The section also renders on failure so a load or suite error stays visible even when
              the workspace has no plan outside a suite. */}
          {!selectedSavedId && (savedPlansError || savedPlans.some((plan) => !plan.suiteId)) ? (
            /* SAVED PLANS LIST VIEW */
            <section
              className="rounded-lg border border-border bg-surface-1 p-4"
              aria-label={t('testplans.savedPlans')}
            >
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  {t('testplans.savedPlans')}
                </h2>
                <span className="text-xs text-muted">
                  {t('testplans.plansCount', { count: savedPlansTotal })}
                </span>
              </div>

              {isLoadingSavedPlans ? (
                <div
                  className="grid gap-3 sm:grid-cols-2"
                  aria-label={t('testplans.loadingSavedPlans')}
                >
                  {Array.from({ length: 6 }).map((_, index) => (
                    <SkeletonListItem
                      key={index}
                      className="h-[58px] min-w-0 border border-border bg-surface-2/40 p-2.5"
                    />
                  ))}
                </div>
              ) : savedPlansError ? (
                <div className="p-8 text-center space-y-3" role="alert">
                  <p className="text-sm text-red-400">{savedPlansError}</p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void loadSavedPlans()}
                  >
                    {t('common.retry')}
                  </Button>
                </div>
              ) : savedPlans.length === 0 ? (
                <div className="p-8 text-center space-y-3">
                  <i
                    className="ti ti-folder-off text-3xl text-muted block mx-auto"
                    aria-hidden="true"
                  />
                  <p className="text-sm text-muted">{t('runtime.noSavedTestPlan')}</p>
                  {canEdit && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        handleClear();
                        setActiveTab('create');
                      }}
                      data-testid="btn-empty-create-plan"
                    >
                      {t('testplans.createNewPlan')}
                    </Button>
                  )}
                </div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {savedPlans
                    .filter((plan) => !plan.suiteId)
                    .map((plan) => (
                      <div
                        key={plan.id}
                        className="group flex min-w-0 items-center justify-between rounded-lg border border-border bg-surface-2/40 p-2.5 transition hover:border-[var(--border-strong)] hover:bg-surface-2"
                        data-testid={`saved-plan-card-${plan.id}`}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-auto min-w-0 flex-1 justify-start p-0 text-left hover:bg-transparent"
                          onClick={() => openSavedPlan(plan)}
                          aria-label={t('testplans.openPlan', { title: plan.title })}
                        >
                          <span className="min-w-0 pr-2">
                            <span className="block truncate font-medium text-[var(--text-primary)] group-hover:text-accent-foreground">
                              {plan.title}
                            </span>
                            <span className="block text-xs text-muted">
                              {t('testplans.casesCount', { count: plan.plans.length })} ·{' '}
                              {formatDate(plan.updatedAt)}
                            </span>
                          </span>
                        </Button>

                        <ActionsMenu label={`${t('common.actions')}: ${plan.title}`}>
                          {apiClient && (
                            <HistoryViewer
                              apiClient={apiClient}
                              workspaceId={selectedWorkspaceId}
                              entityType="testplan"
                              entityId={plan.id}
                              entityTitle={plan.title}
                            />
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0 text-muted hover:text-[var(--text-primary)]"
                            onClick={() => openSavedPlan(plan)}
                            title={t('testplans.viewAndEdit')}
                            aria-label={t('testplans.editPlan', { title: plan.title })}
                          >
                            <i className="ti ti-edit text-sm" aria-hidden="true" />
                            {t('common.edit')}
                          </Button>
                          {canDelete && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0 text-red-400 hover:bg-red-950/30 hover:text-red-300"
                              onClick={() => setPlanToDelete(plan)}
                              title={t('common.delete')}
                              aria-label={t('testplans.deletePlan', { title: plan.title })}
                              data-destructive
                              data-testid={`btn-delete-plan-${plan.id}`}
                            >
                              <i className="ti ti-trash text-sm" aria-hidden="true" />
                              {t('common.delete')}
                            </Button>
                          )}
                        </ActionsMenu>
                      </div>
                    ))}
                </div>
              )}
              {!isLoadingSavedPlans && !savedPlansError && savedPlansTotalPages > 1 && (
                <nav
                  className="mt-4 flex items-center justify-between border-t border-border pt-4"
                  aria-label={t('testplans.plansPagination')}
                >
                  <span className="text-xs text-muted">
                    {t('testplans.pageOf', {
                      page: savedPlansPage,
                      total: savedPlansTotalPages,
                    })}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={savedPlansPage === 1}
                      onClick={() => setSavedPlansPage((page) => page - 1)}
                      aria-label={t('testplans.previousPage')}
                    >
                      {t('testplans.previousPage')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={savedPlansPage >= savedPlansTotalPages}
                      onClick={() => setSavedPlansPage((page) => page + 1)}
                      aria-label={t('testplans.nextPage')}
                    >
                      {t('testplans.nextPage')}
                    </Button>
                  </div>
                </nav>
              )}
            </section>
          ) : selectedSavedId ? (
            /* SAVED PLAN DETAIL & EDIT VIEW */
            <div className="space-y-4" data-testid="saved-plan-detail">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-3">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setSelectedSavedId(null);
                    setGeneratedCases(null);
                    setSavedTitle('');
                  }}
                  data-testid="btn-back-to-saved"
                  leftIcon={<i className="ti ti-arrow-left text-sm" aria-hidden="true" />}
                >
                  {t('testplans.backToPlans')}
                </Button>
              </div>
              <div className="flex items-start justify-between gap-4">
                <h2 className="min-w-0 flex-1 break-words text-xl font-semibold">{savedTitle}</h2>
                <ActionsMenu key={selectedSavedId}>
                  {apiClient && selectedSavedId && (
                    <HistoryViewer
                      apiClient={apiClient}
                      workspaceId={selectedWorkspaceId}
                      entityType="testplan"
                      entityId={selectedSavedId}
                      entityTitle={savedTitle}
                    />
                  )}
                  {canEdit && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={handleAddTestCase}
                      data-testid="btn-add-test-case"
                      leftIcon={<i className="ti ti-plus text-xs" aria-hidden="true" />}
                    >
                      {t('testplans.addTest')}
                    </Button>
                  )}

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void handleDownloadCsv()}
                    disabled={isDownloading}
                    isLoading={isDownloading}
                    leftIcon={<i className="ti ti-download text-xs" aria-hidden="true" />}
                    aria-label={t('testplans.exportCsv')}
                  >
                    {t('testplans.exportCsv')}
                  </Button>

                  {canDelete && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-red-400 hover:bg-red-950/30 hover:text-red-300"
                      onClick={() => selectedPlanObj && setPlanToDelete(selectedPlanObj)}
                      title={t('common.delete')}
                      data-destructive
                      data-testid="btn-delete-current-plan"
                      leftIcon={<i className="ti ti-trash text-xs" aria-hidden="true" />}
                    >
                      {t('common.delete')}
                    </Button>
                  )}
                </ActionsMenu>
              </div>

              {/* Title & Save Bar */}
              <div className="rounded-lg border border-border bg-surface-1 p-4 space-y-3">
                <label className="block text-xs font-semibold text-[var(--text-secondary)]">
                  {t('testplans.planTitle')}
                </label>
                <div className="flex gap-2">
                  <Input
                    value={savedTitle}
                    disabled={!canEdit}
                    onChange={(event) => setSavedTitle(event.target.value)}
                    aria-label={t('testplans.planTitle')}
                    placeholder={t('testplans.planNamePlaceholder')}
                  />
                  {/* Saving rejects a plan left outside a suite, so the suite must be selectable
                      here as well as on the creation form. */}
                  {testSuites.length > 0 && (
                    <Select
                      aria-label={t('testplans.testSuite')}
                      value={selectedSuiteId}
                      disabled={!canEdit}
                      onChange={(event) => setSelectedSuiteId(event.target.value)}
                    >
                      <option value="">{t('testplans.selectSuite')}</option>
                      {testSuites.map((suite) => (
                        <option key={suite.id} value={suite.id}>
                          {suite.name}
                        </option>
                      ))}
                    </Select>
                  )}
                  {canEdit && (
                    <Button
                      type="button"
                      onClick={() => void saveSelectedPlan()}
                      disabled={isSavingPlan}
                      isLoading={isSavingPlan}
                      aria-label={t('testplans.saveChanges')}
                      data-testid="btn-save-plan-changes"
                    >
                      {t('testplans.saveChanges')}
                    </Button>
                  )}
                </div>
              </div>

              {/* Test Cases List */}
              {generatedCases && (
                <div
                  className="rounded-lg border border-border-accent bg-surface-2 p-4 text-[13px] leading-relaxed text-[var(--text-primary)] space-y-3"
                  data-testid="test-result"
                >
                  <div className="flex items-center justify-between border-b border-border pb-2">
                    <span className="font-semibold text-accent-foreground text-sm">
                      {t('testplans.generatedCases', { count: generatedCases.length })}
                    </span>
                    <span className="text-xs text-muted">{t('testplans.editOrDeleteCase')}</span>
                  </div>

                  {generatedCases.length === 0 ? (
                    <div className="p-6 text-center text-muted text-xs">
                      {t('testplans.emptyPlanCases')}
                    </div>
                  ) : (
                    generatedCases.map((testCase) => {
                      const origin = testCaseOrigin(testCase.metadata);
                      return (
                        <div
                          key={testCase.id}
                          className="flex items-center gap-2 rounded-lg border border-border bg-surface-1 p-2.5 text-xs text-[var(--text-secondary)] transition hover:border-[var(--border-strong)]"
                          data-testid={`test-case-${testCase.id}`}
                        >
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-center gap-3 text-left"
                            onClick={() => setEditingTestCase(testCase)}
                            aria-label={t('testplans.openCase', { id: testCase.id })}
                          >
                            <span className="w-12 shrink-0 font-mono text-[11px] text-muted">
                              {testCase.id}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-semibold text-[var(--text-primary)]">
                                {testCase.title}
                              </span>
                              <span className="block text-[11px] text-muted">
                                {t('testplans.stepsShort', { count: testCase.steps?.length ?? 0 })}
                                {origin && ` · ${origin.providerName} #${origin.caseId}`}
                              </span>
                            </span>
                          </button>
                          <div className="flex items-center gap-1">
                            {caseHistory(testCase)}
                            {canEdit && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs text-muted hover:text-[var(--text-primary)]"
                                onClick={() => setEditingTestCase(testCase)}
                                title={t('testplans.editCaseAction')}
                                aria-label={`${t('testplans.editCaseAction')} ${testCase.id}`}
                                data-testid={`btn-edit-test-${testCase.id}`}
                                leftIcon={<i className="ti ti-edit text-xs" aria-hidden="true" />}
                              >
                                {t('common.edit')}
                              </Button>
                            )}
                            {canDelete && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs text-red-400 hover:bg-red-950/30 hover:text-red-300"
                                onClick={() => handleDeleteTestCase(testCase.id)}
                                title={t('testplans.deleteCaseAction')}
                                aria-label={`${t('testplans.deleteCaseAction')} ${testCase.id}`}
                                data-testid={`btn-delete-test-${testCase.id}`}
                                leftIcon={<i className="ti ti-trash text-xs" aria-hidden="true" />}
                              >
                                {t('common.delete')}
                              </Button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          ) : null}
        </div>
      )}

      {/* TAB 2: CREATE / GENERATE TEST PLAN */}
      {activeTab === 'create' && (
        <div className="space-y-5" data-testid="panel-create-plan">
          <div>
            <label
              htmlFor="testplan-suite-select"
              className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]"
            >
              {t('testplans.testSuite')}
            </label>
            <Select
              id="testplan-suite-select"
              aria-label={t('testplans.testSuite')}
              value={selectedSuiteId}
              onChange={(event) => setSelectedSuiteId(event.target.value)}
              required={Boolean(selectedWorkspaceId)}
            >
              <option value="">{t('testplans.selectSuite')}</option>
              {testSuites.map((suite) => (
                <option key={suite.id} value={suite.id}>
                  {suite.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label
              htmlFor="testplan-agent-select"
              className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]"
            >
              {t('testplans.optionalAgent')}
            </label>
            <div className="w-full sm:max-w-md">
              <Select
                id="testplan-agent-select"
                value={selectedAgentId}
                onChange={(e) => setSelectedAgentId(e.target.value)}
                aria-label={t('testplans.selectGenerationAgent')}
              >
                <option value="">{t('runtime.defaultTestSpecialist')}</option>
                {availableAgents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name} ({agent.role})
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div>
            <label
              htmlFor="story-input"
              className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]"
            >
              {t('testplans.requirement')} <span className="text-red-400">*</span>
            </label>
            <Textarea
              id="story-input"
              aria-label={t('testplans.requirement')}
              placeholder={t('testplans.requirementPlaceholder')}
              value={story}
              onChange={(e) => setStory(e.target.value)}
              rows={4}
            />
          </div>

          <div>
            <label
              htmlFor="criteria-input"
              className="mb-1.5 block text-xs font-medium text-[var(--text-secondary)]"
            >
              {t('testplans.optionalAcceptanceCriteria')}
            </label>
            <Textarea
              id="criteria-input"
              placeholder={t('testplans.acceptanceCriteriaPlaceholder')}
              value={criteria}
              onChange={(e) => setCriteria(e.target.value)}
              rows={3}
            />
          </div>

          <div className="flex items-center gap-3">
            <Button
              type="button"
              onClick={() => {
                void handleGenerate();
              }}
              disabled={isGenerating}
              isLoading={isGenerating}
              leftIcon={<i className="ti ti-wand" aria-hidden="true" />}
              aria-label={t('testplans.generateTests')}
            >
              {t('testplans.generateTests')}
            </Button>

            <Button
              type="button"
              variant="outline"
              onClick={handleClear}
              leftIcon={<i className="ti ti-trash" aria-hidden="true" />}
              aria-label={t('testplans.clearFields')}
            >
              {t('common.clear')}
            </Button>

            {generatedCases && (
              <Button
                type="button"
                variant="outline"
                className="ml-auto border-border-accent text-accent-foreground"
                onClick={() => {
                  void handleDownloadCsv();
                }}
                disabled={isDownloading}
                isLoading={isDownloading}
                leftIcon={<i className="ti ti-download" aria-hidden="true" />}
                aria-label={t('testplans.exportCsv')}
              >
                {isDownloading ? t('testplans.downloading') : t('testplans.exportCsv')}
              </Button>
            )}
          </div>

          {isGenerating && (
            <div className="mt-4 space-y-3" data-testid="test-plan-skeleton">
              <div className="flex items-center gap-2 text-xs text-accent-foreground">
                <i className="ti ti-wand animate-spin text-sm" />
                <span>{t('runtime.generatingTestCases')}</span>
              </div>
              <SkeletonTestPlan />
            </div>
          )}

          {/* Generated Result in Create Tab */}
          {generatedCases && !isGenerating && (
            <div
              className="mt-3.5 rounded-lg border border-border-accent bg-surface-2 p-4 text-[13px] leading-relaxed text-[var(--text-primary)]"
              data-testid="test-result"
            >
              {selectedSavedId && (
                <div className="mb-4 flex gap-2">
                  <Input
                    value={savedTitle}
                    disabled={!canEdit}
                    onChange={(event) => setSavedTitle(event.target.value)}
                    aria-label={t('testplans.planTitle')}
                  />
                  <Button
                    type="button"
                    onClick={() => void saveSelectedPlan()}
                    aria-label={t('testplans.saveChanges')}
                    disabled={isSavingPlan}
                    isLoading={isSavingPlan}
                  >
                    {t('testplans.saveChanges')}
                  </Button>
                  <Select
                    aria-label={t('runtime.savedTestPlans')}
                    value={selectedSuiteId}
                    onChange={(event) => setSelectedSuiteId(event.target.value)}
                  >
                    <option value="" disabled>
                      {t('testplans.selectSuite')}
                    </option>
                    {testSuites.map((suite) => (
                      <option key={suite.id} value={suite.id}>
                        {suite.name}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-accent-foreground">
                  <i className="ti ti-check" aria-hidden="true" />
                  <span>{t('testplans.generatedCases', { count: generatedCases.length })}</span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                  {currentWorkspace && (
                    <span className="rounded bg-surface-1 px-2 py-0.5 border border-border">
                      {t('testplans.workspaceLabel')}{' '}
                      <strong className="text-[var(--text-primary)]">
                        {currentWorkspace.workspace.name}
                      </strong>
                    </span>
                  )}
                </div>
              </div>

              <div className="space-y-3">
                {generatedCases.map((testCase) => (
                  <div
                    key={testCase.id}
                    className="rounded-lg border border-border bg-surface-1 p-3.5 text-xs text-[var(--text-secondary)]"
                    data-testid={`test-case-${testCase.id}`}
                  >
                    <div className="flex items-center justify-between border-b border-border/50 pb-2 mb-2">
                      <strong className="text-[var(--text-primary)] text-sm font-semibold">
                        {testCase.id} — {testCase.title}
                      </strong>
                      <div className="flex items-center gap-1">
                        {caseHistory(testCase)}
                        {canEdit && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-muted hover:text-[var(--text-primary)]"
                            onClick={() => setEditingTestCase(testCase)}
                            title={t('testplans.editCaseAction')}
                            aria-label={`${t('testplans.editCaseAction')} ${testCase.id}`}
                            data-testid={`btn-edit-test-${testCase.id}`}
                            leftIcon={<i className="ti ti-edit text-xs" aria-hidden="true" />}
                          >
                            {t('common.edit')}
                          </Button>
                        )}
                        {canDelete && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-red-400 hover:bg-red-950/30 hover:text-red-300"
                            onClick={() => handleDeleteTestCase(testCase.id)}
                            title={t('testplans.deleteCaseAction')}
                            aria-label={`${t('testplans.deleteCaseAction')} ${testCase.id}`}
                            data-testid={`btn-delete-test-${testCase.id}`}
                            leftIcon={<i className="ti ti-trash text-xs" aria-hidden="true" />}
                          >
                            {t('common.delete')}
                          </Button>
                        )}
                      </div>
                    </div>
                    <FormattedContent
                      content={testCase.scenario}
                      className="leading-relaxed text-[var(--text-secondary)]"
                      data-testid={`scenario-${testCase.id}`}
                    />
                    {testCase.steps && testCase.steps.length > 0 && (
                      <div className="mt-3 border-t border-border/40 pt-2.5 space-y-2">
                        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                          {t('testplans.stepsCount', { count: testCase.steps.length })}:
                        </span>
                        <div className="space-y-1.5">
                          {testCase.steps.map((step, sIdx) => {
                            const stepNumber = step.order ?? sIdx + 1;
                            return (
                              <div
                                key={stepNumber}
                                className="flex items-start gap-2.5 rounded bg-surface-2/60 p-2.5 text-xs border border-border/40"
                                data-testid={`step-${testCase.id}-${stepNumber}`}
                              >
                                <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-accent-foreground">
                                  {stepNumber}
                                </span>
                                <div className="flex-1 min-w-0 space-y-1">
                                  <div>
                                    <span className="font-semibold text-[var(--text-primary)]">
                                      {t('testplans.actionLabel')}{' '}
                                    </span>
                                    <FormattedContent content={step.action} inline />
                                  </div>
                                  <div>
                                    <span className="font-semibold text-emerald-400">
                                      {t('testplans.expectedResultLabel')}{' '}
                                    </span>
                                    <FormattedContent content={step.expectedResult} inline />
                                  </div>
                                  {step.data ? (
                                    <div className="text-muted text-[11px]">
                                      <span className="font-medium">{t('runtime.dataLabel')} </span>
                                      <FormattedContent content={step.data} inline />
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {suiteToPublish && apiClient && (
        <PublishTestSuiteModal
          key={suiteToPublish.id}
          apiClient={apiClient}
          suite={suiteToPublish}
          onClose={() => setSuiteToPublish(null)}
          onPublish={pushSuite}
          onPublished={(result) => {
            setSuiteToPublish(null);
            showTemporarySuccess(
              result.workItem
                ? t('testplans.suitePushedLinked', {
                    type: result.workItem.type,
                    id: result.workItem.id,
                  })
                : t('testplans.suitePushed'),
              result.remoteUrl,
            );
          }}
        />
      )}
      {importTarget && apiClient && (
        <ImportTestCasesModal
          apiClient={apiClient}
          suite={importTarget.suite}
          onClose={() => setImportTarget(null)}
          onOpenIntegrations={onOpenIntegrations}
          onImported={() => {
            setImportTarget(null);
            void loadTestSuites();
            void loadSavedPlans();
          }}
        />
      )}

      {/* MODAL: DELETE PLAN CONFIRMATION */}
      {planToDelete && (
        <Modal
          open
          labelledBy="delete-plan-dialog-title"
          onClose={() => {
            if (!isDeletingPlan) {
              setPlanToDelete(null);
              setDeleteError(null);
            }
          }}
        >
          <div className="w-full max-w-md rounded-xl border border-border bg-surface-1 p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-red-400">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-950/50 border border-red-900/50">
                <i className="ti ti-alert-triangle text-xl" aria-hidden="true" />
              </div>
              <div>
                <h3
                  id="delete-plan-dialog-title"
                  className="text-base font-semibold text-[var(--text-primary)]"
                >
                  {t('testplans.deletePlanTitle')}
                </h3>
                <p className="text-xs text-muted">{t('runtime.irreversibleAction')}</p>
              </div>
            </div>

            <p className="text-sm text-[var(--text-secondary)]">
              {t('testplans.deletePlanDescription', { title: planToDelete.title })}
            </p>

            {deleteError && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-2.5 text-xs text-red-400">
                {deleteError}
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setPlanToDelete(null);
                  setDeleteError(null);
                }}
                disabled={isDeletingPlan}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => void handleDeletePlan(planToDelete.id)}
                disabled={isDeletingPlan}
                isLoading={isDeletingPlan}
                data-testid="confirm-delete-plan-btn"
              >
                {t('common.delete')}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {suiteToDelete && (
        <Modal
          open
          labelledBy="delete-suite-dialog-title"
          onClose={() => {
            if (!isDeletingSuite) {
              setSuiteToDelete(null);
              setDeleteSuiteConfirmText('');
              setDeleteSuiteError(null);
            }
          }}
        >
          <div className="w-full max-w-md rounded-xl border border-border bg-surface-1 p-6 shadow-2xl space-y-4">
            <div className="flex items-center gap-3 text-red-400">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-red-950/50 border border-red-900/50">
                <i className="ti ti-alert-triangle text-xl" aria-hidden="true" />
              </div>
              <div>
                <h3
                  id="delete-suite-dialog-title"
                  className="text-base font-semibold text-[var(--text-primary)]"
                >
                  {t('testplans.deleteSuiteTitle')}
                </h3>
                <p className="text-xs text-muted">{t('runtime.irreversibleAction')}</p>
              </div>
            </div>

            <p className="text-sm text-[var(--text-secondary)]">
              {t('testplans.deleteSuiteDescriptionBefore')}
              <strong className="font-semibold text-[var(--text-primary)]">
                {suiteToDelete.name}
              </strong>
              {t('testplans.deleteSuiteDescriptionAfter')}
            </p>

            <div className="space-y-1.5">
              <label htmlFor="delete-suite-confirm-input" className="text-xs text-muted">
                {t('testplans.deleteSuiteConfirmLabel')}
              </label>
              <Input
                id="delete-suite-confirm-input"
                autoFocus
                value={deleteSuiteConfirmText}
                onChange={(event) => setDeleteSuiteConfirmText(event.target.value)}
                placeholder={t('testplans.deleteSuiteConfirmPlaceholder', {
                  name: suiteToDelete.name,
                })}
                disabled={isDeletingSuite}
                data-testid="delete-suite-confirm-input"
              />
            </div>

            {deleteSuiteError && (
              <div className="rounded-lg border border-red-500/20 bg-red-500/10 p-2.5 text-xs text-red-400">
                {deleteSuiteError}
              </div>
            )}

            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setSuiteToDelete(null);
                  setDeleteSuiteConfirmText('');
                  setDeleteSuiteError(null);
                }}
                disabled={isDeletingSuite}
              >
                {t('common.cancel')}
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={() => void handleDeleteSuite()}
                disabled={isDeletingSuite || deleteSuiteConfirmText !== suiteToDelete.name}
                isLoading={isDeletingSuite}
                data-testid="confirm-delete-suite-btn"
              >
                {t('common.delete')}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* A single test case in its own window, like PBIs and issues. */}
      {editingTestCase && (
        <TestCaseModal
          key={editingTestCase.id}
          testCase={editingTestCase}
          readOnly={!canEdit}
          planTitle={activeTab === 'saved' && selectedSavedId ? savedTitle : undefined}
          history={caseHistory(editingTestCase)}
          isSaving={isSavingPlan}
          onClose={() => setEditingTestCase(null)}
          onSave={(updated) => void handleSaveTestCase(updated)}
          onAutomate={
            onAutomate && selectedSavedId && editingTestCase.caseId
              ? () => onAutomate({ planId: selectedSavedId, caseIds: [editingTestCase.caseId!] })
              : undefined
          }
        />
      )}
    </div>
  );
}
