import { useCallback, useEffect, useMemo, useState } from 'react';
import { Modal } from '../../components/ui/modal.js';
import { Button } from '../../components/ui/button.js';
import { Select } from '../../components/ui/select.js';
import type {
  ApiClient,
  ImportTestCasesInput,
  ImportTestCasesResultDto,
  TestSuiteDto,
} from '../../lib/api-client.js';
import type {
  TestManagementProvider,
  TestManagementProviderId,
  RemoteContainer,
  ExternalTestCase,
} from '../e2e/e2e-types.js';
import { useI18n } from '../../lib/i18n/index.js';

interface Props {
  readonly apiClient: ApiClient;
  /** Local suite the import was started from; the cases may go into it. */
  readonly suite?: TestSuiteDto | null;
  readonly onClose: () => void;
  readonly onImported: (result: ImportTestCasesResultDto) => void;
  readonly onOpenIntegrations?: () => void;
}

const copy = {
  'pt-BR': {
    title: 'Importar do provedor de testes',
    provider: 'Provedor',
    choose: 'Selecione...',
    what: 'O que importar',
    wholePlan: '{plan} inteiro, com todas as suítes',
    oneSuite: 'Uma {suite}',
    includeChildren: 'Incluir as suítes filhas',
    cases: 'Casos',
    allCases: 'Todos os casos ({count})',
    selected: '{count} de {total} selecionados',
    intoSuite: 'Dentro da suíte "{name}"',
    newSuite: 'Em uma suíte nova com o nome do {plan}',
    import: 'Importar',
    cancel: 'Cancelar',
    done: 'Concluir',
    loading: 'Carregando...',
    empty: 'Nenhum caso encontrado.',
    noProviders: 'Nenhum provedor de testes está configurado.',
    openIntegrations: 'Configurar integrações',
    result:
      '{cases} casos importados em {plans} Test Plans: {created} novos e {updated} atualizados.',
    suitesCreated: '{count} suítes criadas no ADK.',
  },
  'en-US': {
    title: 'Import from a test provider',
    provider: 'Provider',
    choose: 'Select...',
    what: 'What to import',
    wholePlan: 'The whole {plan}, with every suite',
    oneSuite: 'One {suite}',
    includeChildren: 'Include child suites',
    cases: 'Cases',
    allCases: 'All cases ({count})',
    selected: '{count} of {total} selected',
    intoSuite: 'Inside the "{name}" suite',
    newSuite: 'In a new suite named after the {plan}',
    import: 'Import',
    cancel: 'Cancel',
    done: 'Done',
    loading: 'Loading...',
    empty: 'No cases found.',
    noProviders: 'No test provider is configured.',
    openIntegrations: 'Set up integrations',
    result: '{cases} cases imported into {plans} Test Plans: {created} new and {updated} updated.',
    suitesCreated: '{count} suites created in ADK.',
  },
} as const;

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => String(values[key]));
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Suites in tree order, each with its depth, so the picker shows the hierarchy. */
function inTreeOrder(suites: readonly RemoteContainer[]) {
  const ids = new Set(suites.map((suite) => suite.id));
  const children = new Map<string | undefined, RemoteContainer[]>();
  for (const suite of suites) {
    const parent = suite.parentId && ids.has(suite.parentId) ? suite.parentId : undefined;
    children.set(parent, [...(children.get(parent) ?? []), suite]);
  }
  const ordered: { suite: RemoteContainer; depth: number }[] = [];
  const visit = (parent: string | undefined, depth: number) => {
    for (const suite of children.get(parent) ?? []) {
      ordered.push({ suite, depth });
      visit(suite.id, depth + 1);
    }
  };
  visit(undefined, 0);
  return ordered;
}

/**
 * Imports a whole plan, one suite (optionally with its children) or chosen cases from a test
 * management platform. The remote hierarchy becomes local suites and every case keeps the
 * platform's fields.
 */
export function ImportTestCasesModal({
  apiClient,
  suite,
  onClose,
  onImported,
  onOpenIntegrations,
}: Props) {
  const { locale } = useI18n();
  const c = copy[locale];
  const [providers, setProviders] = useState<readonly TestManagementProvider[] | null>(null);
  const [providerId, setProviderId] = useState<TestManagementProviderId | ''>('');
  const [plans, setPlans] = useState<readonly RemoteContainer[]>([]);
  const [planId, setPlanId] = useState('');
  const [suites, setSuites] = useState<readonly RemoteContainer[]>([]);
  const [scope, setScope] = useState<'plan' | 'suite'>('plan');
  const [suiteId, setSuiteId] = useState('');
  const [includeChildren, setIncludeChildren] = useState(true);
  const [cases, setCases] = useState<readonly ExternalTestCase[] | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [intoSuite, setIntoSuite] = useState(Boolean(suite));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportTestCasesResultDto | null>(null);

  const provider = providers?.find((item) => item.id === providerId);
  const capabilities = provider?.capabilities;
  const suiteLabel = capabilities?.suiteLabel ?? '';
  const hasSuites = Boolean(suiteLabel);
  const planLabel = capabilities?.planLabel ?? 'Test Plan';
  const tree = useMemo(() => inTreeOrder(suites), [suites]);
  // Cases are listed (and can be picked) for one suite, or for a plan without suites.
  const casesLocation = useMemo(
    () =>
      providerId && planId && (scope === 'suite' ? suiteId : !hasSuites)
        ? { planId, ...(scope === 'suite' ? { suiteId } : {}) }
        : null,
    [providerId, planId, scope, suiteId, hasSuites],
  );

  /** Runs a request for an effect; its cleanup drops answers that arrive too late. */
  const load = useCallback(<T,>(request: () => Promise<T>, apply: (value: T) => void) => {
    let active = true;
    setLoading(true);
    setError(null);
    void request()
      .then(
        (value) => {
          if (active) apply(value);
        },
        (cause: unknown) => {
          if (active) setError(message(cause));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(
    () =>
      load(
        () => apiClient.getTestManagementProviders(),
        (items) => {
          const configured = items.filter((item) => item.configured);
          setProviders(configured);
          if (configured.length === 1) setProviderId(configured[0]!.id);
        },
      ),
    [apiClient, load],
  );
  useEffect(() => {
    setPlans([]);
    setPlanId('');
    if (!providerId) return;
    return load(() => apiClient.getTestManagementPlans(providerId), setPlans);
  }, [apiClient, providerId, load]);
  useEffect(() => {
    setSuites([]);
    setSuiteId('');
    if (!providerId || !planId || !hasSuites) return;
    return load(() => apiClient.getTestManagementSuites(providerId, planId), setSuites);
  }, [apiClient, providerId, planId, hasSuites, load]);
  useEffect(() => {
    setCases(null);
    setSelected(new Set());
    if (!providerId || !casesLocation) return;
    return load(
      () => apiClient.getTestManagementCases(providerId, casesLocation),
      (items) => {
        setCases(items);
        setSelected(new Set(items.map((item) => item.caseId)));
      },
    );
  }, [apiClient, providerId, casesLocation, load]);

  const ready =
    Boolean(providerId && planId) &&
    (scope === 'plan' || Boolean(suiteId)) &&
    (!cases || selected.size > 0);

  const submit = async () => {
    setSaving(true);
    setError(null);
    const partial = cases && selected.size < cases.length;
    const input: ImportTestCasesInput = {
      // The button is enabled only once a provider and a plan are chosen.
      providerId,
      planId,
      ...(scope === 'suite' ? { suiteId, includeChildSuites: includeChildren } : {}),
      ...(suite && intoSuite ? { localSuiteId: suite.id } : {}),
      ...(partial ? { caseIds: [...selected] } : {}),
    };
    try {
      setResult(await apiClient.importTestCases(input));
    } catch (cause) {
      setError(message(cause));
    } finally {
      setSaving(false);
    }
  };

  const toggle = (caseId: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(caseId)) next.delete(caseId);
      else next.add(caseId);
      return next;
    });

  if (result) {
    const total = result.created + result.updated;
    return (
      <Modal open onClose={() => onImported(result)} labelledBy="import-test-cases-title">
        <div
          className="w-[min(92vw,560px)] space-y-4 rounded-lg border border-border bg-surface-1 p-6"
          data-testid="import-test-cases-result"
        >
          <h2 id="import-test-cases-title" className="text-lg font-semibold">
            <i className="ti ti-circle-check mr-2 text-emerald-400" aria-hidden="true" />
            {c.title}
          </h2>
          <p role="status" className="text-sm">
            {fill(c.result, {
              cases: total,
              plans: result.plans.length,
              created: result.created,
              updated: result.updated,
            })}
          </p>
          {result.suitesCreated > 0 && (
            <p className="text-sm text-muted">
              {fill(c.suitesCreated, { count: result.suitesCreated })}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="button" onClick={() => onImported(result)}>
              {c.done}
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} labelledBy="import-test-cases-title">
      <div
        className="flex max-h-[90vh] w-[min(94vw,640px)] flex-col gap-4 overflow-y-auto rounded-lg border border-border bg-surface-1 p-6"
        data-testid="import-test-cases-modal"
      >
        <div>
          <h2 id="import-test-cases-title" className="text-lg font-semibold">
            <i className="ti ti-cloud-download mr-2 text-[var(--text-accent)]" aria-hidden="true" />
            {c.title}
          </h2>
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-400">
            {error}
          </p>
        )}
        {providers && providers.length === 0 ? (
          <p className="text-sm text-amber-400">
            {c.noProviders}{' '}
            {onOpenIntegrations && (
              <Button variant="link" size="sm" className="h-auto p-0" onClick={onOpenIntegrations}>
                {c.openIntegrations}
              </Button>
            )}
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm">
              {c.provider}
              <Select
                value={providerId}
                onChange={(event) => {
                  setProviderId(event.target.value as TestManagementProviderId);
                  setScope('plan');
                }}
                containerClassName="mt-1"
              >
                <option value="">{c.choose}</option>
                {(providers ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </Select>
            </label>
            {providerId && (
              <label className="block text-sm">
                {planLabel}
                <Select
                  value={planId}
                  onChange={(event) => {
                    setPlanId(event.target.value);
                    setScope('plan');
                  }}
                  containerClassName="mt-1"
                >
                  <option value="">{c.choose}</option>
                  {plans.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </Select>
              </label>
            )}
          </div>
        )}

        {planId && hasSuites && (
          <fieldset className="space-y-2 text-sm">
            <legend className="mb-1 font-medium">{c.what}</legend>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="import-scope"
                checked={scope === 'plan'}
                onChange={() => setScope('plan')}
              />
              {fill(c.wholePlan, { plan: planLabel })}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="import-scope"
                checked={scope === 'suite'}
                onChange={() => setScope('suite')}
              />
              {fill(c.oneSuite, { suite: suiteLabel })}
            </label>
            {scope === 'suite' && (
              <div className="w-full space-y-2">
                <Select
                  className="w-full"
                  aria-label={suiteLabel}
                  value={suiteId}
                  onChange={(event) => setSuiteId(event.target.value)}
                >
                  <option value="">{c.choose}</option>
                  {tree.map(({ suite: item, depth }) => (
                    <option key={item.id} value={item.id}>
                      {`${'  '.repeat(depth)}${item.name}`}
                    </option>
                  ))}
                </Select>
                {tree.some((entry) => entry.suite.parentId === suiteId) && (
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={includeChildren}
                      onChange={(event) => setIncludeChildren(event.target.checked)}
                    />
                    {c.includeChildren}
                  </label>
                )}
              </div>
            )}
          </fieldset>
        )}

        {casesLocation &&
          (loading && !cases ? (
            <p role="status" className="text-sm text-muted">
              {c.loading}
            </p>
          ) : cases && cases.length === 0 ? (
            <p className="text-sm text-muted">{c.empty}</p>
          ) : (
            cases && (
              <div className="overflow-hidden rounded-md border border-border">
                <label className="flex items-center gap-3 border-b border-border bg-surface-2 px-3 py-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.size === cases.length}
                    onChange={() =>
                      setSelected(
                        selected.size === cases.length
                          ? new Set()
                          : new Set(cases.map((item) => item.caseId)),
                      )
                    }
                  />
                  <span className="flex-1">{fill(c.allCases, { count: cases.length })}</span>
                  <span className="text-xs text-muted">
                    {fill(c.selected, { count: selected.size, total: cases.length })}
                  </span>
                </label>
                <ul className="max-h-60 overflow-y-auto" aria-label={c.cases}>
                  {cases.map((item) => (
                    <li key={item.caseId}>
                      <label className="flex cursor-pointer items-center gap-3 px-3 py-1.5 text-sm hover:bg-surface-2">
                        <input
                          type="checkbox"
                          checked={selected.has(item.caseId)}
                          onChange={() => toggle(item.caseId)}
                        />
                        <span className="w-16 shrink-0 font-mono text-xs text-muted">
                          {item.caseId}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{item.title}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )
          ))}

        {planId && suite && (
          <div className="space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="import-destination"
                checked={intoSuite}
                onChange={() => setIntoSuite(true)}
              />
              {fill(c.intoSuite, { name: suite.name })}
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="import-destination"
                checked={!intoSuite}
                onChange={() => setIntoSuite(false)}
              />
              {fill(c.newSuite, { plan: planLabel })}
            </label>
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {c.cancel}
          </Button>
          <Button
            type="button"
            disabled={saving || !ready}
            isLoading={saving}
            onClick={() => void submit()}
            data-testid="btn-import-test-cases"
          >
            <i className="ti ti-cloud-download" aria-hidden="true" />
            {c.import}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
