import { useState } from 'react';
import { Badge } from '../../components/ui/badge.js';
import { IconButton } from '../../components/ui/icon-button.js';
import { useI18n } from '../../lib/i18n/index.js';
import { cn } from '../../lib/utils.js';
import type { DevSession } from './development-types.js';

const MAX_EVENTS = 100;
const PREVIEW_CHARS = 120;

type TimelineEvent = DevSession['events'][number];

/** An event worth folding: one that spans several lines or is too long to read in one. */
function isLong(text: string): boolean {
  return text.includes('\n') || text.length > PREVIEW_CHARS;
}

/**
 * The events of a session, one row each. A long event folds to its first line and opens on
 * demand, like the files of the changes; the header folds or opens them all at once.
 */
export function TimelineList({ events }: { readonly events: readonly TimelineEvent[] }) {
  const { t, messages, formatDate } = useI18n();
  const c = messages.development;
  const shown = events.slice(-MAX_EVENTS);
  const [open, setOpen] = useState<Readonly<Record<string, boolean>>>({});
  const foldable = shown.filter((event) => isLong(event.text));
  const setAll = (value: boolean) =>
    setOpen(Object.fromEntries(foldable.map((event) => [event.id, value])));

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{c.events}</h2>
        {foldable.length > 0 && (
          <div className="flex items-center gap-1">
            <IconButton
              size="xs"
              label={c.expandAll}
              icon={<i className="ti ti-arrows-diagonal" aria-hidden="true" />}
              onClick={() => setAll(true)}
            />
            <IconButton
              size="xs"
              label={c.collapseAll}
              icon={<i className="ti ti-arrows-diagonal-minimize-2" aria-hidden="true" />}
              onClick={() => setAll(false)}
            />
          </div>
        )}
      </div>
      <ol className="divide-y divide-[var(--border)]">
        {shown.map((event) => {
          const long = isLong(event.text);
          const expanded = long && (open[event.id] ?? false);
          const kind = c.eventKinds[event.kind];
          const first = event.text.split('\n', 1)[0] ?? '';
          const preview =
            first.length > PREVIEW_CHARS ? `${first.slice(0, PREVIEW_CHARS).trimEnd()}…` : first;
          return (
            <li key={event.id} className="flex items-start gap-2 py-1.5 text-sm">
              {long ? (
                <IconButton
                  size="xs"
                  label={t(expanded ? 'development.collapseEvent' : 'development.expandEvent', {
                    kind,
                  })}
                  aria-expanded={expanded}
                  icon={
                    <i
                      className={cn('ti', expanded ? 'ti-chevron-down' : 'ti-chevron-right')}
                      aria-hidden="true"
                    />
                  }
                  onClick={() => setOpen({ ...open, [event.id]: !expanded })}
                />
              ) : (
                <span className="inline-block h-6 w-6 shrink-0" aria-hidden="true" />
              )}
              <time
                className="w-16 shrink-0 whitespace-nowrap pt-0.5 text-xs tabular-nums text-[var(--text-muted)]"
                dateTime={event.at}
              >
                {formatDate(event.at, { timeStyle: 'short' })}
              </time>
              <div className="flex w-28 shrink-0 self-start">
                <Badge variant="outline" className="max-w-full truncate">
                  {kind}
                </Badge>
              </div>
              {expanded ? (
                <div
                  role="region"
                  aria-label={kind}
                  className="min-w-0 flex-1 whitespace-pre-wrap break-words rounded-md bg-[var(--surface-0)] px-3 py-2"
                >
                  {event.text}
                </div>
              ) : (
                <span
                  className="min-w-0 flex-1 truncate pt-0.5"
                  title={long ? event.text : undefined}
                >
                  {long ? preview : event.text}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}
