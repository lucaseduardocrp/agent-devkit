import { useEffect, useRef, useState, type ChangeEvent, type ClipboardEvent } from 'react';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Textarea } from '../../components/ui/textarea.js';
import type { E2eCaseRevision, E2eCaseTurn } from '../../lib/api-client.js';
import { formatMessage, useI18n } from '../../lib/i18n/index.js';
import { IMAGE_ACCEPT, fileKind } from '../shared/attachment-types.js';
import { useMediaClient } from '../shared/media.js';
import { applyRevision, caseToDraft } from './test-case-revision.js';
import type { TestCase } from './TestPlansView.js';

/** What the "Fix with AI" chat needs from where the test case lives. */
export interface TestCaseFixAssistant {
  /** One turn: the AI answers and may rewrite the case. */
  readonly ask: (turn: E2eCaseTurn) => Promise<E2eCaseRevision>;
  /** Saves the case as the chat left it and writes the test script again from it. */
  readonly saveAndRegenerate: (testCase: TestCase) => Promise<void>;
}

/** Images a message may carry, and the ones the AI keeps looking at across the conversation. */
const MAX_IMAGES = 5;
/** The server sends a model nothing bigger than this. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface ChatMessage {
  readonly id: number;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly images: readonly string[];
  /** The case before the AI rewrote it, while the rewrite can still be undone. */
  readonly undo?: TestCase;
}

export interface TestCaseFixChatProps {
  readonly assistant: TestCaseFixAssistant;
  /** The case as it is open in the editor. */
  readonly testCase: TestCase;
  /** The editor takes this case: what the AI rewrote, or the one an undo goes back to. */
  readonly onChange: (testCase: TestCase) => void;
  /** Saves the case and writes the script again from it. */
  readonly onRegenerate: () => void;
  readonly isRegenerating: boolean;
  readonly onClose: () => void;
}

/**
 * Chat of "Fix with AI": the person says what the test does wrong (and sends images of the right
 * flow), the AI rewrites the test case in the editor, and one button saves it and writes the
 * script again from it.
 */
export function TestCaseFixChat({
  assistant,
  testCase,
  onChange,
  onRegenerate,
  isRegenerating,
  onClose,
}: TestCaseFixChatProps) {
  const { messages: i18n } = useI18n();
  const c = i18n.testCaseEditor;
  const apiClient = useMediaClient();
  const [messages, setMessages] = useState<readonly ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [files, setFiles] = useState<readonly File[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ids of the images already uploaded in this conversation; the AI keeps seeing them.
  const sentImages = useRef<readonly string[]>([]);
  const nextId = useRef(1);
  const list = useRef<HTMLDivElement>(null);
  // The case may change while the AI works (the person keeps editing): the latest one is used.
  const current = useRef(testCase);
  useEffect(() => {
    current.current = testCase;
  }, [testCase]);

  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [messages, sending]);

  const addFiles = (added: readonly File[]) => {
    if (!added.length) return;
    const tooBig = added.find((file) => fileKind(file) !== 'image' || file.size > MAX_IMAGE_BYTES);
    if (tooBig) {
      setError(formatMessage(c.fixOnlyImages, { name: tooBig.name || 'image' }));
      return;
    }
    if (files.length + added.length > MAX_IMAGES) {
      setError(formatMessage(c.fixTooManyImages, { max: MAX_IMAGES }));
      return;
    }
    setError(null);
    setFiles([...files, ...added]);
  };

  const send = async () => {
    // The box and the button are locked while the AI answers, so there is no second send.
    const content = text.trim();
    if (!content) return;
    const asked: ChatMessage = {
      id: nextId.current++,
      role: 'user',
      content,
      images: files.map((file) => file.name || 'image'),
    };
    const conversation = [...messages, asked];
    setMessages(conversation);
    setText('');
    setFiles([]);
    setSending(true);
    setError(null);
    try {
      const uploaded = await Promise.all(
        files.map(async (file) => (await apiClient!.uploadAttachment('e2e', file)).id),
      );
      const imageIds = [...sentImages.current, ...uploaded].slice(-MAX_IMAGES);
      const revision = await assistant.ask({
        messages: conversation.map(({ role, content: said }) => ({ role, content: said })),
        testCase: caseToDraft(current.current),
        imageIds,
      });
      sentImages.current = imageIds;
      const before = current.current;
      if (revision.testCase) onChange(applyRevision(before, revision.testCase));
      setMessages([
        // Only the latest rewrite can be undone.
        ...conversation.map(({ undo: _undo, ...message }) => message),
        {
          id: nextId.current++,
          role: 'assistant',
          content: revision.reply || (revision.testCase ? c.fixEmptyReply : ''),
          images: [],
          ...(revision.testCase ? { undo: before } : {}),
        },
      ]);
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : c.fixFailed);
      // What the person wrote goes back to the box to be sent again.
      setMessages(messages);
      setText(content);
      setFiles(files);
    } finally {
      setSending(false);
    }
  };

  const undo = (message: ChatMessage) => {
    onChange(message.undo!);
    setMessages(messages.map(({ undo: _undo, ...rest }) => rest));
  };

  const canSend = text.trim().length > 0 && !sending;

  return (
    <aside
      className="flex h-[70vh] min-h-0 flex-col bg-[var(--surface-1)] lg:h-auto"
      aria-label={c.fixTitle}
      data-testid="test-case-fix-chat"
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <i className="ti ti-sparkles text-[var(--text-accent)]" aria-hidden="true" />
          {c.fixTitle}
        </h3>
        <Button type="button" variant="ghost" size="icon" aria-label={c.fixClose} onClick={onClose}>
          <i className="ti ti-x" aria-hidden="true" />
        </Button>
      </div>

      <div
        ref={list}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4"
        role="log"
        aria-live="polite"
      >
        {messages.length === 0 && <p className="text-xs text-[var(--text-muted)]">{c.fixHint}</p>}
        {messages.map((message) => (
          <div
            key={message.id}
            className={
              message.role === 'user'
                ? 'ml-6 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3'
                : 'mr-6 rounded-lg border border-[var(--border-accent)] bg-[var(--surface-2)] p-3'
            }
            data-testid={`fix-chat-${message.role}`}
          >
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              {message.role === 'user' ? c.fixYou : c.fixAgent}
            </p>
            <p className="whitespace-pre-wrap break-words text-sm text-[var(--text-primary)]">
              {message.content}
            </p>
            {message.images.length > 0 && (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {message.images.map((name, index) => (
                  <li
                    key={index}
                    className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-1.5 py-0.5 text-[11px] text-[var(--text-muted)]"
                  >
                    <i className="ti ti-photo" aria-hidden="true" />
                    {name}
                  </li>
                ))}
              </ul>
            )}
            {message.undo && (
              <div className="mt-2 flex items-center justify-between gap-2 border-t border-[var(--border)] pt-2 text-xs text-[var(--text-accent)]">
                <span className="flex items-center gap-1">
                  <i className="ti ti-circle-check" aria-hidden="true" />
                  {c.fixUpdated}
                </span>
                <Button type="button" variant="ghost" size="sm" onClick={() => undo(message)}>
                  <i className="ti ti-arrow-back-up" aria-hidden="true" />
                  {c.fixUndo}
                </Button>
              </div>
            )}
          </div>
        ))}
        {sending && (
          <p className="flex items-center gap-2 text-xs text-[var(--text-muted)]" role="status">
            <i className="ti ti-loader-2 animate-spin" aria-hidden="true" />
            {c.fixThinking}
          </p>
        )}
      </div>

      <div className="space-y-2 border-t border-[var(--border)] px-4 py-3">
        {error && (
          <p role="alert" className="text-xs text-red-300">
            {error}
          </p>
        )}
        {files.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {files.map((file, index) => (
              <li
                key={`${file.name}-${index}`}
                className="inline-flex items-center gap-1 rounded border border-[var(--border)] bg-[var(--surface-2)] py-0.5 pl-1.5 text-[11px] text-[var(--text-secondary)]"
              >
                <i className="ti ti-photo" aria-hidden="true" />
                {file.name || 'image'}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-5 w-5 px-0"
                  aria-label={formatMessage(c.fixRemoveImage, { name: file.name || 'image' })}
                  onClick={() => setFiles(files.filter((_, at) => at !== index))}
                >
                  <i className="ti ti-x text-[10px]" aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Textarea
          value={text}
          rows={3}
          maxLength={10_000}
          disabled={sending}
          placeholder={c.fixPlaceholder}
          aria-label={c.fixPlaceholder}
          className="min-h-[72px] text-sm"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => {
            const pasted = [...event.clipboardData.files].filter(
              (file) => fileKind(file) === 'image',
            );
            if (!pasted.length || !apiClient) return;
            event.preventDefault();
            addFiles(pasted);
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <label className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 text-xs font-semibold hover:border-[var(--border-strong)] has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
            <i className="ti ti-photo-plus" aria-hidden="true" />
            {c.fixAttach}
            <Input
              type="file"
              accept={IMAGE_ACCEPT}
              multiple
              disabled={sending || !apiClient}
              className="sr-only"
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                const picked = [...(event.currentTarget.files as FileList)];
                event.currentTarget.value = '';
                addFiles(picked);
              }}
            />
          </label>
          <Button
            type="button"
            size="sm"
            disabled={!canSend}
            isLoading={sending}
            onClick={() => void send()}
          >
            <i className="ti ti-send" aria-hidden="true" />
            {c.fixSend}
          </Button>
        </div>
        <div className="border-t border-[var(--border)] pt-3">
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            disabled={sending}
            isLoading={isRegenerating}
            title={c.fixRegenerateHint}
            onClick={onRegenerate}
            data-testid="btn-fix-regenerate"
          >
            <i className="ti ti-refresh" aria-hidden="true" />
            {c.fixRegenerate}
          </Button>
        </div>
      </div>
    </aside>
  );
}
