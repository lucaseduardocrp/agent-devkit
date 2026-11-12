import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/button.js';
import { Textarea } from '../../components/ui/textarea.js';
import { formatMessage, useI18n } from '../../lib/i18n/index.js';
import { cn } from '../../lib/utils.js';
import { estimateTokens, fullPrompt } from './agent-brief-prompt-text.js';
import type { BriefPrompt } from './agent-brief-types.js';

const PART_KEYS = ['system', 'task', 'outputFormat'] as const;
type PartKey = (typeof PART_KEYS)[number];
type Tab = PartKey | 'preview';
/**
 * One part of the prompt at a time (tabs) instead of three tall boxes, a size counter per
 * part, a preview of what the agent receives, and a warning when it exceeds the input budget.
 */
export function PromptEditor({
  prompt,
  original,
  maxInputTokens,
  disabled,
  onChange,
  onCopy,
  copied,
}: {
  prompt: BriefPrompt;
  /** The saved prompt, to mark and undo what was edited here. */
  original: BriefPrompt;
  maxInputTokens: number;
  disabled: boolean;
  onChange: (prompt: BriefPrompt) => void;
  onCopy: () => void;
  copied: boolean;
}) {
  const { messages, formatNumber } = useI18n();
  const c = messages.agentBriefPrompt;
  const [tab, setTab] = useState<Tab>('system');
  const area = useRef<HTMLTextAreaElement>(null);
  const tabs: readonly Tab[] = [...PART_KEYS, 'preview'];
  const text = tab === 'preview' ? fullPrompt(prompt) : prompt[tab];
  const total = estimateTokens(fullPrompt(prompt));
  const over = maxInputTokens > 0 && total > maxInputTokens;

  // The box grows with its text so long prompts are read without an inner scrollbar.
  useLayoutEffect(() => {
    const element = area.current!;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight + 2, 480)}px`;
  }, [tab, text]);

  const changed = (key: PartKey) => prompt[key] !== original[key];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label="Prompt" className="flex flex-wrap gap-1">
          {tabs.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              id={`prompt-tab-${key}`}
              aria-selected={tab === key}
              aria-controls="prompt-panel"
              onClick={() => setTab(key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                tab === key
                  ? 'border-[var(--border-accent)] bg-[var(--surface-1)] text-[var(--text-primary)]'
                  : 'border-transparent text-[var(--text-muted)] hover:bg-[var(--fill-ghost-hover)]',
              )}
            >
              {key === 'preview' && <i className="ti ti-eye" aria-hidden="true" />}
              {c.tabs[key]}
              {key !== 'preview' && changed(key) && (
                <span
                  role="img"
                  aria-label={c.edited}
                  title={c.edited}
                  className="h-1.5 w-1.5 rounded-full bg-[var(--text-accent)]"
                />
              )}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {copied && (
            <span role="status" className="text-xs text-[var(--text-muted)]">
              {c.copied}
            </span>
          )}
          <Button type="button" variant="outline" size="sm" onClick={onCopy}>
            <i className="ti ti-copy" aria-hidden="true" />
            {c.copy}
          </Button>
        </div>
      </div>

      <div
        id="prompt-panel"
        role="tabpanel"
        aria-labelledby={`prompt-tab-${tab}`}
        className="space-y-2"
      >
        <p className="text-xs text-[var(--text-muted)]">
          {tab === 'preview' ? c.previewHint : c.hints[tab]}
        </p>
        <Textarea
          ref={area}
          aria-label={c.tabs[tab]}
          readOnly={tab === 'preview'}
          disabled={disabled && tab !== 'preview'}
          className="min-h-[96px] resize-y font-mono text-sm leading-6"
          value={text}
          onChange={(event) => {
            if (tab !== 'preview') onChange({ ...prompt, [tab]: event.target.value });
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
          <span>
            {formatMessage(c.chars, { count: formatNumber(text.length) })} ·{' '}
            {formatMessage(c.tokens, { count: formatNumber(estimateTokens(text)) })}
          </span>
          {tab !== 'preview' && changed(tab) && !disabled && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onChange({ ...prompt, [tab]: original[tab] })}
            >
              <i className="ti ti-arrow-back-up" aria-hidden="true" />
              {c.revert}
            </Button>
          )}
        </div>
      </div>

      {over && (
        <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          <i className="ti ti-alert-triangle mt-0.5" aria-hidden="true" />
          {formatMessage(c.overBudget, {
            tokens: formatNumber(total),
            limit: formatNumber(maxInputTokens),
          })}
        </p>
      )}
    </div>
  );
}
