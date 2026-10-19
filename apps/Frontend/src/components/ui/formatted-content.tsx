/* eslint-disable react-refresh/only-export-components */
import React from 'react';
import { cn } from '../../lib/utils.js';
import { useI18n } from '../../lib/i18n/index.js';

export interface FormattedContentProps {
  readonly content?: string | null;
  readonly inline?: boolean;
  readonly className?: string;
  readonly 'data-testid'?: string;
}

interface InlineToken {
  readonly type: 'text' | 'bold' | 'italic' | 'underline' | 'code' | 'link';
  readonly content: string;
  readonly href?: string;
}

const INLINE_REGEX =
  /(<b>[\s\S]*?<\/b>|<strong>[\s\S]*?<\/strong>|<i>[\s\S]*?<\/i>|<em>[\s\S]*?<\/em>|<u>[\s\S]*?<\/u>|<code>[\s\S]*?<\/code>|`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/gi;

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Decodes the basic HTML entities produced by escaped rich text (for example test case descriptions). */
export function decodeHtmlEntities(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos|nbsp|#\d+);/g, (_entity, name: string) =>
    name.startsWith('#') ? String.fromCodePoint(Number(name.slice(1))) : (ENTITIES[name] as string),
  );
}

export function parseInlineTokens(text: string): readonly InlineToken[] {
  const tokens: InlineToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  INLINE_REGEX.lastIndex = 0;
  while ((match = INLINE_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({
        type: 'text',
        content: text.substring(lastIndex, match.index),
      });
    }

    const raw = match[0];
    if (/^<b\b/i.test(raw) || /^<strong\b/i.test(raw)) {
      const inner = raw.replace(/^<[^>]+>/, '').replace(/<\/[^>]+>$/, '');
      tokens.push({ type: 'bold', content: inner });
    } else if (/^<i\b/i.test(raw) || /^<em\b/i.test(raw)) {
      const inner = raw.replace(/^<[^>]+>/, '').replace(/<\/[^>]+>$/, '');
      tokens.push({ type: 'italic', content: inner });
    } else if (/^<u\b/i.test(raw)) {
      const inner = raw.replace(/^<[^>]+>/, '').replace(/<\/[^>]+>$/, '');
      tokens.push({ type: 'underline', content: inner });
    } else if (/^<code\b/i.test(raw)) {
      const inner = raw.replace(/^<[^>]+>/, '').replace(/<\/[^>]+>$/, '');
      tokens.push({ type: 'code', content: inner });
    } else if (raw.startsWith('`') && raw.endsWith('`')) {
      tokens.push({ type: 'code', content: raw.slice(1, -1) });
    } else if (raw.startsWith('**') && raw.endsWith('**')) {
      tokens.push({ type: 'bold', content: raw.slice(2, -2) });
    } else if (raw.startsWith('*') && raw.endsWith('*')) {
      tokens.push({ type: 'italic', content: raw.slice(1, -1) });
    } else if (raw.startsWith('[') && raw.includes('](')) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(raw);
      if (linkMatch) {
        tokens.push({
          type: 'link',
          content: linkMatch[1]!,
          href: linkMatch[2]!,
        });
      }
    }

    lastIndex = INLINE_REGEX.lastIndex;
  }

  if (lastIndex < text.length) {
    tokens.push({ type: 'text', content: text.substring(lastIndex) });
  }

  // Decode after tokenizing so escaped markup such as &lt;b&gt; stays literal text.
  return tokens.map((token) => ({ ...token, content: decodeHtmlEntities(token.content) }));
}

export function renderInlineTokens(
  tokens: readonly InlineToken[],
  keyPrefix = 'inline',
): React.ReactNode[] {
  return tokens.map((token, idx) => {
    const key = `${keyPrefix}-${idx}`;
    switch (token.type) {
      case 'bold':
        return (
          <strong key={key} className="font-semibold text-[var(--text-primary)]">
            {token.content}
          </strong>
        );
      case 'italic':
        return (
          <em key={key} className="italic text-[var(--text-secondary)]">
            {token.content}
          </em>
        );
      case 'underline':
        return (
          <u key={key} className="underline">
            {token.content}
          </u>
        );
      case 'code':
        return (
          <code
            key={key}
            className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-accent-foreground"
          >
            {token.content}
          </code>
        );
      case 'link':
        return (
          <a
            key={key}
            href={token.href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent-foreground underline hover:text-accent"
          >
            {token.content}
          </a>
        );
      case 'text':
      default:
        return <React.Fragment key={key}>{token.content}</React.Fragment>;
    }
  });
}

function getHeadingIcon(title: string): string {
  const lower = title.toLowerCase();
  if (lower.includes('caso de uso') || lower.includes('cenário') || lower.includes('objetivo')) {
    return 'ti-target text-accent-foreground';
  }
  if (lower.includes('pré-condiç') || lower.includes('precondiç') || lower.includes('requisito')) {
    return 'ti-checklist text-amber-400';
  }
  if (lower.includes('dados') || lower.includes('entrada') || lower.includes('massa')) {
    return 'ti-database text-blue-400';
  }
  if (lower.includes('resultado') || lower.includes('esperado') || lower.includes('critério')) {
    return 'ti-circle-check text-emerald-400';
  }
  if (lower.includes('pós-condiç') || lower.includes('poscondiç')) {
    return 'ti-flag text-purple-400';
  }
  if (lower.includes('fluxo') || lower.includes('diagrama') || lower.includes('processo')) {
    return 'ti-git-fork text-indigo-400';
  }
  return 'ti-bookmark text-accent-foreground';
}

type ScenarioBlock =
  | { readonly type: 'heading'; readonly title: string }
  | { readonly type: 'paragraph'; readonly content: string }
  | { readonly type: 'list-item'; readonly marker: string; readonly content: string }
  | { readonly type: 'diagram'; readonly content: string }
  | { readonly type: 'empty' };

export function parseScenarioBlocks(raw: string): readonly ScenarioBlock[] {
  // Normalize line breaks: replace <br> with \n
  const text = raw.replace(/<br\s*\/?>/gi, '\n');
  const lines = text.split(/\r?\n/);

  const blocks: ScenarioBlock[] = [];
  let currentDiagramLines: string[] = [];

  const flushDiagram = () => {
    if (currentDiagramLines.length > 0) {
      blocks.push({
        type: 'diagram',
        content: currentDiagramLines.join('\n'),
      });
      currentDiagramLines = [];
    }
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    // Check if line is part of a box-drawing flowchart
    if (/[─│┌┐└┘├┤┬┴┼▼▶▲◄►]/.test(trimmed)) {
      currentDiagramLines.push(rawLine);
      continue;
    } else {
      flushDiagram();
    }

    if (!trimmed) {
      blocks.push({ type: 'empty' });
      continue;
    }

    // Check for section headings e.g. <b>## Title</b>, ## Title, <b>Title:</b>, <strong>Title</strong>
    const headingMatch =
      trimmed.match(/^<b>\s*#{1,6}\s*(.+?)\s*<\/b>$/i) ||
      trimmed.match(/^<strong>\s*#{1,6}\s*(.+?)\s*<\/strong>$/i) ||
      trimmed.match(/^<b>\s*(.+?)\s*<\/b>$/i) ||
      trimmed.match(/^<strong>\s*(.+?)\s*<\/strong>$/i) ||
      trimmed.match(/^#{1,6}\s+(.+?)$/);

    if (headingMatch) {
      const cleanCandidate = headingMatch[1]!
        .replace(/^[#\s]+/, '')
        .replace(/[:]$/, '')
        .trim();
      const isHeading =
        /^<b>\s*#|^<strong>\s*#|^#/i.test(trimmed) ||
        /(caso de uso|condiç|dados|resultado|cenário|objetivo)/i.test(cleanCandidate);

      if (isHeading) {
        blocks.push({
          type: 'heading',
          title: cleanCandidate,
        });
        continue;
      }
    }

    // List items: "- item" or "* item" or "1. item"
    const listMatch = trimmed.match(/^([-*]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      blocks.push({
        type: 'list-item',
        marker: listMatch[1]!,
        content: listMatch[2]!,
      });
      continue;
    }

    blocks.push({
      type: 'paragraph',
      content: trimmed,
    });
  }

  flushDiagram();
  return blocks;
}

export function FormattedContent({
  content,
  inline = false,
  className,
  'data-testid': testId,
}: FormattedContentProps) {
  const { t } = useI18n();
  if (!content) return null;

  if (inline) {
    // For inline content, split by <br> and render line breaks
    const lines = content.split(/<br\s*\/?>|\r?\n/gi);
    return (
      <span className={cn('inline', className)} data-testid={testId}>
        {lines.map((line, idx) => (
          <React.Fragment key={`inline-line-${idx}`}>
            {idx > 0 && <br />}
            {renderInlineTokens(parseInlineTokens(line), `line-${idx}`)}
          </React.Fragment>
        ))}
      </span>
    );
  }

  const blocks = parseScenarioBlocks(content);

  return (
    <div
      className={cn('space-y-2 leading-relaxed text-[var(--text-secondary)]', className)}
      data-testid={testId ?? 'formatted-content'}
    >
      {blocks.map((block, idx) => {
        const key = `block-${idx}`;

        if (block.type === 'heading') {
          const icon = getHeadingIcon(block.title);
          return (
            <div
              key={key}
              className="mt-3.5 first:mt-0 mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-accent-foreground border-b border-border/40 pb-1"
              data-testid={`heading-${block.title.toLowerCase().replace(/\s+/g, '-')}`}
            >
              <i className={cn('ti', icon, 'text-xs')} aria-hidden="true" />
              <span>{block.title}</span>
            </div>
          );
        }

        if (block.type === 'diagram') {
          return (
            <div key={key} className="my-3 space-y-1.5" data-testid="flowchart-diagram">
              <div className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-muted">
                <i className="ti ti-git-fork text-xs text-indigo-400" aria-hidden="true" />
                <span>{t('common.scenarioFlow')}</span>
              </div>
              <pre className="overflow-x-auto rounded-lg border border-border/50 bg-surface-2/80 p-3 font-mono text-xs leading-tight text-[var(--text-primary)] shadow-inner whitespace-pre">
                {block.content}
              </pre>
            </div>
          );
        }

        if (block.type === 'list-item') {
          return (
            <div key={key} className="flex items-start gap-2 pl-2 text-xs">
              <span className="text-accent-foreground select-none shrink-0">•</span>
              <div className="flex-1">
                {renderInlineTokens(parseInlineTokens(block.content), `${key}-list`)}
              </div>
            </div>
          );
        }

        if (block.type === 'empty') {
          return <div key={key} className="h-0.5" />;
        }

        return (
          <p key={key} className="text-xs">
            {renderInlineTokens(parseInlineTokens(block.content), `${key}-p`)}
          </p>
        );
      })}
    </div>
  );
}
