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
/** Lowercase and accent-free, so "avaliacao" finds "Avaliação". */
const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase();

/** What a search leaves in the tree: the suites and plans to show, and the cases that matched. */
interface TreeMatches {
  readonly suites: ReadonlySet<string>;
  readonly plans: ReadonlySet<string>;
  /** Indexes of the cases whose title matched, per plan. */
  readonly cases: ReadonlyMap<string, readonly number[]>;
}

/**
 * A suite stays when its name matches (then everything inside it stays too), or when a plan, a
 * case or a suite below it matches. A plan stays when its title or one of its cases matches.
 */
function searchTree(
  needle: string,
  roots: readonly TestSuiteDto[],
  byParent: ReadonlyMap<string | undefined, readonly TestSuiteDto[]>,
  plansBySuite: ReadonlyMap<string | undefined, readonly SavedTestPlanDto[]>,
): TreeMatches {
  const suites = new Set<string>();
  const plans = new Set<string>();
  const cases = new Map<string, readonly number[]>();
  const visit = (suite: TestSuiteDto, inherited: boolean): boolean => {
    const all = inherited || fold(suite.name).includes(needle);
    let any = false;
    for (const plan of plansBySuite.get(suite.id) ?? []) {
      const hits: number[] = [];
      plan.plans.forEach((testCase, index) => {
        if (fold(testCase.title).includes(needle)) hits.push(index);
      });
      if (all || hits.length || fold(plan.title).includes(needle)) {
        plans.add(plan.id);
        cases.set(plan.id, hits);
        any = true;
      }
    }
    for (const child of byParent.get(suite.id) ?? []) if (visit(child, all)) any = true;
    if (all || any) suites.add(suite.id);
    return all || any;
  };
  for (const root of roots) visit(root, false);
  return { suites, plans, cases };
}

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
  /** Total of saved Test Plans, shown as a badge next to the card title. */
  readonly totalCount?: number;
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
  totalCount,
  requestCreate = false,
  onCreateRequestHandled,
}: TestSuiteTreeProps) {
  const { t, formatDate, messages } = useI18n();
  const c = messages.testSuiteTree;
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [openPlans, setOpenPlans] = useState<ReadonlySet<string>>(() => new Set());
  const [editing, setEditing] = useState<{ id?: string; parentId?: string; name: string } | null>(
    null,
  );
  const [query, setQuery] = useState('');
  const byParent = useMemo(() => {
    const value = new Map<string | undefined, TestSuiteDto[]>();
    for (const suite of suites)
      value.set(suite.parentId, [...(value.get(suite.parentId) ?? []), suite]);
    return value;
  }, [suites]);
  const plansBySuite = useMemo(() => {
    const value = new Map<string | undefined, SavedTestPlanDto[]>();
    for (const plan of plans)
      value.set(plan.suiteId ?? undefined, [...(value.get(plan.suiteId ?? undefined) ?? []), plan]);
    return value;
  }, [plans]);
  const needle = fold(query.trim());
  const matches = useMemo(
    () =>
      needle ? searchTree(needle, byParent.get(undefined) ?? [], byParent, plansBySuite) : null,
    [needle, byParent, plansBySuite],
  );
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
      if (matches && !matches.suites.has(suite.id)) return null;
      const allPlans = plansBySuite.get(suite.id) ?? [];
      const suitePlans = matches ? allPlans.filter((plan) => matches.plans.has(plan.id)) : allPlans;
      // A search opens every branch that holds a result.
      const open = Boolean(matches) || expanded.has(suite.id);
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
            <span className="mr-1 text-xs text-muted">{allPlans.length}</span>
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
                const hits = matches?.cases.get(plan.id) ?? [];
                const casesOpen = openPlans.has(plan.id) || hits.length > 0;
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
                        {plan.plans.map((testCase, index) =>
                          // Searching a case lists the cases that matched, not the whole plan.
                          hits.length && !hits.includes(index) ? null : (
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
                          ),
                        )}
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
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold">{t('runtime.savedTestPlans')}</span>
          {totalCount !== undefined && (
            <span
              className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs text-[var(--text-muted)]"
              data-testid="test-suite-tree-count"
            >
              {totalCount}
            </span>
          )}
        </div>
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
      {!isLoading && (suites.length > 0 || plans.length > 0) && (
        <div className="mb-2 flex items-center gap-2">
          <Input
            type="search"
            value={query}
            aria-label={c.searchLabel}
            placeholder={c.searchPlaceholder}
            leftIcon={<i className="ti ti-search" aria-hidden="true" />}
            data-testid="test-suite-tree-search"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('');
            }}
          />
          {query && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={c.clearSearch}
              onClick={() => setQuery('')}
            >
              <i className="ti ti-x" aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
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
      {matches && matches.suites.size === 0 && !isLoading && (
        <p className="p-6 text-center text-sm text-muted" role="status">
          {c.noResults.replace('{query}', query.trim())}
        </p>
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
