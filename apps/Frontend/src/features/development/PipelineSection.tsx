import { Button } from '../../components/ui/button.js';
import { useI18n } from '../../lib/i18n/index.js';
import {
  PIPELINE_STAGES,
  type Pipeline,
  type PipelineItem,
  type PipelineStage,
} from './development-types.js';
import { ChangeBadge, SessionBadge } from './development-ui.js';

const STAGE_ICONS: Record<PipelineStage, string> = {
  spec: 'ti-file-description',
  approval: 'ti-user-check',
  code: 'ti-terminal',
  review: 'ti-git-pull-request',
  done: 'ti-circle-check',
};

/** Every open change in the stage it is waiting at; a card opens the screen that moves it on. */
export function PipelineSection({
  pipeline,
  onOpen,
}: {
  readonly pipeline: Pipeline;
  readonly onOpen: (stage: PipelineStage, item: PipelineItem) => void;
}) {
  const { t, messages } = useI18n();
  const c = messages.development;
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
      {PIPELINE_STAGES.map((stage) => (
        <section
          key={stage}
          className="flex min-w-0 flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-3"
          aria-label={c.stages[stage]}
        >
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <i className={`ti ${STAGE_ICONS[stage]}`} aria-hidden="true" />
            {c.stages[stage]}
            <span className="ml-auto rounded-full bg-[var(--surface-2)] px-2 text-xs">
              {pipeline[stage].length}
            </span>
          </h2>
          {pipeline[stage].length === 0 && (
            <p className="text-xs text-[var(--text-muted)]">{c.emptyStage}</p>
          )}
          {pipeline[stage].map((item) => (
            <Button
              key={item.changeId}
              variant="ghost"
              className="flex h-auto w-full flex-col items-start gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-0)] p-3 text-left"
              onClick={() => onOpen(stage, item)}
            >
              <span className="block w-full truncate font-medium">{item.title}</span>
              <span className="block w-full truncate text-xs text-[var(--text-muted)]">
                {item.slug}
              </span>
              <span className="flex flex-wrap items-center gap-2 text-xs">
                {item.session ? (
                  <SessionBadge status={item.session.status} />
                ) : (
                  <ChangeBadge status={item.status} />
                )}
                {item.tasks.total > 0 && (
                  <span className="text-[var(--text-muted)]">
                    {t('development.tasksProgress', item.tasks)}
                  </span>
                )}
              </span>
            </Button>
          ))}
        </section>
      ))}
    </div>
  );
}
