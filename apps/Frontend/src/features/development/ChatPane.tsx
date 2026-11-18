import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { IconButton } from '../../components/ui/icon-button.js';
import { Input } from '../../components/ui/input.js';
import { useI18n } from '../../lib/i18n/index.js';
import { cn } from '../../lib/utils.js';
import type { DevSession } from './development-types.js';

interface Props {
  readonly session: DevSession;
  readonly readOnly: boolean;
  readonly busy: boolean;
  /** Sends the message to the agent; false when it could not be sent, so the text is kept. */
  readonly onSend: (body: string) => Promise<boolean>;
}

interface Message {
  readonly id: string;
  readonly at: string;
  readonly from: 'user' | 'agent' | 'system';
  readonly text: string;
}

/**
 * The talk between the person and the agent: what the agent said, and what the person wrote for
 * it. A comment tied to a file belongs to the changes, not to the conversation.
 */
function conversationOf(session: DevSession): readonly Message[] {
  // The agent's words, and what became of the person's message (delivered, queued, ignored).
  const said = session.events
    .filter((event) => event.kind === 'message' || event.kind === 'feedback')
    .map((event): Message => ({
      id: event.id,
      at: event.at,
      from: event.kind === 'message' ? 'agent' : 'system',
      text: event.text,
    }));
  const written = session.comments
    .filter((comment) => comment.path === null)
    .map((comment): Message => ({
      id: comment.id,
      at: comment.createdAt,
      from: comment.author,
      text: comment.body,
    }));
  return [...said, ...written].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** A conversation with the agent of the session, shown beside its work. */
export function ChatPane({ session, readOnly, busy, onSend }: Props) {
  const { messages: texts } = useI18n();
  const c = texts.development;
  const [draft, setDraft] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const messages = useMemo(() => conversationOf(session), [session]);

  // The newest message is the one being read.
  useEffect(() => {
    list.current!.scrollTop = list.current!.scrollHeight;
  }, [messages.length]);

  const body = draft.trim();
  const canSend = Boolean(body) && !busy && !readOnly;
  const send = async () => {
    if (!canSend) return;
    // Typing on while it goes out keeps the new text; a failure keeps the old one.
    if (await onSend(body)) setDraft((current) => (current === draft ? '' : current));
  };
  const keys = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  return (
    <section
      aria-label={c.panels.chat}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--surface-1)]"
    >
      <h2 className="border-b border-[var(--border)] px-4 py-3 text-sm font-semibold">
        {c.panels.chat}
      </h2>
      <div ref={list} className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4" aria-live="polite">
        {messages.length === 0 && <p className="text-sm text-[var(--text-muted)]">{c.chatEmpty}</p>}
        {messages.map((message) => {
          const mine = message.from === 'user';
          if (message.from === 'system')
            return (
              <p
                key={message.id}
                role="status"
                className="whitespace-pre-wrap break-words text-center text-xs text-[var(--text-muted)]"
              >
                {message.text}
              </p>
            );
          return (
            <article
              key={message.id}
              aria-label={mine ? c.chatYou : c.agentAuthor}
              className={cn(
                'min-w-0 whitespace-pre-wrap break-words text-sm',
                mine && 'ml-auto w-fit max-w-[85%] rounded-lg bg-[var(--surface-2)] px-3 py-2',
              )}
            >
              {message.text}
            </article>
          );
        })}
      </div>
      <div className="space-y-2 border-t border-[var(--border)] p-3">
        <div className="flex items-center gap-2">
          <Input
            aria-label={c.chatPlaceholder}
            placeholder={c.chatPlaceholder}
            className="min-w-0 flex-1"
            value={draft}
            disabled={readOnly}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={keys}
          />
          <IconButton
            variant="default"
            label={c.chatSend}
            disabled={!canSend}
            icon={<i className="ti ti-send" aria-hidden="true" />}
            onClick={() => void send()}
          />
        </div>
        <p className="text-xs text-[var(--text-muted)]">{c.chatDelivery}</p>
      </div>
    </section>
  );
}
