import { useEffect, useMemo, useState } from 'react';
import type { ApiClient, SavedTestPlanDto, TestSuiteDto } from '../../lib/api-client.js';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';
import { Select } from '../../components/ui/select.js';

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
  readonly caseId: string;
  readonly title: string;
  readonly planTitle: string;
}

const copy = {
  'pt-BR': {
    suite: 'Suíte',
    plan: 'Test Plan',
    anySuite: 'Selecione...',
    allPlans: 'Todos os Test Plans da suíte',
    choosePlan: 'Selecione...',
    allCases: 'Todos os casos ({count})',
    selected: '{count} de {total} selecionados',
    loading: 'Carregando...',
    empty: 'Nenhum caso de teste salvo aqui.',
    nothingSaved: 'Ainda não há Test Plans salvos. Crie ou importe casos em Test Plans.',
    hint: 'Casos importados de uma plataforma publicam o resultado de volta nela.',
  },
  'en-US': {
    suite: 'Suite',
    plan: 'Test Plan',
    anySuite: 'Select...',
    allPlans: 'Every Test Plan of the suite',
    choosePlan: 'Select...',
    allCases: 'All cases ({count})',
    selected: '{count} of {total} selected',
    loading: 'Loading...',
    empty: 'No saved test case here.',
    nothingSaved: 'There are no saved Test Plans yet. Create or import cases in Test Plans.',
    hint: 'Cases imported from a platform publish their results back to it.',
  },
} as const;

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

/** Suites in tree order with their depth. */
function inTreeOrder(suites: readonly TestSuiteDto[]) {
  const ordered: { suite: TestSuiteDto; depth: number }[] = [];
  const visit = (parentId: string | undefined, depth: number) => {
    for (const suite of suites.filter((item) => item.parentId === parentId)) {
      ordered.push({ suite, depth });
      visit(suite.id, depth + 1);
    }
  };
  visit(undefined, 0);
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
  onChange,
}: {
  readonly apiClient: ApiClient;
  readonly value: SavedCaseSelection;
  readonly invalid?: boolean;
  readonly onChange: (value: SavedCaseSelection) => void;
}) {
  const { locale } = useI18n();
  const c = copy[locale];
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
  const cases: SavedCase[] = (
    value.planId ? suitePlans.filter((plan) => plan.id === value.planId) : suitePlans
  ).flatMap((plan) =>
    plan.plans.flatMap((testCase) => {
      const caseId = testCase.metadata?.['caseId'];
      return typeof caseId === 'string'
        ? [{ caseId, title: testCase.title, planTitle: plan.title }]
        : [];
    }),
  );
  const selected = new Set(value.caseIds ?? cases.map((item) => item.caseId));
  const select = (next: Set<string>) =>
    onChange({
      ...value,
      suiteId,
      caseIds: next.size === cases.length ? null : [...next],
    });

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (!suites || !plans) return <p className="text-sm text-[var(--text-muted)]">{c.loading}</p>;
  if (!plans.length) return <p className="text-sm text-[var(--text-muted)]">{c.nothingSaved}</p>;

  return (
    <div className="flex flex-col gap-3" data-testid="e2e-saved-case-picker">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex min-w-0 flex-col gap-1.5 text-sm text-[var(--text-secondary)]">
          {c.suite}
          <Select
            value={suiteId}
            onChange={(event) =>
              onChange({ suiteId: event.target.value, planId: '', caseIds: null })
            }
          >
            <option value="">{c.anySuite}</option>
            {inTreeOrder(suites).map(({ suite, depth }) => (
              <option key={suite.id} value={suite.id}>
                {`${'  '.repeat(depth)}${suite.name}`}
              </option>
            ))}
          </Select>
        </label>
        {suiteId && (
          <label className="flex min-w-0 flex-col gap-1.5 text-sm text-[var(--text-secondary)]">
            {c.plan}
            <Select
              value={value.planId}
              onChange={(event) =>
                onChange({
                  suiteId,
                  planId: event.target.value,
                  caseIds: null,
                })
              }
            >
              <option value="">{c.allPlans}</option>
              {suitePlans.map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {plan.title}
                </option>
              ))}
            </Select>
          </label>
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
              <span className="flex-1">{c.allCases.replace('{count}', String(cases.length))}</span>
              <span className="text-xs text-[var(--text-muted)]">
                {c.selected
                  .replace('{count}', String(selected.size))
                  .replace('{total}', String(cases.length))}
              </span>
            </label>
            <ul className="max-h-64 overflow-y-auto">
              {cases.map((item) => (
                <li key={item.caseId}>
                  <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-[var(--surface-2)]">
                    <input
                      type="checkbox"
                      checked={selected.has(item.caseId)}
                      onChange={() => {
                        const next = new Set(selected);
                        if (next.has(item.caseId)) next.delete(item.caseId);
                        else next.add(item.caseId);
                        select(next);
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
      <p className="text-xs text-[var(--text-muted)]">{c.hint}</p>
    </div>
  );
}

/** How many cases a selection runs; zero means it cannot be submitted yet. */
export function savedSelectionReady(value: SavedCaseSelection): boolean {
  return (
    Boolean(value.suiteId || value.planId) && (value.caseIds === null || value.caseIds.length > 0)
  );
}
