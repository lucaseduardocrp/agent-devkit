import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { ConfirmationDialog } from '../../components/ui/confirmation-dialog.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { SearchableSelect } from '../../components/ui/searchable-select.js';
import { ApiClient } from '../../lib/api-client.js';
import { useI18n } from '../../lib/i18n/index.js';
import { cn } from '../../lib/utils.js';
import {
  flattenItems,
  isActiveRun,
  newRequest,
  type ApiCollection,
  type ApiCollectionSummary,
  type ApiEnvironment,
  type ApiFolder,
  type ApiMockValue,
  type ApiRequestSpec,
  type ApiRun,
  type ApiRunTarget,
  type CollectionRunResult,
  type ExportFormat,
} from './api-test-types.js';
import { GenerateDialog } from './ApiTestShared.js';
import { IntegrationTestsSkeleton } from './ApiTestSkeletons.js';
import { VariablesContext, variableSuggestions } from './variables-context.js';
import { EnvironmentsPane } from './integration/EnvironmentsPane.js';
import { downloadBlob } from './api-test-ui.js';
import { CollectionRunner } from './integration/CollectionRunner.js';
import { CollectionSettingsPane } from './integration/CollectionSettingsPane.js';
import { CollectionsSidebar, type SidebarActions } from './integration/CollectionsSidebar.js';
import {
  HISTORY_LIMIT,
  addItem,
  cloneItem,
  findRequest,
  insertAfter,
  mapItems,
  readLayout,
  removeItem,
  requestIds,
  tabCollection,
  tabKey,
  writeLayout,
  type PaneLayout,
  type PendingSend,
  type ResponseEntry,
  type WorkbenchTab,
} from './integration/integration-model.js';
import { EmptyPane, MethodLabel, NameDialog } from './integration/integration-parts.js';
import { RequestPane, UrlBar } from './integration/RequestPane.js';
import { ResponsePane } from './integration/ResponsePane.js';

const defaultApiClient = new ApiClient();

export interface IntegrationTestsViewProps {
  readonly apiClient?: ApiClient;
  readonly isReadOnly?: boolean;
}

interface NamePrompt {
  readonly title: string;
  readonly initial: string;
  readonly confirmLabel: string;
  readonly submit: (name: string) => void;
}

interface ConfirmPrompt {
  readonly title: string;
  readonly description: string;
  readonly confirm: () => Promise<void> | void;
}

/** Request and response side by side, or one over the other; the divider is dragged to resize. */
function SplitPane({
  layout,
  ratio,
  onRatio,
  first,
  second,
}: {
  readonly layout: PaneLayout;
  readonly ratio: number;
  readonly onRatio: (ratio: number) => void;
  readonly first: React.ReactNode;
  readonly second: React.ReactNode;
}): React.JSX.Element {
  const { t } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const horizontal = layout === 'horizontal';
  const clamp = (value: number) => Math.min(0.8, Math.max(0.2, value));

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      const rect = container.current?.getBoundingClientRect();
      if (!rect) return;
      onRatio(
        clamp(
          horizontal
            ? (event.clientX - rect.left) / rect.width
            : (event.clientY - rect.top) / rect.height,
        ),
      );
    };
    const stop = () => setDragging(false);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [dragging, horizontal, onRatio]);

  return (
    <div ref={container} className={cn('flex min-h-0 flex-1', !horizontal && 'flex-col')}>
      <div
        className="min-h-0 min-w-0 shrink-0 overflow-hidden"
        style={{ flexBasis: `${ratio * 100}%` }}
      >
        {first}
      </div>
      <div
        role="separator"
        tabIndex={0}
        aria-label={t('apiTests.ui.resizePanes')}
        aria-orientation={horizontal ? 'vertical' : 'horizontal'}
        aria-valuenow={Math.round(ratio * 100)}
        aria-valuemin={20}
        aria-valuemax={80}
        title={t('apiTests.ui.resizeHint')}
        className={cn(
          'shrink-0 touch-none bg-[var(--border)] transition-colors hover:bg-[var(--fill-accent)] focus-visible:bg-[var(--fill-accent)] focus-visible:outline-none',
          horizontal ? 'w-px cursor-col-resize px-px' : 'h-px cursor-row-resize py-px',
          dragging && 'bg-[var(--fill-accent)]',
        )}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          setDragging(true);
        }}
        onDoubleClick={() => onRatio(0.5)}
        onKeyDown={(event) => {
          const step = { ArrowLeft: -0.05, ArrowUp: -0.05, ArrowRight: 0.05, ArrowDown: 0.05 }[
            event.key
          ];
          if (step === undefined) return;
          event.preventDefault();
          onRatio(clamp(ratio + step));
        }}
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{second}</div>
    </div>
  );
}

export function IntegrationTestsView({
  apiClient = defaultApiClient,
  isReadOnly = false,
}: IntegrationTestsViewProps): React.JSX.Element {
  const { t } = useI18n();
  const [summaries, setSummaries] = useState<ApiCollectionSummary[]>([]);
  const [environments, setEnvironments] = useState<ApiEnvironment[]>([]);
  const [loaded, setLoaded] = useState<Record<string, ApiCollection>>({});
  // Per collection, the requests edited since the last save (the collection id stands for
  // changes to the collection itself: name, variables, auth, tree).
  const [dirty, setDirty] = useState<Record<string, ReadonlySet<string>>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [tabs, setTabs] = useState<WorkbenchTab[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [environmentId, setEnvironmentId] = useState('');
  const [target, setTarget] = useState<ApiRunTarget>('remote');
  const [history, setHistory] = useState<Record<string, ResponseEntry[]>>({});
  const [pending, setPending] = useState<Record<string, PendingSend>>({});
  const [runs, setRuns] = useState<Record<string, ApiRun<CollectionRunResult>>>({});
  const [layout, setLayout] = useState<PaneLayout>(readLayout);
  const [ratio, setRatio] = useState(0.5);
  const [showGenerate, setShowGenerate] = useState(false);
  const [naming, setNaming] = useState<NamePrompt | null>(null);
  const [confirming, setConfirming] = useState<ConfirmPrompt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // True until the collections are listed and the first one is open.
  const [loading, setLoading] = useState(true);
  // The mock values requests can use; they load on the side and the editor works without them.
  const [mocks, setMocks] = useState<ApiMockValue[] | null>(null);
  const [mocksFailed, setMocksFailed] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));

  // ---------- loading ----------

  const loadLists = useCallback(async () => {
    try {
      const [list, envs] = await Promise.all([
        apiClient.listApiCollections(),
        apiClient.listApiEnvironments(),
      ]);
      setSummaries(list);
      setEnvironments(envs);
      return list;
    } catch (err) {
      fail(err);
      return [];
    }
  }, [apiClient]);

  const loadCollection = useCallback(
    async (id: string, force = false): Promise<ApiCollection | null> => {
      if (!force && loadedRef.current[id]) return loadedRef.current[id];
      try {
        const collection = await apiClient.getApiCollection(id);
        setLoaded((all) => ({ ...all, [id]: collection }));
        return collection;
      } catch (err) {
        fail(err);
        return null;
      }
    },
    [apiClient],
  );

  const openTab = useCallback((tab: WorkbenchTab) => {
    const key = tabKey(tab);
    setTabs((current) =>
      current.some((item) => tabKey(item) === key) ? current : [...current, tab],
    );
    setActiveKey(key);
  }, []);

  /** Shows a collection in the sidebar and, when asked, opens its first request. */
  const reveal = useCallback(
    async (id: string, openFirst: boolean) => {
      const collection = await loadCollection(id, true);
      setExpanded((current) => new Set(current).add(id));
      const first = collection ? flattenItems(collection.items)[0]?.request.id : undefined;
      if (openFirst && first) openTab({ kind: 'request', collectionId: id, requestId: first });
    },
    [loadCollection, openTab],
  );

  const loadMocks = useCallback(() => {
    setMocksFailed(false);
    // Promise.resolve first: a client without the call fails like a server without the route.
    return Promise.resolve()
      .then(() => apiClient.listApiMockValues())
      .then(setMocks)
      .catch(() => setMocksFailed(true));
  }, [apiClient]);

  useEffect(() => {
    void loadMocks();
  }, [loadMocks]);

  useEffect(() => {
    void loadLists()
      .then((list) => (list[0] ? reveal(list[0].id, true) : undefined))
      .finally(() => setLoading(false));
    // Only on mount: later reloads keep what is on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- editing and saving ----------

  const edit = useCallback(
    (
      collectionId: string,
      change: (collection: ApiCollection) => ApiCollection,
      dirtyId: string,
    ) => {
      setLoaded((all) =>
        all[collectionId] ? { ...all, [collectionId]: change(all[collectionId]) } : all,
      );
      setDirty((all) => ({ ...all, [collectionId]: new Set(all[collectionId]).add(dirtyId) }));
    },
    [],
  );

  const save = useCallback(
    async (collectionId: string): Promise<ApiCollection | null> => {
      const collection = loadedRef.current[collectionId];
      if (!collection) return null;
      try {
        const saved = await apiClient.saveApiCollection(collection, collection.id);
        setLoaded((all) => ({ ...all, [collectionId]: saved }));
        setDirty((all) => ({ ...all, [collectionId]: new Set() }));
        void loadLists();
        return saved;
      } catch (err) {
        fail(err);
        return null;
      }
    },
    [apiClient, loadLists],
  );

  /** Runs read the saved collection, so pending edits are saved first. */
  const saveIfDirty = useCallback(
    async (collectionId: string) =>
      dirtyRef.current[collectionId]?.size
        ? save(collectionId)
        : (loadedRef.current[collectionId] ?? null),
    [save],
  );

  // ---------- runs ----------

  const follow = useCallback(
    async (run: ApiRun, onUpdate: (run: ApiRun<CollectionRunResult>) => void) => {
      let current = run as ApiRun<CollectionRunResult>;
      onUpdate(current);
      while (isActiveRun(current)) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_000));
        try {
          current = (await apiClient.getApiRun(
            'integration',
            run.id,
          )) as ApiRun<CollectionRunResult>;
          onUpdate(current);
        } catch {
          // Keep polling: the API may be restarting.
        }
      }
      return current;
    },
    [apiClient],
  );

  const remember = (entries: ResponseEntry[], requestId: string) =>
    setHistory((all) => ({
      ...all,
      [requestId]: [...entries, ...(all[requestId] ?? [])].slice(0, HISTORY_LIMIT),
    }));

  const send = useCallback(
    async (collectionId: string, requestId: string) => {
      if (isReadOnly || pending[requestId]) return;
      setError(null);
      const saved = await saveIfDirty(collectionId);
      if (!saved) return;
      try {
        const run = await apiClient.startIntegrationRun({
          collectionId,
          environmentId: environmentId || null,
          itemIds: [requestId],
          target,
          bail: false,
        });
        const startedAt = Date.now();
        const done = await follow(run, (current) =>
          setPending((all) => ({
            ...all,
            [requestId]: { runId: current.id, startedAt, status: current.status },
          })),
        );
        setPending(({ [requestId]: _finished, ...rest }) => rest);
        const result = done.result?.results?.find((item) => item.requestId === requestId) ?? null;
        remember(
          [
            {
              runId: done.id,
              at: Date.now(),
              result,
              error: result ? null : (done.error ?? t(`apiTests.status.${done.status}`)),
            },
          ],
          requestId,
        );
      } catch (err) {
        setPending(({ [requestId]: _failed, ...rest }) => rest);
        fail(err);
      }
    },

    [apiClient, environmentId, follow, isReadOnly, pending, saveIfDirty, t, target],
  );

  const cancelSend = (requestId: string) => {
    const run = pending[requestId];
    if (run) void apiClient.cancelApiRun('integration', run.runId).catch(fail);
  };

  const runCollection = async (
    collectionId: string,
    options: { itemIds: string[]; bail: boolean },
  ) => {
    if (isReadOnly) return;
    setError(null);
    openTab({ kind: 'runner', collectionId });
    const saved = await saveIfDirty(collectionId);
    if (!saved) return;
    try {
      const run = await apiClient.startIntegrationRun({
        collectionId,
        environmentId: environmentId || null,
        itemIds: options.itemIds,
        target,
        bail: options.bail,
      });
      const done = await follow(run, (current) =>
        setRuns((all) => ({ ...all, [collectionId]: current })),
      );
      // Each request of the run also gets the response in its own tab.
      for (const result of done.result?.results ?? [])
        remember([{ runId: done.id, at: Date.now(), result, error: null }], result.requestId);
    } catch (err) {
      fail(err);
    }
  };

  // ---------- tabs ----------

  const activeTab = tabs.find((tab) => tabKey(tab) === activeKey) ?? null;
  const activeCollectionId = activeTab ? tabCollection(activeTab) : null;
  const activeCollection = activeCollectionId ? (loaded[activeCollectionId] ?? null) : null;
  const activeRequest =
    activeTab?.kind === 'request' && activeCollection
      ? findRequest(activeCollection.items, activeTab.requestId)
      : null;

  const closeTabs = (keys: readonly string[]) => {
    setTabs((current) => {
      const next = current.filter((tab) => !keys.includes(tabKey(tab)));
      if (activeKey && keys.includes(activeKey)) {
        const index = current.findIndex((tab) => tabKey(tab) === activeKey);
        const neighbour = next[Math.min(index, next.length - 1)];
        setActiveKey(neighbour ? tabKey(neighbour) : null);
      }
      return next;
    });
  };

  // Tabs whose request was deleted go away.
  useEffect(() => {
    const gone = tabs.filter((tab) => {
      if (tab.kind !== 'request') return false;
      const collection = loaded[tab.collectionId];
      return collection && !findRequest(collection.items, tab.requestId);
    });
    if (gone.length) closeTabs(gone.map(tabKey));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !activeTab) return;
      if (event.key === 'Enter' && activeTab.kind === 'request') {
        event.preventDefault();
        void send(activeTab.collectionId, activeTab.requestId);
      } else if (event.key.toLowerCase() === 's') {
        const collectionId = tabCollection(activeTab);
        if (!collectionId) return;
        event.preventDefault();
        if (dirtyRef.current[collectionId]?.size) void save(collectionId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeTab, save, send]);

  const toggleLayout = () =>
    setLayout((current) => {
      const next = current === 'horizontal' ? 'vertical' : 'horizontal';
      writeLayout(next);
      return next;
    });

  // ---------- collections ----------

  const createCollection = () =>
    setNaming({
      title: t('apiTests.ui.createCollection'),
      initial: t('apiTests.newCollectionName'),
      confirmLabel: t('apiTests.ui.create'),
      submit: (name) => {
        setNaming(null);
        void apiClient
          .saveApiCollection({
            name,
            variables: [{ key: 'baseUrl', value: 'https://' }],
            auth: { type: 'none' },
            items: [newRequest(t('apiTests.newRequestName'))],
          })
          .then(async (created) => {
            await loadLists();
            await reveal(created.id, true);
          })
          .catch(fail);
      },
    });

  const importFile = async (file: File) => {
    try {
      const imported = await apiClient.importApiCollection(await file.text());
      setNotice(
        t('apiTests.imported', { name: imported.collection.name, format: imported.format }),
      );
      await loadLists();
      await reveal(imported.collection.id, true);
    } catch (err) {
      fail(err);
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const exportAs = async (collectionId: string, format: ExportFormat) => {
    try {
      await saveIfDirty(collectionId);
      const file = await apiClient.exportApiCollection(
        collectionId,
        format,
        environmentId ? [environmentId] : [],
      );
      downloadBlob(file.blob, file.fileName);
    } catch (err) {
      fail(err);
    }
  };

  const deleteCollection = (collectionId: string) => {
    const name =
      loaded[collectionId]?.name ?? summaries.find((item) => item.id === collectionId)?.name ?? '';
    setConfirming({
      title: t('apiTests.deleteCollection'),
      description: t('apiTests.deleteCollectionConfirm', { name }),
      confirm: async () => {
        await apiClient.deleteApiCollection(collectionId);
        closeTabs(tabs.filter((tab) => tabCollection(tab) === collectionId).map(tabKey));
        setLoaded(({ [collectionId]: _deleted, ...rest }) => rest);
        await loadLists();
      },
    });
  };

  /** Saved right away, on top of the stored collection, so unsaved edits stay unsaved. */
  const renameCollection = (collectionId: string) =>
    setNaming({
      title: t('apiTests.ui.renameCollection'),
      initial:
        loaded[collectionId]?.name ??
        summaries.find((item) => item.id === collectionId)?.name ??
        '',
      confirmLabel: t('apiTests.ui.rename'),
      submit: (name) => {
        setNaming(null);
        void (async () => {
          try {
            const stored = await apiClient.getApiCollection(collectionId);
            await apiClient.saveApiCollection({ ...stored, name }, collectionId);
            setLoaded((all) =>
              all[collectionId] ? { ...all, [collectionId]: { ...all[collectionId], name } } : all,
            );
            await loadLists();
          } catch (err) {
            fail(err);
          }
        })();
      },
    });

  const actions: SidebarActions = {
    onRenameCollection: renameCollection,
    onToggle: (id) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      if (summaries.some((summary) => summary.id === id)) void loadCollection(id);
    },
    onOpenRequest: (collectionId, requestId) =>
      openTab({ kind: 'request', collectionId, requestId }),
    onNewRequest: (collectionId, folderId) => {
      const request = newRequest(t('apiTests.newRequestName'));
      void loadCollection(collectionId).then((collection) => {
        if (!collection) return;
        edit(
          collectionId,
          (current) => ({ ...current, items: addItem(current.items, folderId, request) }),
          request.id,
        );
        setExpanded((current) => new Set(current).add(collectionId).add(folderId ?? collectionId));
        openTab({ kind: 'request', collectionId, requestId: request.id });
      });
    },
    onNewFolder: (collectionId, folderId) =>
      setNaming({
        title: t('apiTests.ui.newFolder'),
        initial: '',
        confirmLabel: t('apiTests.ui.create'),
        submit: (name) => {
          setNaming(null);
          const folder: ApiFolder = { id: crypto.randomUUID(), type: 'folder', name, items: [] };
          edit(
            collectionId,
            (current) => ({ ...current, items: addItem(current.items, folderId, folder) }),
            collectionId,
          );
          setExpanded((current) =>
            new Set(current)
              .add(collectionId)
              .add(folder.id)
              .add(folderId ?? collectionId),
          );
        },
      }),
    onRun: (collectionId, itemId) => {
      void loadCollection(collectionId).then(() => {
        if (itemId) void runCollection(collectionId, { itemIds: [itemId], bail: false });
        else openTab({ kind: 'runner', collectionId });
      });
    },
    onSettings: (collectionId) => {
      void loadCollection(collectionId).then(() => openTab({ kind: 'settings', collectionId }));
    },
    onRename: (collectionId, item) =>
      setNaming({
        title: t('apiTests.ui.rename'),
        initial: item.name,
        confirmLabel: t('apiTests.ui.rename'),
        submit: (name) => {
          setNaming(null);
          edit(
            collectionId,
            (current) => ({
              ...current,
              items: mapItems(current.items, item.id, (entry) => ({ ...entry, name })),
            }),
            item.type === 'request' ? item.id : collectionId,
          );
        },
      }),
    onClone: (collectionId, item) =>
      setNaming({
        title: t('apiTests.ui.clone'),
        initial: t('apiTests.ui.cloneName', { name: item.name }),
        confirmLabel: t('apiTests.ui.clone'),
        submit: (name) => {
          setNaming(null);
          const copy = cloneItem(item, name);
          edit(
            collectionId,
            (current) => ({ ...current, items: insertAfter(current.items, item.id, copy) }),
            copy.type === 'request' ? copy.id : collectionId,
          );
          if (copy.type === 'request')
            openTab({ kind: 'request', collectionId, requestId: copy.id });
        },
      }),
    onDelete: (collectionId, item) => {
      if (!item) return deleteCollection(collectionId);
      setConfirming({
        title: t('apiTests.ui.deleteItem'),
        description: t('apiTests.ui.deleteItemConfirm', { name: item.name }),
        confirm: () => {
          const removed = item.type === 'folder' ? requestIds(item.items) : [item.id];
          edit(
            collectionId,
            (current) => ({ ...current, items: removeItem(current.items, item.id) }),
            collectionId,
          );
          closeTabs(
            removed.map((requestId) => tabKey({ kind: 'request', collectionId, requestId })),
          );
        },
      });
    },
  };

  const suggestions = useMemo(
    () =>
      variableSuggestions(
        activeCollection,
        environments.find((environment) => environment.id === environmentId) ?? null,
        mocks,
      ),
    [activeCollection, environmentId, environments, mocks],
  );
  const dirtyIds = useMemo(() => new Set(Object.values(dirty).flatMap((ids) => [...ids])), [dirty]);
  const headerCollection =
    activeCollection ?? (summaries[0] ? (loaded[summaries[0].id] ?? null) : null);

  // ---------- rendering ----------

  const tabLabel = (
    tab: WorkbenchTab,
  ): { icon: React.ReactNode; label: string; dirty: boolean } | null => {
    if (tab.kind === 'environments')
      return {
        icon: <i className="ti ti-world text-sm text-[var(--text-muted)]" aria-hidden="true" />,
        label: t('apiTests.environments'),
        dirty: false,
      };
    const collection = loaded[tab.collectionId];
    if (!collection) return null;
    if (tab.kind === 'request') {
      const request = findRequest(collection.items, tab.requestId);
      return request
        ? {
            icon: <MethodLabel method={request.method} />,
            label: request.name,
            dirty: dirtyIds.has(request.id),
          }
        : null;
    }
    return {
      icon: (
        <i
          className={cn(
            'ti text-sm text-[var(--text-muted)]',
            tab.kind === 'runner' ? 'ti-run' : 'ti-settings',
          )}
          aria-hidden="true"
        />
      ),
      label: `${tab.kind === 'runner' ? t('apiTests.ui.runnerTitle') : t('apiTests.ui.settings')} · ${collection.name}`,
      dirty: tab.kind === 'settings' && Boolean(dirty[tab.collectionId]?.has(tab.collectionId)),
    };
  };

  const updateRequest = (collectionId: string, next: ApiRequestSpec) =>
    edit(
      collectionId,
      (current) => ({ ...current, items: mapItems(current.items, next.id, () => next) }),
      next.id,
    );

  const renderContent = () => {
    if (activeTab?.kind === 'environments') {
      return (
        <EnvironmentsPane
          apiClient={apiClient}
          environments={environments}
          activeId={environmentId}
          readOnly={isReadOnly}
          onChanged={loadLists}
          onActivate={setEnvironmentId}
        />
      );
    }
    if (!activeTab || !activeCollection) {
      return (
        <EmptyPane icon="ti-api !text-6xl opacity-40">
          <h2 className="text-base font-semibold text-[var(--text-primary)]">
            {t('apiTests.integrationTitle')}
          </h2>
          <p className="max-w-md">{t('apiTests.integrationSubtitle')}</p>
          {!isReadOnly && (
            <div className="mt-2 flex gap-2">
              <Button onClick={createCollection}>
                <i className="ti ti-plus" aria-hidden="true" />
                {t('apiTests.ui.createCollection')}
              </Button>
              <Button variant="secondary" onClick={() => fileInput.current?.click()}>
                <i className="ti ti-file-import" aria-hidden="true" />
                {t('apiTests.ui.importCollection')}
              </Button>
            </div>
          )}
        </EmptyPane>
      );
    }
    const collectionId = activeTab.collectionId;
    if (activeTab.kind === 'settings') {
      return (
        <CollectionSettingsPane
          collection={activeCollection}
          readOnly={isReadOnly}
          onChange={(next) => edit(collectionId, () => next, collectionId)}
          onExport={(format) => void exportAs(collectionId, format)}
          onDelete={() => deleteCollection(collectionId)}
        />
      );
    }
    if (activeTab.kind === 'runner') {
      const run = runs[collectionId] ?? null;
      return (
        <CollectionRunner
          key={collectionId}
          collection={activeCollection}
          run={run}
          target={target}
          readOnly={isReadOnly}
          onRun={(options) => void runCollection(collectionId, options)}
          onCancel={() =>
            run &&
            void apiClient
              .cancelApiRun('integration', run.id)
              .then((next) =>
                setRuns((all) => ({ ...all, [collectionId]: next as ApiRun<CollectionRunResult> })),
              )
              .catch(fail)
          }
          onReset={() => setRuns(({ [collectionId]: _reset, ...rest }) => rest)}
          onOpenRequest={(requestId) => openTab({ kind: 'request', collectionId, requestId })}
        />
      );
    }
    if (!activeRequest) return null;
    const requestId = activeRequest.id;
    return (
      <div className="flex h-full min-h-0 flex-col">
        <UrlBar
          request={activeRequest}
          collection={activeCollection}
          readOnly={isReadOnly}
          dirty={dirtyIds.has(requestId) || Boolean(dirty[collectionId]?.size)}
          sending={Boolean(pending[requestId])}
          onChange={(next) => updateRequest(collectionId, next)}
          onSend={() => void send(collectionId, requestId)}
          onCancel={() => cancelSend(requestId)}
          onSave={() => void save(collectionId)}
        />
        <SplitPane
          layout={layout}
          ratio={ratio}
          onRatio={setRatio}
          first={
            <RequestPane
              key={requestId}
              request={activeRequest}
              readOnly={isReadOnly}
              mocks={mocks}
              mocksFailed={mocksFailed}
              onRetryMocks={() => void loadMocks()}
              onChange={(next) => updateRequest(collectionId, next)}
            />
          }
          second={
            <ResponsePane
              key={requestId}
              entries={history[requestId] ?? []}
              pending={pending[requestId] ?? null}
              target={target}
              layout={layout}
              onToggleLayout={toggleLayout}
              onClear={() => setHistory(({ [requestId]: _cleared, ...rest }) => rest)}
              onCancel={() => cancelSend(requestId)}
            />
          }
        />
      </div>
    );
  };

  if (loading) return <IntegrationTestsSkeleton />;

  return (
    <div
      className="-m-5 flex h-[calc(100%+2.5rem)] min-h-[560px] overflow-hidden bg-[var(--surface-0)]"
      data-testid="integration-tests-view"
    >
      <CollectionsSidebar
        summaries={summaries}
        loaded={loaded}
        expanded={expanded}
        activeRequestId={activeTab?.kind === 'request' ? activeTab.requestId : null}
        dirtyIds={dirtyIds}
        filter={filter}
        readOnly={isReadOnly}
        onFilter={setFilter}
        onNewCollection={createCollection}
        onImport={() => fileInput.current?.click()}
        onGenerate={() => setShowGenerate(true)}
        actions={actions}
      />
      <input
        ref={fileInput}
        type="file"
        accept=".json,.yaml,.yml"
        className="hidden"
        data-testid="import-input"
        onChange={(event) => event.target.files?.[0] && void importFile(event.target.files[0])}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Collection header: name, environment, where to run, runner and settings */}
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-1)] px-3">
          <i className="ti ti-box text-[var(--text-accent)]" aria-hidden="true" />
          <span className="min-w-0 truncate text-sm font-semibold text-[var(--text-primary)]">
            {headerCollection?.name ?? t('apiTests.integrationTitle')}
          </span>
          {headerCollection && !isReadOnly && (
            <IconButton
              size="sm"
              icon={<i className="ti ti-pencil text-sm" aria-hidden="true" />}
              label={t('apiTests.ui.renameCollection')}
              title={t('apiTests.ui.renameCollection')}
              onClick={() => renameCollection(headerCollection.id)}
              data-testid="rename-collection"
            />
          )}
          <span className="flex-1" />
          <div className="w-56">
            <SearchableSelect
              label={t('apiTests.environment')}
              placeholder={t('apiTests.noEnvironment')}
              emptyMessage={t('apiTests.ui.noMatches')}
              value={environmentId}
              options={[
                { value: '', label: t('apiTests.noEnvironment') },
                ...environments.map((environment) => ({
                  value: environment.id,
                  label: environment.name,
                })),
              ]}
              onChange={(id) => setEnvironmentId(id)}
              searchable={false}
              data-testid="environment-select"
            />
          </div>
          <IconButton
            variant="subtle"
            icon={<i className="ti ti-world-cog" aria-hidden="true" />}
            label={t('apiTests.ui.configureEnvironments')}
            title={t('apiTests.ui.configureEnvironments')}
            onClick={() => openTab({ kind: 'environments' })}
            data-testid="open-environments"
          />
          {headerCollection && (
            <>
              <IconButton
                variant="subtle"
                icon={<i className="ti ti-run" aria-hidden="true" />}
                label={t('apiTests.ui.runnerTitle')}
                title={t('apiTests.ui.runnerTitle')}
                onClick={() => openTab({ kind: 'runner', collectionId: headerCollection.id })}
                data-testid="open-runner"
              />
              <IconButton
                variant="subtle"
                icon={<i className="ti ti-settings" aria-hidden="true" />}
                label={t('apiTests.ui.collectionSettings')}
                title={t('apiTests.ui.collectionSettings')}
                onClick={() => openTab({ kind: 'settings', collectionId: headerCollection.id })}
                data-testid="open-settings"
              />
            </>
          )}
        </header>

        {/* Open tabs */}
        <div
          className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-[var(--border)] bg-[var(--surface-1)]"
          role="tablist"
          aria-label={t('apiTests.openRequests')}
        >
          {tabs.map((tab) => {
            const key = tabKey(tab);
            const info = tabLabel(tab);
            if (!info) return null;
            const active = key === activeKey;
            return (
              <div
                key={key}
                role="tab"
                aria-selected={active}
                className={cn(
                  'group relative flex max-w-[240px] shrink-0 items-center gap-1.5 border-r border-[var(--border)] pl-3 pr-1 text-xs',
                  active
                    ? 'bg-[var(--surface-0)] text-[var(--text-primary)] after:absolute after:inset-x-0 after:top-0 after:h-0.5 after:bg-[var(--fill-accent)]'
                    : 'text-[var(--text-muted)] hover:bg-[var(--fill-ghost-hover)] hover:text-[var(--text-secondary)]',
                )}
                onAuxClick={(event) => event.button === 1 && closeTabs([key])}
              >
                <button
                  type="button"
                  className="flex h-full min-w-0 items-center gap-1.5"
                  onClick={() => setActiveKey(key)}
                >
                  {info.icon}
                  <span className="truncate">{info.label}</span>
                </button>
                <span className="relative flex h-5 w-5 items-center justify-center">
                  {info.dirty && (
                    <span
                      className="absolute h-1.5 w-1.5 rounded-full bg-[var(--fill-warning)] group-hover:hidden"
                      aria-label={t('apiTests.ui.unsaved')}
                    />
                  )}
                  <IconButton
                    size="xs"
                    className={cn(
                      'h-5 w-5',
                      info.dirty || !active ? 'invisible group-hover:visible' : '',
                    )}
                    icon={<i className="ti ti-x text-xs" aria-hidden="true" />}
                    label={t('apiTests.ui.closeTab')}
                    onClick={() => closeTabs([key])}
                  />
                </span>
              </div>
            );
          })}
          {!isReadOnly && headerCollection && (
            <IconButton
              size="sm"
              className="my-auto ml-1 h-7 w-7"
              icon={<i className="ti ti-plus text-sm" aria-hidden="true" />}
              label={t('apiTests.ui.newRequest')}
              title={t('apiTests.ui.newRequest')}
              onClick={() => actions.onNewRequest(headerCollection.id, null)}
              data-testid="add-request"
            />
          )}
        </div>

        {(error || notice) && (
          <div
            role={error ? 'alert' : 'status'}
            className={cn(
              'flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5 text-xs',
              error
                ? 'border-[var(--bg-danger)] bg-[var(--bg-danger)] text-[var(--text-danger)]'
                : 'border-[var(--bg-success)] bg-[var(--bg-success)] text-[var(--text-success)]',
            )}
          >
            <span>{error ?? notice}</span>
            <IconButton
              size="xs"
              icon={<i className="ti ti-x" aria-hidden="true" />}
              label={t('apiTests.close')}
              onClick={() => (error ? setError(null) : setNotice(null))}
            />
          </div>
        )}

        <div className="min-h-0 flex-1">
          <VariablesContext.Provider value={suggestions}>
            {renderContent()}
          </VariablesContext.Provider>
        </div>

        {/* Status bar */}
        <footer className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] bg-[var(--surface-1)] px-3 py-1.5 text-[11px] text-[var(--text-muted)]">
          <i
            className={cn('ti text-base', target === 'local' ? 'ti-device-laptop' : 'ti-cloud')}
            aria-hidden="true"
          />
          <div className="w-72">
            <SearchableSelect
              label={t('apiTests.target')}
              placeholder={t('apiTests.target')}
              emptyMessage={t('apiTests.ui.noMatches')}
              value={target}
              options={[
                { value: 'remote', label: t('apiTests.targetRemote') },
                { value: 'local', label: t('apiTests.targetLocal') },
              ]}
              onChange={(value) => setTarget(value as ApiRunTarget)}
              searchable={false}
              placement="top"
              data-testid="run-target"
            />
          </div>
          {target === 'local' && <span className="truncate">{t('apiTests.ui.localHint')}</span>}
          <span className="ml-auto hidden sm:inline">
            Ctrl + Enter · {t('apiTests.ui.shortcutSend')}
          </span>
          <IconButton
            size="xs"
            icon={
              <i
                className={cn(
                  'ti text-sm',
                  layout === 'vertical' ? 'ti-layout-columns' : 'ti-layout-rows',
                )}
                aria-hidden="true"
              />
            }
            label={t('apiTests.ui.changeLayout')}
            title={t('apiTests.ui.changeLayout')}
            onClick={toggleLayout}
            data-testid="toggle-layout"
          />
        </footer>
      </div>

      <GenerateDialog
        open={showGenerate}
        kind="integration"
        apiClient={apiClient}
        onClose={() => setShowGenerate(false)}
        onGenerated={({ collectionId }) => {
          setShowGenerate(false);
          void loadLists().then(() => (collectionId ? reveal(collectionId, true) : undefined));
        }}
      />
      <NameDialog
        open={Boolean(naming)}
        title={naming?.title ?? ''}
        initial={naming?.initial ?? ''}
        confirmLabel={naming?.confirmLabel ?? ''}
        onSubmit={(name) => naming?.submit(name)}
        onClose={() => setNaming(null)}
      />
      <ConfirmationDialog
        open={Boolean(confirming)}
        title={confirming?.title ?? ''}
        description={confirming?.description ?? ''}
        confirmLabel={t('apiTests.delete')}
        cancelLabel={t('common.cancel')}
        destructive
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const prompt = confirming;
          setConfirming(null);
          if (prompt) void Promise.resolve(prompt.confirm()).catch(fail);
        }}
      />
    </div>
  );
}
