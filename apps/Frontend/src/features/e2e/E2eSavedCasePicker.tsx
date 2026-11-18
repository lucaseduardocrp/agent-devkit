import { useEffect, useMemo, useState } from 'react';
import type { ApiClient, SavedTestPlanDto, TestSuiteDto } from '../../lib/api-client.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import {
  SearchableSelect,
  type SearchableSelectOption,
} from '../../components/ui/searchable-select.js';
import { Skeleton, SkeletonInput } from '../../components/ui/skeleton.js';

const SELECT_PAGE_SIZE = 25;

/**
 * Test cases saved in ADK picked for a run; empty strings mean "not chosen". The suite stays
 * set when a Test Plan of it is chosen, but the Test Plan is what runs.
 */
export interface SavedCaseSelection {
  readonly suiteId: string;
  readonly planId: string;
  /** Null means every case of the suite or Test Plan. */
  readonly caseIds: readonly string[] | null;
}

export const EMPTY_SAVED_SELECTION: SavedCaseSelection = { suiteId: '', planId: '', caseIds: null };

interface SavedCase {
  readonly planId: string;
  readonly caseId: string;
  readonly title: string;
  readonly planTitle: string;
}
function descendants(suites: readonly TestSuiteDto[], rootId: string): Set<string> {
  const ids = new Set([rootId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const suite of suites)
      if (suite.parentId && ids.has(suite.parentId) && !ids.has(suite.id)) {
        ids.add(suite.id);
        grew = true;
      }
  }
  return ids;
}

/** Suites in tree order: each one right after its parent. */
function inTreeOrder(suites: readonly TestSuiteDto[]) {
  const ordered: TestSuiteDto[] = [];
  const visit = (parentId: string | undefined) => {
    for (const suite of suites.filter((item) => item.parentId === parentId)) {
      ordered.push(suite);
      visit(suite.id);
    }
  };
  visit(undefined);
  return ordered;
}

/**
 * Picks test cases already saved in ADK (written there or imported from a platform): a suite
 * with its child suites, or one of its Test Plans, and optionally only some cases.
 */
export function E2eSavedCasePicker({
  apiClient,
  value,
  invalid = false,
  single = false,
  onPickCase,
  onChange,
}: {
  readonly apiClient: ApiClient;
  readonly value: SavedCaseSelection;
  readonly invalid?: boolean;
  /** Picks exactly one case instead of a set of them. */
  readonly single?: boolean;
  /** With `single`: the Test Plan and case just picked (the plan is not part of the selection). */
  readonly onPickCase?: (pick: { readonly planId: string; readonly caseId: string }) => void;
  readonly onChange: (value: SavedCaseSelection) => void;
}) {
  const { messages } = useI18n();
  const c = messages.e2eSavedCases;
  const [suites, setSuites] = useState<readonly TestSuiteDto[] | null>(null);
  const [plans, setPlans] = useState<readonly SavedTestPlanDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([apiClient.getTestSuites(), apiClient.getAllSavedTestPlans()]).then(
      ([loadedSuites, loadedPlans]) => {
        if (!active) return;
        setSuites(loadedSuites);
        setPlans(loadedPlans);
      },
      (cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [apiClient]);

  // A Test Plan chosen directly (e.g. from Test Plans) selects its suite as well.
  const suiteId = value.suiteId || plans?.find((plan) => plan.id === value.planId)?.suiteId || '';
  const suitePlans = useMemo(() => {
    if (!suites || !plans || !suiteId) return [];
    const ids = descendants(suites, suiteId);
    return plans.filter((plan) => plan.suiteId && ids.has(plan.suiteId));
  }, [suites, plans, suiteId]);
  const suiteOptions = useMemo<SearchableSelectOption[]>(
    // All at the same level: the Test Plans are not shown as a tree.
    () => inTreeOrder(suites ?? []).map((suite) => ({ value: suite.id, label: suite.name })),
    [suites],
  );
  const planOptions = useMemo<SearchableSelectOption[]>(
    () => suitePlans.map((plan) => ({ value: plan.id, label: plan.title })),
    [suitePlans],
  );
  const cases: SavedCase[] = (
    value.planId ? suitePlans.filter((plan) => plan.id === value.planId) : suitePlans
  ).flatMap((plan) =>
    plan.plans.flatMap((testCase) => {
      const caseId = testCase.metadata?.['caseId'];
      return typeof caseId === 'string'
        ? [{ planId: plan.id, caseId, title: testCase.title, planTitle: plan.title }]
        : [];
    }),
  );
  // A single pick has no "every case" default: nothing is chosen until one is.
  const selected = new Set(value.caseIds ?? (single ? [] : cases.map((item) => item.caseId)));
  const select = (next: Set<string>) =>
    onChange({
      ...value,
      suiteId,
      caseIds: !single && next.size === cases.length ? null : [...next],
    });

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!suites || !plans)
    return (
      <div
        className="flex flex-col gap-3"
        role="status"
        aria-label={c.loading}
        data-testid="e2e-saved-case-picker-loading"
      >
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-3 w-16" />
          <SkeletonInput className="h-[48px]" />
        </div>
        <Skeleton className="h-3 w-2/3" />
      </div>
    );
  if (!plans.length) return <p className="text-sm text-[var(--text-muted)]">{c.nothingSaved}</p>;

  return (
    <div className="flex flex-col gap-3" data-testid="e2e-saved-case-picker">
      <div className="flex flex-col gap-3">
        <div className="flex min-w-0 flex-col gap-1.5 text-sm text-[var(--text-secondary)]">
          {c.suite}
          <SearchableSelect
            label={c.suite}
            value={suiteId}
            options={suiteOptions}
            placeholder={c.anySuite}
            emptyMessage={c.noMatches}
            pageSize={SELECT_PAGE_SIZE}
            onChange={(next) => onChange({ suiteId: next, planId: '', caseIds: null })}
          />
        </div>
        {suiteId && (
          <div className="flex min-w-0 flex-col gap-1.5 text-sm text-[var(--text-secondary)]">
            {c.plan}
            <SearchableSelect
              label={c.plan}
              value={value.planId}
              options={planOptions}
              placeholder={c.allPlans}
              emptyMessage={c.noMatches}
              pageSize={SELECT_PAGE_SIZE}
              onChange={(next) => onChange({ suiteId, planId: next, caseIds: null })}
            />
          </div>
        )}
      </div>
      {suiteId &&
        (cases.length === 0 ? (
          <p className="text-sm text-[var(--text-muted)]">{c.empty}</p>
        ) : (
          <div
            className={cn(
              'overflow-hidden rounded-md border border-[var(--border)]',
              invalid && 'border-red-500/60',
            )}
          >
            {!single && (
              <label className="flex cursor-pointer items-center gap-3 border-b border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm text-[var(--text-secondary)]">
                <input
                  type="checkbox"
                  checked={selected.size === cases.length}
                  onChange={() =>
                    select(
                      selected.size === cases.length
                        ? new Set()
                        : new Set(cases.map((item) => item.caseId)),
                    )
                  }
                />
                <span className="flex-1">
                  {c.allCases.replace('{count}', String(cases.length))}
                </span>
                <span className="text-xs text-[var(--text-muted)]">
                  {c.selected
                    .replace('{count}', String(selected.size))
                    .replace('{total}', String(cases.length))}
                </span>
              </label>
            )}
            <ul className="max-h-64 overflow-y-auto">
              {cases.map((item) => (
                <li key={item.caseId}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-[var(--surface-2)]">
                    <input
                      type={single ? 'radio' : 'checkbox'}
                      name={single ? 'e2e-saved-case' : undefined}
                      checked={selected.has(item.caseId)}
                      onChange={() => {
                        const next = new Set(single ? [] : selected);
                        if (selected.has(item.caseId) && !single) next.delete(item.caseId);
                        else next.add(item.caseId);
                        select(next);
                        onPickCase?.({ planId: item.planId, caseId: item.caseId });
                      }}
                    />
                    <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]">
                      {item.title}
                    </span>
                    <span className="shrink-0 truncate text-xs text-[var(--text-muted)]">
                      {item.planTitle}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ))}
      {!single && <p className="text-xs text-[var(--text-muted)]">{c.hint}</p>}
    </div>
  );
}

/** How many cases a selection runs; zero means it cannot be submitted yet. */
export function savedSelectionReady(value: SavedCaseSelection): boolean {
  return (
    Boolean(value.suiteId || value.planId) && (value.caseIds === null || value.caseIds.length > 0)
  );
}
