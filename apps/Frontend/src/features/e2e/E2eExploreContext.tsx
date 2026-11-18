import { useCallback } from 'react';
import type { ApiClient } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import { FieldLabel } from '../../components/ui/help-tooltip.js';
import type { MultiSelectOption } from '../../components/ui/multi-select.js';
import { RemoteMultiSelect } from '../../components/ui/remote-multi-select.js';
import type { E2eExplorationContextKind } from './e2e-types.js';

/** What the user picked to give the agent as context, by kind. */
export type ExploreContextSelection = Readonly<
  Record<E2eExplorationContextKind, readonly string[]>
>;

export const NO_CONTEXT: ExploreContextSelection = { pbi: [], brain: [], issue: [] };

export const contextCount = (selection: ExploreContextSelection): number =>
  selection.pbi.length + selection.brain.length + selection.issue.length;

/** The choices as the API takes them. */
export const contextRequests = (selection: ExploreContextSelection) =>
  (['pbi', 'issue', 'brain'] as const).flatMap((kind) =>
    selection[kind].map((id) => ({ kind, id })),
  );

type Page = { q: string; page: number; pageSize: number };

const KINDS: readonly {
  readonly kind: E2eExplorationContextKind;
  readonly label: 'e2e.contextPbis' | 'e2e.contextIssues' | 'e2e.contextBrain';
  readonly placeholder:
    'e2e.contextPbisPlaceholder' | 'e2e.contextIssuesPlaceholder' | 'e2e.contextBrainPlaceholder';
}[] = [
  { kind: 'pbi', label: 'e2e.contextPbis', placeholder: 'e2e.contextPbisPlaceholder' },
  { kind: 'issue', label: 'e2e.contextIssues', placeholder: 'e2e.contextIssuesPlaceholder' },
  { kind: 'brain', label: 'e2e.contextBrain', placeholder: 'e2e.contextBrainPlaceholder' },
];

/** The names of what was picked, kept while the picker is closed so its chips stay readable. */
const NAMES: Readonly<Record<E2eExplorationContextKind, Map<string, MultiSelectOption>>> = {
  pbi: new Map(),
  issue: new Map(),
  brain: new Map(),
};

/**
 * The PBIs, issues and Brain documents the agent reads before it explores: the requirements and
 * rules it has to walk through. Each list is paged and searched by the API: it loads as the list
 * is scrolled or something is typed, never whole. One that fails to load says so and the others
 * still work.
 */
export function E2eExploreContext({
  apiClient,
  value,
  onChange,
  hint,
  columns = false,
}: {
  readonly apiClient: ApiClient;
  readonly value: ExploreContextSelection;
  readonly onChange: (value: ExploreContextSelection) => void;
  /** An explanation above the lists; without it the lists stand alone. */
  readonly hint?: string;
  /** Lays the three lists side by side on wide screens instead of one under the other. */
  readonly columns?: boolean;
}) {
  const { t } = useI18n();
  const fetchPbis = useCallback(
    async (request: Page, signal: AbortSignal) => {
      const { items, total } = await apiClient.searchPbiItems(request, signal);
      return {
        total,
        items: items.map((item): MultiSelectOption => ({
          value: item.id,
          label: item.title,
          description: [item.links[0]?.externalId && `#${item.links[0].externalId}`, item.status]
            .filter(Boolean)
            .join(' · '),
        })),
      };
    },
    [apiClient],
  );
  const fetchIssues = useCallback(
    async (request: Page, signal: AbortSignal) => {
      const { issues, total } = await apiClient.searchIssues(request, signal);
      return {
        total,
        items: issues.map((issue): MultiSelectOption => ({
          value: issue.id,
          label: `#${issue.number} · ${issue.title}`,
          description: issue.status,
        })),
      };
    },
    [apiClient],
  );
  const fetchBrain = useCallback(
    async (request: Page, signal: AbortSignal) => {
      const { documents, total } = await apiClient.searchKnowledgeDocuments(request, signal);
      return {
        total,
        items: documents.map((document): MultiSelectOption => ({
          value: document.id,
          label: document.title,
          ...(document.provider ? { description: document.provider } : {}),
        })),
      };
    },
    [apiClient],
  );
  const fetchers = { pbi: fetchPbis, issue: fetchIssues, brain: fetchBrain };

  return (
    <div className="flex flex-col gap-4" data-testid="e2e-explore-context">
      {hint && <p className="text-sm text-[var(--text-secondary)]">{hint}</p>}
      <div className={columns ? 'grid gap-4 lg:grid-cols-3' : 'flex flex-col gap-4'}>
        {KINDS.map(({ kind, label, placeholder }) => {
          const id = `explore-context-${kind}`;
          return (
            <div key={kind} className="flex min-w-0 flex-col gap-1.5">
              <FieldLabel htmlFor={id}>{t(label)}</FieldLabel>
              <RemoteMultiSelect
                id={id}
                label={t(label)}
                values={value[kind]}
                onChange={(ids) => onChange({ ...value, [kind]: ids })}
                fetchPage={fetchers[kind]}
                toOption={(option: MultiSelectOption) => option}
                known={NAMES[kind]}
                placeholder={t(placeholder)}
                emptyMessage={t('e2e.contextEmpty')}
                errorMessage={t('e2e.contextLoadFailed')}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
