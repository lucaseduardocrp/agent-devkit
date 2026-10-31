import React, { useId, useState } from 'react';
import { Button } from '../../../components/ui/button.js';
import { Input } from '../../../components/ui/input.js';
import { Modal } from '../../../components/ui/modal.js';
import { useI18n } from '../../../lib/i18n/index.js';
import { cn } from '../../../lib/utils.js';
import { REQUEST_KINDS, type RequestKind } from '../api-test-types.js';
import { VariableInput } from '../VariableInput.js';

const KIND_ICON: Record<RequestKind, string> = {
  http: 'ti-world-www',
  graphql: 'ti-brand-graphql',
  grpc: 'ti-server-bolt',
  websocket: 'ti-plug-connected',
  sse: 'ti-broadcast',
  socket: 'ti-network',
};

/**
 * "New request", as in Bruno: the type (HTTP, GraphQL, gRPC...), a name and, optionally, the URL.
 * It is mounted when it opens, so it starts on the collection's preset with nothing to reset.
 */
export function NewRequestDialog({
  defaultKind = 'http',
  defaultName,
  onSubmit,
  onClose,
}: {
  readonly defaultKind?: RequestKind;
  readonly defaultName: string;
  readonly onSubmit: (input: { name: string; kind: RequestKind; url: string }) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const titleId = useId();
  const [kind, setKind] = useState<RequestKind>(defaultKind);
  const [name, setName] = useState(defaultName);
  const [url, setUrl] = useState('');

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (name.trim()) onSubmit({ name: name.trim(), kind, url });
  };

  return (
    <Modal open onClose={onClose} labelledBy={titleId}>
      <form
        className="flex w-[min(94vw,560px)] flex-col gap-4 rounded-lg border border-border bg-surface-1 p-6 shadow-2xl"
        onSubmit={submit}
        data-testid="new-request-dialog"
      >
        <h2 id={titleId} className="text-lg font-semibold text-[var(--text-primary)]">
          {t('apiTests.ui.newRequest')}
        </h2>
        <div
          className="grid grid-cols-2 gap-2 sm:grid-cols-3"
          role="radiogroup"
          aria-label={t('apiTests.workbench.requestType')}
        >
          {REQUEST_KINDS.map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={kind === value}
              onClick={() => setKind(value)}
              className={cn(
                'flex items-center gap-2 rounded-md border px-3 py-2 text-left text-xs transition-colors',
                kind === value
                  ? 'border-[var(--fill-accent)] bg-[var(--fill-ghost-selected)] text-[var(--text-primary)]'
                  : 'border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--fill-ghost-hover)]',
              )}
              data-testid={`kind-${value}`}
            >
              <i className={cn('ti text-base', KIND_ICON[value])} aria-hidden="true" />
              <span className="min-w-0">
                <span className="block font-medium">{t(`apiTests.workbench.kinds.${value}`)}</span>
                <span className="block truncate text-[11px] text-[var(--text-muted)]">
                  {t(`apiTests.workbench.kindHints.${value}`)}
                </span>
              </span>
            </button>
          ))}
        </div>
        <label className="flex flex-col gap-1.5 text-xs text-[var(--text-secondary)]">
          {t('common.name')}
          <Input
            autoFocus
            aria-label={t('common.name')}
            value={name}
            onChange={(event) => setName(event.target.value)}
            data-testid="new-request-name"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-xs text-[var(--text-secondary)]">
          URL
          <VariableInput
            mono
            aria-label="URL"
            value={url}
            placeholder={t('apiTests.workbench.urlOptional')}
            onValueChange={setUrl}
          />
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={!name.trim()} data-testid="new-request-submit">
            {t('apiTests.ui.create')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
