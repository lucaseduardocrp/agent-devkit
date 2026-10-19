import { createPortal } from 'react-dom';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type {
  ApiClient,
  AuditEntityType,
  AuditHistoryPage,
  AuditSnapshot,
} from '../../lib/api-client.js';
import { Button } from '../../components/ui/button.js';
import { SkeletonText } from '../../components/ui/skeleton.js';
import { useI18n } from '../../lib/i18n/index.js';
import { FormattedContent } from '../../components/ui/formatted-content.js';

// Display only persisted content, without rendering HTML supplied by an author.
function content(value: AuditSnapshot): string {
  if (value === null) return '';
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return value.map(content).filter(Boolean).join('\n\n');
  return Object.entries(value)
    .filter(
      ([key]) =>
        ![
          'id',
          'workspaceId',
          'createdAt',
          'updatedAt',
          'templateSectionId',
          'agentId',
          'templateId',
        ].includes(key),
    )
    .map(([key, item]) =>
      [
        'title',
        'name',
        'content',
        'sections',
        'plans',
        'testCases',
        'cases',
        'steps',
        'messages',
      ].includes(key)
        ? content(item)
        : `${key}: ${content(item)}`,
    )
    .join('\n\n');
}

function title(value: AuditSnapshot): string {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of ['title', 'name', 'content']) {
      const label = value[key];
      if (typeof label === 'string' && label.trim())
        return label.split('\n')[0]!.replace(/^#+\s*/, '');
    }
  }
  return content(value).split('\n')[0]!;
}

function isRichText(value: string): boolean {
  return (
    /<\/?(?:b|strong|i|em|u|code|br)\b/i.test(value) ||
    /(?:^|\n)\s*(?:#{1,6}\s|[-*]\s|\d+\.\s)|\*\*[^*]+\*\*|`[^`]+`/.test(value)
  );
}

export type AuditValueResolver = (key: string, value: AuditSnapshot) => string | undefined;

function renderSnapshot(
  value: AuditSnapshot,
  keyPrefix: string,
  labelForKey: (key: string) => string,
  resolveValue?: AuditValueResolver,
): ReactNode {
  if (value === null) return null;
  if (typeof value !== 'object') {
    const text = String(value);
    const formattedText = text
      .replace(/^\s*#{1,6}\s+[^\r\n]+\r?\n?/, '')
      .replace(/^\s*<b>\s*#{1,6}\s+.*?<\/b>\s*(?:<br\s*\/?>)?/i, '');
    return isRichText(text) ? (
      <FormattedContent
        key={keyPrefix}
        content={formattedText}
        data-testid="audit-formatted-content"
      />
    ) : (
      <span key={keyPrefix}>{text}</span>
    );
  }
  if (Array.isArray(value)) {
    return (
      <div key={keyPrefix} className="space-y-2">
        {value.map((item, index) => (
          <div key={`${keyPrefix}-${index}`}>
            {renderSnapshot(item, `${keyPrefix}-${index}`, labelForKey, resolveValue)}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div key={keyPrefix} className="space-y-3">
      {Object.entries(value)
        .filter(
          ([key]) =>
            ![
              'id',
              'workspaceId',
              'createdAt',
              'updatedAt',
              'templateSectionId',
              'agentId',
              'templateId',
            ].includes(key),
        )
        .map(([key, item]) => (
          <div key={`${keyPrefix}-${key}`}>
            <p className="mb-1 text-xs font-semibold text-muted">{labelForKey(key)}</p>
            <div className="break-words">
              {resolveValue?.(key, item) ??
                renderSnapshot(item, `${keyPrefix}-${key}`, labelForKey, resolveValue)}
            </div>
          </div>
        ))}
    </div>
  );
}

export function HistoryViewer({
  apiClient,
  entityType,
  workspaceId,
  entityId,
  entityTitle,
  resolveValue,
  size,
}: {
  apiClient: ApiClient;
  entityType: AuditEntityType;
  workspaceId: string | null;
  entityId: string;
  entityTitle?: string;
  /** Formats snapshot fields such as user or parent IDs for display. */
  resolveValue?: AuditValueResolver;
  size?: 'sm';
}) {
  const { t, formatDate } = useI18n();
  const snapshotLabels: Readonly<Record<string, string>> = {
    title: t('audit.fieldTitle'),
    name: t('audit.fieldName'),
    content: t('audit.fieldContent'),
    description: t('audit.fieldDescription'),
    sections: t('audit.fieldSections'),
    plans: t('audit.fieldPlans'),
    testCases: t('audit.fieldCases'),
    cases: t('audit.fieldCases'),
    steps: t('audit.fieldSteps'),
    messages: t('audit.fieldMessages'),
    action: t('audit.fieldAction'),
    expectedResult: t('audit.fieldExpectedResult'),
    order: t('audit.fieldOrder'),
    data: t('audit.fieldData'),
    status: t('audit.fieldStatus'),
    kind: t('audit.fieldKind'),
    parentId: t('audit.fieldParent'),
    type: t('audit.fieldType'),
    areaPath: t('audit.fieldArea'),
    iterationPath: t('audit.fieldIteration'),
    tags: t('audit.fieldTags'),
    priority: t('audit.fieldPriority'),
    adkPriority: t('audit.fieldPriority'),
    adkAgentId: t('audit.fieldAgent'),
    assigneeAgentId: t('audit.fieldAgent'),
    adkAssigneeUserId: t('audit.fieldAssignee'),
    assigneeUserId: t('audit.fieldAssignee'),
    adkCardType: t('audit.fieldType'),
    links: t('audit.fieldLinks'),
    number: t('audit.fieldNumber'),
    comment: t('audit.fieldComment'),
    pbiItemId: t('audit.fieldPbi'),
    version: t('audit.fieldVersion'),
    itemIds: t('audit.fieldItems'),
  };
  const labelForSnapshotKey = (key: string) => snapshotLabels[key] ?? key;
  const [open, setOpen] = useState(false);
  const type = entityType;
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<AuditHistoryPage>();
  const [error, setError] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    setOpen(false);
    setPage(1);
    setResult(undefined);
  }, [workspaceId, entityId, entityType]);
  useEffect(() => {
    if (open) dialog.current?.showModal?.();
    else {
      dialog.current?.close?.();
      if (opener.current?.isConnected) opener.current.focus();
      opener.current = null;
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setResult(undefined);
    setError(false);
    void apiClient
      .getAuditHistory(type, page, controller.signal, entityId)
      .then((value) => {
        if (!controller.signal.aborted) setResult(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [apiClient, type, page, open, revision, workspaceId, entityId]);

  return (
    <>
      <Button
        // The viewer is often placed inside forms (PBI editor), which must not be submitted.
        type="button"
        variant="ghost"
        size={size}
        leftIcon={<i className="ti ti-history text-base" aria-hidden="true" />}
        onClick={(event) => {
          opener.current =
            event.currentTarget
              .closest('[data-actions-menu]')
              ?.querySelector<HTMLButtonElement>('button[aria-haspopup]') ?? event.currentTarget;
          setPage(1);
          setOpen(true);
        }}
      >
        {t('audit.title')}
      </Button>
      {createPortal(
        <dialog
          ref={dialog}
          aria-labelledby={titleId}
          onCancel={() => setOpen(false)}
          onClose={() => setOpen(false)}
          // The dialog is portaled, but React still bubbles its events to the component that
          // renders it (forms, menus, clickable cards, modals listening for Escape).
          onClick={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onSubmit={(event) => event.stopPropagation()}
          className="m-auto max-h-[85vh] w-[min(56rem,95vw)] overflow-y-auto rounded-lg border border-border bg-surface-1 p-6 text-[var(--text-primary)] backdrop:bg-black/70"
        >
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 id={titleId} className="text-lg font-semibold">
              {t('audit.title')} · {entityTitle ?? t(`audit.${type}`)}
            </h2>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              {t('common.close')}
            </Button>
          </div>
          {open && (
            <>
              <div className="mb-4 flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setRevision((value) => value + 1)}
                >
                  {t('audit.refresh')}
                </Button>
              </div>
              {error ? (
                <div role="alert">
                  <p>{t('audit.error')}</p>
                  <Button type="button" onClick={() => setRevision((value) => value + 1)}>
                    {t('common.retry')}
                  </Button>
                </div>
              ) : !result ? (
                <div role="status" aria-label={t('common.loading')}>
                  <SkeletonText />
                </div>
              ) : (
                <>
                  {result.items.length === 0 && <p>{t('audit.empty')}</p>}
                  <ol className="space-y-4">
                    {result.items.map((event) => (
                      <li key={event.id} className="rounded border border-border p-4">
                        <p className="font-semibold">
                          {t(`audit.${event.action}`)} ·{' '}
                          {formatDate(event.occurredAt, {
                            dateStyle: 'short',
                            timeStyle: 'medium',
                          })}
                        </p>
                        <p className="break-words text-sm text-[var(--text-secondary)]">
                          {event.actorName ?? event.actorEmail ?? t('audit.system')}
                          {event.actorName && event.actorEmail ? ` (${event.actorEmail})` : ''}
                          {(type === 'pbi' || type === 'issue' || type === 'release_note') &&
                            event.operation && (
                              <span className="text-xs text-[var(--text-muted)]">
                                {' '}
                                · {t('audit.via')} {event.operation}
                              </span>
                            )}
                        </p>
                        <p className="truncate font-medium">{title(event.after ?? event.before)}</p>
                        <details className="mt-2">
                          <summary className="cursor-pointer focus-visible:outline-none focus-visible:ring-2">
                            {t('audit.details')}
                          </summary>
                          <div className="mt-3 grid gap-4 md:grid-cols-2">
                            {(['before', 'after'] as const).map((side) => (
                              <section key={side}>
                                <h3 className="font-semibold">{t(`audit.${side}`)}</h3>
                                <div className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-2 p-3 text-sm">
                                  {event[side] === null
                                    ? t('audit.missing')
                                    : renderSnapshot(
                                        event[side],
                                        `${event.id}-${side}`,
                                        labelForSnapshotKey,
                                        resolveValue,
                                      )}
                                </div>
                              </section>
                            ))}
                          </div>
                        </details>
                      </li>
                    ))}
                  </ol>
                  <div className="mt-4 flex items-center justify-between gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      disabled={page <= 1}
                      onClick={() => setPage((value) => value - 1)}
                    >
                      {t('audit.previous')}
                    </Button>
                    <span>
                      {page} / {Math.max(1, result.totalPages)}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={page >= result.totalPages}
                      onClick={() => setPage((value) => value + 1)}
                    >
                      {t('audit.next')}
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
        </dialog>,
        document.body,
      )}
    </>
  );
}
