import React from 'react';
import { ResizableSidebar } from '../../../components/layout/ResizableSidebar.js';
import { ActionsMenu } from '../../../components/ui/actions-menu.js';
import { Button } from '../../../components/ui/button.js';
import { IconButton } from '../../../components/ui/icon-button.js';
import { Input } from '../../../components/ui/input.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { cn } from '../../../lib/utils.js';
import { TreeRowSkeleton } from '../ApiTestSkeletons.js';
import type { ApiCollection, ApiCollectionSummary, ApiItem } from '../api-test-types.js';
import { itemMatches } from './integration-model.js';
import { MethodLabel } from './integration-parts.js';

export interface SidebarActions {
  readonly onToggle: (id: string) => void;
  readonly onOpenRequest: (collectionId: string, requestId: string) => void;
  readonly onNewRequest: (collectionId: string, folderId: string | null) => void;
  readonly onNewFolder: (collectionId: string, folderId: string | null) => void;
  readonly onRun: (collectionId: string, itemId: string | null) => void;
  readonly onSettings: (collectionId: string) => void;
  readonly onRenameCollection: (collectionId: string) => void;
  readonly onRename: (collectionId: string, item: ApiItem) => void;
  readonly onClone: (collectionId: string, item: ApiItem) => void;
  readonly onDelete: (collectionId: string, item: ApiItem | null) => void;
}

const ROW = 'group flex h-8 items-center gap-1.5 pr-1 text-xs hover:bg-[var(--fill-ghost-hover)]';
/** Row menus show on hover, like Bruno, and stay reachable from the keyboard. */
const ROW_MENU =
  'opacity-0 group-hover:opacity-100 focus-within:opacity-100 [&_button[aria-haspopup]]:h-6 [&_button[aria-haspopup]]:w-6 [&_button[aria-haspopup]_i]:text-sm';

function MenuItem({
  icon,
  children,
  onClick,
  destructive,
}: {
  readonly icon: string;
  readonly children: React.ReactNode;
  readonly onClick: () => void;
  readonly destructive?: boolean;
}): React.JSX.Element {
  return (
    <Button
      variant="ghost"
      role="menuitem"
      data-destructive={destructive || undefined}
      onClick={onClick}
    >
      <i className={cn('ti', icon)} aria-hidden="true" />
      {children}
    </Button>
  );
}

function TreeRows({
  collectionId,
  items,
  depth,
  filter,
  expanded,
  activeRequestId,
  dirtyIds,
  readOnly,
  actions,
}: {
  readonly collectionId: string;
  readonly items: readonly ApiItem[];
  readonly depth: number;
  readonly filter: string;
  readonly expanded: ReadonlySet<string>;
  readonly activeRequestId: string | null;
  readonly dirtyIds: ReadonlySet<string>;
  readonly readOnly: boolean;
  readonly actions: SidebarActions;
}): React.JSX.Element {
  const { t } = useI18n();
  const indent = { paddingLeft: 12 + depth * 14 };
  return (
    <ul role="group">
      {items
        .filter((item) => itemMatches(item, filter))
        .map((item) => {
          const menu = (
            <div className={ROW_MENU}>
              <ActionsMenu portal label={t('apiTests.ui.itemActions', { name: item.name })}>
                {item.type === 'folder' && !readOnly && (
                  <>
                    <MenuItem
                      icon="ti-plus"
                      onClick={() => actions.onNewRequest(collectionId, item.id)}
                    >
                      {t('apiTests.ui.newRequest')}
                    </MenuItem>
                    <MenuItem
                      icon="ti-folder-plus"
                      onClick={() => actions.onNewFolder(collectionId, item.id)}
                    >
                      {t('apiTests.ui.newFolder')}
                    </MenuItem>
                  </>
                )}
                {!readOnly && (
                  <MenuItem
                    icon="ti-player-play"
                    onClick={() => actions.onRun(collectionId, item.id)}
                  >
                    {t('apiTests.run')}
                  </MenuItem>
                )}
                {!readOnly && (
                  <>
                    <MenuItem icon="ti-pencil" onClick={() => actions.onRename(collectionId, item)}>
                      {t('apiTests.ui.rename')}
                    </MenuItem>
                    <MenuItem icon="ti-copy" onClick={() => actions.onClone(collectionId, item)}>
                      {t('apiTests.ui.clone')}
                    </MenuItem>
                    <MenuItem
                      icon="ti-trash"
                      destructive
                      onClick={() => actions.onDelete(collectionId, item)}
                    >
                      {t('apiTests.delete')}
                    </MenuItem>
                  </>
                )}
              </ActionsMenu>
            </div>
          );
          if (item.type === 'folder') {
            const open = expanded.has(item.id) || Boolean(filter);
            return (
              <li key={item.id} role="treeitem" aria-expanded={open}>
                <div className={ROW}>
                  <button
                    type="button"
                    className="flex h-full min-w-0 flex-1 items-center gap-1.5 text-left text-[var(--text-primary)]"
                    style={indent}
                    onClick={() => actions.onToggle(item.id)}
                  >
                    <i
                      className={cn(
                        'ti text-xs text-[var(--text-muted)]',
                        open ? 'ti-chevron-down' : 'ti-chevron-right',
                      )}
                      aria-hidden="true"
                    />
                    <i
                      className={cn(
                        'ti text-sm text-[var(--text-muted)]',
                        open ? 'ti-folder-open' : 'ti-folder',
                      )}
                      aria-hidden="true"
                    />
                    <span className="truncate">{item.name}</span>
                  </button>
                  {!readOnly && menu}
                </div>
                {open && (
                  <TreeRows
                    collectionId={collectionId}
                    items={item.items}
                    depth={depth + 1}
                    filter={filter}
                    expanded={expanded}
                    activeRequestId={activeRequestId}
                    dirtyIds={dirtyIds}
                    readOnly={readOnly}
                    actions={actions}
                  />
                )}
              </li>
            );
          }
          const active = item.id === activeRequestId;
          return (
            <li key={item.id} role="treeitem" aria-selected={active}>
              <div className={cn(ROW, active && 'bg-[var(--fill-ghost-selected)]')}>
                <button
                  type="button"
                  className="flex h-full min-w-0 flex-1 items-center gap-2 text-left"
                  style={{ paddingLeft: 26 + depth * 14 }}
                  onClick={() => actions.onOpenRequest(collectionId, item.id)}
                  data-testid={`tree-request-${item.name}`}
                >
                  <MethodLabel method={item.method} className="w-8 text-right" />
                  <span
                    className={cn(
                      'truncate',
                      active ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]',
                    )}
                  >
                    {item.name}
                  </span>
                  {dirtyIds.has(item.id) && (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--fill-warning)]"
                      aria-label={t('apiTests.ui.unsaved')}
                    />
                  )}
                </button>
                {!readOnly && menu}
              </div>
            </li>
          );
        })}
    </ul>
  );
}

export function CollectionsSidebar({
  summaries,
  loaded,
  expanded,
  activeRequestId,
  dirtyIds,
  filter,
  readOnly,
  onFilter,
  onNewCollection,
  onImport,
  onGenerate,
  actions,
}: {
  readonly summaries: readonly ApiCollectionSummary[];
  readonly loaded: Readonly<Record<string, ApiCollection>>;
  readonly expanded: ReadonlySet<string>;
  readonly activeRequestId: string | null;
  readonly dirtyIds: ReadonlySet<string>;
  readonly filter: string;
  readonly readOnly: boolean;
  readonly onFilter: (filter: string) => void;
  readonly onNewCollection: () => void;
  readonly onImport: () => void;
  readonly onGenerate: () => void;
  readonly actions: SidebarActions;
}): React.JSX.Element {
  const { t } = useI18n();
  const text = filter.trim();
  return (
    <ResizableSidebar
      className="border-r border-[var(--border)] bg-[var(--surface-1)]"
      defaultWidth={280}
      minWidth={220}
      maxWidth={520}
      aria-label={t('apiTests.collections')}
      data-testid="collections-sidebar"
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-[var(--border)] pl-3 pr-1.5">
        <h2 className="flex-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]">
          {t('apiTests.collections')}
        </h2>
        {!readOnly && (
          <>
            <IconButton
              size="sm"
              icon={<i className="ti ti-plus" aria-hidden="true" />}
              label={t('apiTests.newCollection')}
              title={t('apiTests.newCollection')}
              onClick={onNewCollection}
              data-testid="new-collection"
            />
            <IconButton
              size="sm"
              icon={<i className="ti ti-file-import" aria-hidden="true" />}
              label={t('apiTests.importHint')}
              title={t('apiTests.importHint')}
              onClick={onImport}
            />
            <IconButton
              size="sm"
              icon={<i className="ti ti-sparkles" aria-hidden="true" />}
              label={t('apiTests.generateWithAi')}
              title={t('apiTests.generateWithAi')}
              onClick={onGenerate}
            />
          </>
        )}
      </div>
      <div className="shrink-0 p-2">
        <Input
          leftIcon={<i className="ti ti-search" aria-hidden="true" />}
          value={filter}
          placeholder={t('apiTests.ui.searchRequests')}
          aria-label={t('apiTests.ui.searchRequests')}
          onChange={(event) => onFilter(event.target.value)}
        />
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto pb-3"
        role="tree"
        aria-label={t('apiTests.collections')}
      >
        {summaries.map((summary) => {
          const collection = loaded[summary.id];
          const open = expanded.has(summary.id);
          if (text && collection && !collection.items.some((item) => itemMatches(item, text)))
            return null;
          return (
            <div key={summary.id} role="treeitem" aria-expanded={open}>
              <div className={ROW}>
                <button
                  type="button"
                  className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2 text-left font-medium text-[var(--text-primary)]"
                  onClick={() => actions.onToggle(summary.id)}
                  data-testid={`collection-${summary.name}`}
                >
                  <i
                    className={cn(
                      'ti text-xs text-[var(--text-muted)]',
                      open ? 'ti-chevron-down' : 'ti-chevron-right',
                    )}
                    aria-hidden="true"
                  />
                  <i className="ti ti-box text-sm text-[var(--text-accent)]" aria-hidden="true" />
                  <span className="truncate">{collection?.name ?? summary.name}</span>
                </button>
                <div className={ROW_MENU}>
                  <ActionsMenu portal label={t('apiTests.ui.itemActions', { name: summary.name })}>
                    {!readOnly && (
                      <>
                        <MenuItem
                          icon="ti-plus"
                          onClick={() => actions.onNewRequest(summary.id, null)}
                        >
                          {t('apiTests.ui.newRequest')}
                        </MenuItem>
                        <MenuItem
                          icon="ti-folder-plus"
                          onClick={() => actions.onNewFolder(summary.id, null)}
                        >
                          {t('apiTests.ui.newFolder')}
                        </MenuItem>
                        <MenuItem
                          icon="ti-player-play"
                          onClick={() => actions.onRun(summary.id, null)}
                        >
                          {t('apiTests.run')}
                        </MenuItem>
                      </>
                    )}
                    {!readOnly && (
                      <MenuItem
                        icon="ti-pencil"
                        onClick={() => actions.onRenameCollection(summary.id)}
                      >
                        {t('apiTests.ui.rename')}
                      </MenuItem>
                    )}
                    <MenuItem icon="ti-settings" onClick={() => actions.onSettings(summary.id)}>
                      {t('apiTests.ui.settings')}
                    </MenuItem>
                    {!readOnly && (
                      <MenuItem
                        icon="ti-trash"
                        destructive
                        onClick={() => actions.onDelete(summary.id, null)}
                      >
                        {t('apiTests.deleteCollection')}
                      </MenuItem>
                    )}
                  </ActionsMenu>
                </div>
              </div>
              {open && collection && (
                <>
                  <TreeRows
                    collectionId={summary.id}
                    items={collection.items}
                    depth={0}
                    filter={text}
                    expanded={expanded}
                    activeRequestId={activeRequestId}
                    dirtyIds={dirtyIds}
                    readOnly={readOnly}
                    actions={actions}
                  />
                  {!collection.items.length && (
                    <p className="py-1.5 pl-9 text-xs text-[var(--text-muted)]">
                      {t('apiTests.ui.noRequestsYet')}
                    </p>
                  )}
                </>
              )}
              {open && !collection && (
                <div role="status" aria-busy="true" aria-label={t('common.loading')}>
                  <TreeRowSkeleton depth={1} kind="request" name="w-28" />
                  <TreeRowSkeleton depth={1} kind="request" name="w-36" />
                  <TreeRowSkeleton depth={1} kind="request" name="w-20" />
                </div>
              )}
            </div>
          );
        })}
        {!summaries.length && (
          <div className="flex flex-col items-center gap-3 p-6 text-center">
            <i className="ti ti-box text-3xl text-[var(--text-muted)]" aria-hidden="true" />
            <p className="text-xs text-[var(--text-muted)]">{t('apiTests.emptyState')}</p>
            {!readOnly && (
              <div className="flex flex-col gap-2">
                <Button onClick={onNewCollection} data-testid="create-first">
                  {t('apiTests.ui.createCollection')}
                </Button>
                <Button variant="secondary" onClick={onImport}>
                  {t('apiTests.ui.importCollection')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </ResizableSidebar>
  );
}
