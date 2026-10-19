/* v8 ignore file -- recursive interactions are covered by the Test Plans integration journey. */
import { useEffect, useMemo, useState } from 'react';
import { ActionsMenu } from '../../components/ui/actions-menu.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { SkeletonListItem } from '../../components/ui/skeleton.js';
import type { SavedTestPlanDto, TestSuiteDto } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import { TEST_MANAGEMENT_NAMES, type TestManagementProviderId } from '../e2e/e2e-types.js';

/** What an E2E run automates: a suite with its children, or one Test Plan. */
export interface AutomateSelection {
  readonly suiteId?: string;
  readonly planId?: string;
  readonly caseIds?: readonly string[];
}

const copy = {
  'pt-BR': {
    importFromProvider: 'Importar do provedor',
    automate: 'Automatizar com E2E',
    importedFrom: 'Importado de {provider}',
    showCases: 'Mostrar casos de {title}',
    openCase: 'Abrir caso {title}',
    steps: '{count} passos',
  },
  'en-US': {
    importFromProvider: 'Import from provider',
    automate: 'Automate with E2E',
    importedFrom: 'Imported from {provider}',
    showCases: 'Show cases of {title}',
    openCase: 'Open case {title}',
    steps: '{count} steps',
  },
} as const;

/** Provider of a Test Plan imported from a test management platform. */
function importedProvider(plan: SavedTestPlanDto): string | null {
  if (plan.sourceType !== 'test_management' || !plan.sourceId) return null;
  const provider = plan.sourceId.split(':')[0]!;
  return TEST_MANAGEMENT_NAMES[provider as TestManagementProviderId] ?? provider;
}

interface TestSuiteTreeProps {
  readonly suites: readonly TestSuiteDto[];
  readonly plans: readonly SavedTestPlanDto[];
  // Write actions are optional: omitting one hides its control (missing permission).
  readonly onCreate?: (name: string, parentId?: string) => Promise<void>;
  readonly onCreatePlan?: (suiteId: string) => void;
  readonly onRename?: (id: string, name: string) => void;
  readonly onDelete?: (suite: TestSuiteDto) => void;
  readonly onOpenPlan: (plan: SavedTestPlanDto) => void;
  readonly onDeletePlan?: (plan: SavedTestPlanDto) => void;
  readonly onExportSuite: (suite: TestSuiteDto) => void;
  readonly onPushSuite?: (suite: TestSuiteDto) => void;
  readonly onImportCases?: (suite: TestSuiteDto) => void;
  /** Imports plans from a test management platform into new suites. */
  readonly onImport?: () => void;
  /** Opens one case of a Test Plan in its own window. */
  readonly onOpenCase?: (plan: SavedTestPlanDto, index: number) => void;
  /** Starts an E2E run that automates the chosen suite or Test Plan. */
  readonly onAutomate?: (selection: AutomateSelection) => void;
  readonly pushingSuiteId?: string | null;
  readonly isLoading?: boolean;
  readonly isCreating?: boolean;
  readonly requestCreate?: boolean;
  readonly onCreateRequestHandled?: () => void;
}

export function TestSuiteTree({
  suites,
  plans,
  onCreate,
  onCreatePlan,
  onRename,
  onDelete,
  onOpenPlan,
  onDeletePlan,
  onExportSuite,
  onPushSuite,
  onImportCases,
  onImport,
  onOpenCase,
  onAutomate,
  pushingSuiteId,
  isLoading = false,
  isCreating = false,
  requestCreate = false,
  onCreateRequestHandled,
}: TestSuiteTreeProps) {
  const { t, formatDate, locale } = useI18n();
  const c = copy[locale];
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [openPlans, setOpenPlans] = useState<ReadonlySet<string>>(() => new Set());
  const [editing, setEditing] = useState<{ id?: string; parentId?: string; name: string } | null>(
    null,
  );
  const byParent = useMemo(() => {
    const value = new Map<string | undefined, TestSuiteDto[]>();
    for (const suite of suites)
      value.set(suite.parentId, [...(value.get(suite.parentId) ?? []), suite]);
    return value;
  }, [suites]);
  useEffect(() => {
    if (!requestCreate) return;
    setEditing({ name: '' });
    onCreateRequestHandled?.();
  }, [onCreateRequestHandled, requestCreate]);
  const save = async () => {
    if (!editing?.name.trim() || isCreating) return;
    if (editing.id) onRename?.(editing.id, editing.name.trim());
    else await onCreate?.(editing.name.trim(), editing.parentId);
    setEditing(null);
  };
  const flip = (current: ReadonlySet<string>, id: string) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  const toggle = (id: string) => setExpanded((current) => flip(current, id));
  const renderBranch = (parentId: string | undefined, depth: number) =>
    (byParent.get(parentId) ?? []).map((suite) => {
      const suitePlans = plans.filter((plan) => plan.suiteId === suite.id);
      const open = expanded.has(suite.id);
      return (
        <div key={suite.id} className="space-y-1">
          <div
            className="flex items-center gap-1 rounded px-1 py-1 hover:bg-surface-2"
            style={{ paddingLeft: `${depth * 16 + 4}px` }}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              aria-label={suite.name}
              aria-expanded={open}
              onClick={() => toggle(suite.id)}
            >
              <i className={`ti ${open ? 'ti-chevron-down' : 'ti-chevron-right'}`} />
            </Button>
            <i className={`ti ${open ? 'ti-folder-open' : 'ti-folder'} text-muted`} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{suite.name}</span>
            <span className="mr-1 text-xs text-muted">{suitePlans.length}</span>
            <ActionsMenu label={`${t('common.actions')}: ${suite.name}`}>
              {onAutomate && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onAutomate({ suiteId: suite.id })}
                >
                  <i className="ti ti-player-play" />
                  {c.automate}
                </Button>
              )}
              {onImportCases && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onImportCases(suite)}
                >
                  <i className="ti ti-cloud-download" />
                  {t('testplans.importCases')}
                </Button>
              )}
              {onPushSuite && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={Boolean(pushingSuiteId)}
                  isLoading={pushingSuiteId === suite.id}
                  onClick={() => onPushSuite(suite)}
                >
                  <i className="ti ti-cloud-upload" />
                  {pushingSuiteId === suite.id
                    ? t('testplans.pushingSuite')
                    : t('testplans.pushSuite')}
                </Button>
              )}
              <Button type="button" variant="ghost" size="sm" onClick={() => onExportSuite(suite)}>
                <i className="ti ti-file-export" />
                {t('testplans.exportSuite')}
              </Button>
              {onRename && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditing({ id: suite.id, name: suite.name })}
                >
                  <i className="ti ti-edit" />
                  {t('common.edit')}
                </Button>
              )}
              {onCreatePlan && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => onCreatePlan(suite.id)}
                >
                  <i className="ti ti-test-pipe" />
                  {t('testplans.createChoicePlan')}
                </Button>
              )}
              {onCreate && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditing({ parentId: suite.id, name: '' })}
                >
                  <i className="ti ti-folder-plus" />
                  {t('testplans.newSuite')}
                </Button>
              )}
              {onDelete && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-destructive
                  onClick={() => onDelete(suite)}
                >
                  <i className="ti ti-trash" />
                  {t('common.delete')}
                </Button>
              )}
            </ActionsMenu>
          </div>
          {open && (
            <div>
              {renderBranch(suite.id, depth + 1)}
              {suitePlans.map((plan) => {
                const provider = importedProvider(plan);
                const casesOpen = openPlans.has(plan.id);
                return (
                  <div key={plan.id}>
                    <div
                      className="group flex items-center gap-2 rounded py-2 pr-1 hover:bg-surface-2"
                      style={{ paddingLeft: `${(depth + 1) * 16 + (onOpenCase ? 4 : 36)}px` }}
                      data-testid={`saved-plan-card-${plan.id}`}
                    >
                      {onOpenCase && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 w-7 shrink-0 p-0"
                          aria-label={c.showCases.replace('{title}', plan.title)}
                          aria-expanded={casesOpen}
                          disabled={!plan.plans.length}
                          onClick={() => setOpenPlans((current) => flip(current, plan.id))}
                        >
                          <i
                            className={`ti ${casesOpen ? 'ti-chevron-down' : 'ti-chevron-right'}`}
                          />
                        </Button>
                      )}
                      <i className="ti ti-test-pipe shrink-0 text-muted" aria-hidden="true" />
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => onOpenPlan(plan)}
                        aria-label={t('testplans.openPlan', { title: plan.title })}
                      >
                        <span className="block truncate text-sm text-[var(--text-primary)]">
                          {plan.title}
                        </span>
                        <span className="block text-xs text-muted">
                          {t('testplans.casesCount', { count: plan.plans.length })} ·{' '}
                          {formatDate(plan.updatedAt)}
                        </span>
                      </button>
                      {provider && (
                        <span
                          className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted"
                          title={c.importedFrom.replace('{provider}', provider)}
                        >
                          <i className="ti ti-cloud-download mr-1" aria-hidden="true" />
                          {provider}
                        </span>
                      )}
                      <ActionsMenu label={`${t('common.actions')}: ${plan.title}`}>
                        {onAutomate && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => onAutomate({ planId: plan.id })}
                          >
                            <i className="ti ti-player-play" />
                            {c.automate}
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => onOpenPlan(plan)}
                        >
                          <i className="ti ti-edit" />
                          {t('common.edit')}
                        </Button>
                        {onDeletePlan && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            data-destructive
                            onClick={() => onDeletePlan(plan)}
                            aria-label={t('testplans.deletePlan', { title: plan.title })}
                          >
                            <i className="ti ti-trash" />
                            {t('common.delete')}
                          </Button>
                        )}
                      </ActionsMenu>
                    </div>
                    {onOpenCase && casesOpen && (
                      <ul aria-label={plan.title}>
                        {plan.plans.map((testCase, index) => (
                          <li key={index}>
                            <button
                              type="button"
                              className="flex w-full items-center gap-2 rounded py-1.5 pr-2 text-left text-sm hover:bg-surface-2"
                              style={{ paddingLeft: `${(depth + 2) * 16 + 40}px` }}
                              onClick={() => onOpenCase(plan, index)}
                              aria-label={c.openCase.replace('{title}', testCase.title)}
                              data-testid={`tree-case-${plan.id}-${index}`}
                            >
                              <span className="w-12 shrink-0 font-mono text-[11px] text-muted">
                                {`CT-${String(index + 1).padStart(2, '0')}`}
                              </span>
                              <span className="min-w-0 flex-1 truncate">{testCase.title}</span>
                              <span className="shrink-0 text-[11px] text-muted">
                                {c.steps.replace('{count}', String(testCase.steps.length))}
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    });
  return (
    <section
      className="rounded-lg border border-border bg-surface-1 p-3"
      aria-label={t('runtime.savedTestPlans')}
      data-testid="test-suite-tree"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-semibold">{t('runtime.savedTestPlans')}</span>
        <div className="flex items-center gap-1">
          {onImport && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isLoading}
              onClick={onImport}
              data-testid="btn-import-from-provider"
            >
              <i className="ti ti-cloud-download" />
              {c.importFromProvider}
            </Button>
          )}
          {onCreate && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={isLoading || isCreating}
              onClick={() => setEditing({ name: '' })}
            >
              <i className="ti ti-folder-plus" />
              {t('testplans.newSuite')}
            </Button>
          )}
        </div>
      </div>
      {isLoading ? (
        <div
          className="space-y-2 py-2"
          role="status"
          aria-label={t('common.loading')}
          data-testid="test-suites-loading-skeleton"
        >
          <SkeletonListItem />
          <SkeletonListItem />
          <SkeletonListItem />
        </div>
      ) : (
        suites.length === 0 &&
        plans.length === 0 && (
          <p className="p-6 text-center text-sm text-muted">{t('runtime.noSavedTestPlan')}</p>
        )
      )}
      {renderBranch(undefined, 0)}
      {editing && (
        <div className="mt-2 flex gap-2">
          <Input
            autoFocus
            value={editing.name}
            disabled={isCreating}
            aria-label={t('runtime.savedTestPlans')}
            onChange={(event) => setEditing({ ...editing, name: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save();
            }}
          />
          <Button
            type="button"
            size="sm"
            onClick={() => void save()}
            disabled={isCreating}
            isLoading={isCreating}
          >
            {t('common.confirm')}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
            {t('common.cancel')}
          </Button>
        </div>
      )}
    </section>
  );
}
