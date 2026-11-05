import React from 'react';
import { Button } from '../../../components/ui/button.js';
import { IconButton } from '../../../components/ui/icon-button.js';
import { Input } from '../../../components/ui/input.js';
import { Select } from '../../../components/ui/select.js';
import { useI18n } from '../../../lib/i18n/index.js';
import type { OutgoingMessage } from '../api-test-types.js';
import { CodeEditor } from './CodeEditor.js';
import { MESSAGE_TYPES, type MessageType } from './protocol-model.js';

/** The messages a WebSocket or socket request sends, in order, each after its delay. */
export function MessagesEditor({
  messages,
  protocol,
  readOnly,
  onChange,
}: {
  readonly messages: readonly OutgoingMessage[];
  readonly protocol: 'websocket' | 'socket';
  readonly readOnly: boolean;
  readonly onChange: (messages: OutgoingMessage[]) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const update = (index: number, patch: Partial<OutgoingMessage>) =>
    onChange(messages.map((item, position) => (position === index ? { ...item, ...patch } : item)));
  const move = (index: number, step: -1 | 1) => {
    const next = [...messages];
    [next[index], next[index + step]] = [next[index + step]!, next[index]!];
    onChange(next);
  };
  return (
    <div className="flex flex-col gap-3" data-testid="messages-editor">
      <p className="text-xs text-[var(--text-muted)]">
        {t(`apiTests.protocol.messagesHint.${protocol}`)}
      </p>
      {messages.map((message, index) => {
        const number = index + 1;
        const type = message.type ?? 'text';
        return (
          <div
            key={index}
            className="flex flex-col gap-2 rounded-md border border-[var(--border)] p-2"
            data-testid={`message-${index}`}
          >
            <div className="flex items-center gap-2">
              <span className="w-6 shrink-0 text-center font-mono text-xs text-[var(--text-muted)]">
                {number}
              </span>
              <Input
                inputSize="sm"
                aria-label={t('apiTests.protocol.messageName', { n: number })}
                placeholder={t('apiTests.protocol.messageName', { n: number })}
                value={message.name ?? ''}
                disabled={readOnly}
                onChange={(event) => update(index, { name: event.target.value || undefined })}
              />
              <Select
                selectSize="sm"
                containerClassName="w-28 shrink-0"
                aria-label={t('apiTests.protocol.messageType', { n: number })}
                value={type}
                disabled={readOnly}
                onChange={(event) => update(index, { type: event.target.value as MessageType })}
              >
                {MESSAGE_TYPES[protocol].map((value) => (
                  <option key={value} value={value}>
                    {t(`apiTests.protocol.messageTypes.${value}`)}
                  </option>
                ))}
              </Select>
              <label className="flex shrink-0 items-center gap-1 text-xs text-[var(--text-secondary)]">
                {t('apiTests.protocol.delay')}
                <Input
                  inputSize="sm"
                  type="number"
                  min={0}
                  className="w-20"
                  aria-label={t('apiTests.protocol.messageDelay', { n: number })}
                  value={message.delayMs ?? ''}
                  disabled={readOnly}
                  onChange={(event) =>
                    update(index, {
                      delayMs: event.target.value
                        ? Math.max(0, Number(event.target.value))
                        : undefined,
                    })
                  }
                />
              </label>
              {!readOnly && (
                <>
                  <IconButton
                    variant="ghost"
                    icon={<i className="ti ti-arrow-up text-sm" aria-hidden="true" />}
                    label={t('apiTests.protocol.moveUp', { n: number })}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  />
                  <IconButton
                    variant="ghost"
                    icon={<i className="ti ti-arrow-down text-sm" aria-hidden="true" />}
                    label={t('apiTests.protocol.moveDown', { n: number })}
                    disabled={index === messages.length - 1}
                    onClick={() => move(index, 1)}
                  />
                  <IconButton
                    variant="ghost"
                    icon={
                      <i
                        className="ti ti-trash text-sm text-[var(--text-danger)]"
                        aria-hidden="true"
                      />
                    }
                    label={t('apiTests.protocol.removeMessage', { n: number })}
                    onClick={() => onChange(messages.filter((_, position) => position !== index))}
                  />
                </>
              )}
            </div>
            <CodeEditor
              minHeight={96}
              value={message.content}
              language={type === 'json' ? 'json' : 'text'}
              readOnly={readOnly}
              label={t('apiTests.protocol.messageContent', { n: number })}
              placeholder={t(`apiTests.protocol.messagePlaceholders.${type}`)}
              onChange={(content) => update(index, { content })}
            />
          </div>
        );
      })}
      {!readOnly && (
        <Button
          variant="ghost"
          size="sm"
          className="self-start text-xs"
          onClick={() => onChange([...messages, { content: '', type: 'text' }])}
        >
          <i className="ti ti-plus" aria-hidden="true" />
          {t('apiTests.protocol.addMessage')}
        </Button>
      )}
    </div>
  );
}
