import { useEffect, useMemo, useRef } from 'react';
import { Button } from '../../components/ui/button.js';
import { Modal } from '../../components/ui/modal.js';
import { useI18n } from '../../lib/i18n/index.js';
import type { BriefReference } from './agent-brief-types.js';
import { locateExcerpt, type ReferenceDetail } from './agent-brief-reference-text.js';
/** What one reference points at, with the exact passage of a Brain page highlighted. */
export function ReferenceViewer({
  reference,
  detail,
  status,
  onClose,
  onOpenModule,
}: {
  reference: BriefReference;
  detail: ReferenceDetail | undefined;
  status: 'loading' | 'ready' | 'error';
  onClose: () => void;
  onOpenModule?: (reference: BriefReference) => void;
}) {
  const { messages } = useI18n();
  const c = messages.agentBriefReference;
  const mark = useRef<HTMLElement>(null);
  const excerpt = reference.excerpt?.trim() ?? '';
  const found = useMemo(
    () => (detail && excerpt ? locateExcerpt(detail.body, excerpt) : null),
    [detail, excerpt],
  );

  // The page opens at the passage, not at its top.
  useEffect(() => {
    mark.current?.scrollIntoView?.({ block: 'center' });
  }, [found]);

  const title = detail?.title ?? reference.label;
  return (
    <Modal open labelledBy="reference-viewer-title" onClose={onClose}>
      <div className="flex h-[40rem] w-[52rem] max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] flex-col gap-4 rounded-xl border border-border bg-surface-1 p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase text-[var(--text-muted)]">
              {c.kinds[reference.kind]}
              {detail?.subtitle ? ` · ${detail.subtitle}` : ''}
            </p>
            <h2
              id="reference-viewer-title"
              className="break-words text-lg font-semibold text-[var(--text-primary)]"
            >
              {title}
            </h2>
          </div>
          <div className="flex shrink-0 gap-2">
            {onOpenModule && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => onOpenModule(reference)}
              >
                <i className="ti ti-external-link" aria-hidden="true" />
                {c.openInModule}
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              {c.close}
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-4 text-sm leading-6 text-[var(--text-primary)]">
          {status === 'loading' && (
            <p role="status" className="text-[var(--text-muted)]">
              {c.loading}
            </p>
          )}
          {status === 'error' && (
            <p role="alert" className="text-red-300">
              {c.failed}
            </p>
          )}
          {status === 'ready' && !detail && <p className="text-[var(--text-muted)]">{c.missing}</p>}
          {status === 'ready' && detail && (
            <div className="space-y-3">
              {excerpt && !found && (
                <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                  <p className="text-xs font-semibold text-amber-200">{c.passage}</p>
                  <p className="whitespace-pre-wrap break-words">{excerpt}</p>
                  <p className="text-xs text-amber-200/80">{c.passageNotFound}</p>
                </div>
              )}
              {detail.body ? (
                <pre className="whitespace-pre-wrap break-words font-sans">
                  {found ? (
                    <>
                      {detail.body.slice(0, found.start)}
                      <mark
                        ref={mark}
                        aria-label={c.passage}
                        className="rounded bg-amber-400/30 px-0.5 text-inherit ring-1 ring-amber-400/60"
                      >
                        {detail.body.slice(found.start, found.end)}
                      </mark>
                      {detail.body.slice(found.end)}
                    </>
                  ) : (
                    detail.body
                  )}
                </pre>
              ) : (
                <p className="text-[var(--text-muted)]">{c.empty}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
