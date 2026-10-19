import React from 'react';

export type MarkdownBlock =
  | { readonly type: 'heading'; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly text: string }
  | { readonly type: 'code'; readonly language: string; readonly code: string }
  | {
      readonly type: 'table';
      readonly headers: readonly string[];
      readonly alignments: readonly ('left' | 'center' | 'right')[];
      readonly rows: readonly (readonly string[])[];
    }
  | { readonly type: 'blockquote'; readonly text: string }
  | {
      readonly type: 'list';
      readonly ordered: boolean;
      readonly items: readonly {
        readonly text: string;
        readonly indent: number;
        readonly checked?: boolean;
      }[];
    }
  | { readonly type: 'hr' }
  | { readonly type: 'html'; readonly html: string }
  | { readonly type: 'paragraph'; readonly text: string };

const HTML_BLOCK_START = /^<(?:(!--)|(\/?)([a-z][a-z0-9]*|!doctype)(?=[\s/>]|$))/i;
const HTML_BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'details',
  'div',
  'dl',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'html',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'ul',
]);

/** Tag that must be closed to end an HTML block, '' when none is needed, null for non-HTML lines. */
function htmlBlockRoot(line: string): string | null {
  const match = HTML_BLOCK_START.exec(line.trim());
  if (!match) return null;
  if (match[1]) return '!--';
  const name = match[3]!.toLowerCase();
  if (name === '!doctype') return 'html';
  if (!HTML_BLOCK_TAGS.has(name)) return null;
  return match[2] || name === 'hr' ? '' : name;
}

function isHtmlBlockOpen(chunk: string, root: string): boolean {
  if (!root) return false;
  if (root === '!--') return !chunk.includes('-->');
  const opens = chunk.match(new RegExp(`<${root}(?=[\\s/>])`, 'gi'))?.length ?? 0;
  const closes = chunk.match(new RegExp(`</${root}\\s*>`, 'gi'))?.length ?? 0;
  return opens > closes;
}

function parseJsonDocument(content: string): string | null {
  const trimmed = content.trim();
  if (!/^[[{]/.test(trimmed)) return null;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}

const INLINE_REGEX =
  /(`[^`]+`|\*\*\*[^*]+\*\*\*|___[^_]+___|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|~~[^~]+~~|\[[^\]]+\]\([^)]+\)|\[\[[^\]]+\]\])/g;

export function renderInlineContent(
  text: string,
  onWikilinkClick?: (target: string) => void,
  wikilinkTitle: (target: string) => string = (target) => target,
): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  INLINE_REGEX.lastIndex = 0;
  while ((match = INLINE_REGEX.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.substring(lastIndex, match.index));
    }

    const token = match[0];
    const key = `inline-${match.index}`;

    if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(
        <code
          key={key}
          className="rounded bg-[#222226] px-1.5 py-0.5 font-mono text-xs text-[#9fc4ff]"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (
      (token.startsWith('***') && token.endsWith('***')) ||
      (token.startsWith('___') && token.endsWith('___'))
    ) {
      parts.push(
        <strong key={key} className="font-bold text-[#f5f5f5]">
          <em className="italic">{token.slice(3, -3)}</em>
        </strong>,
      );
    } else if (
      (token.startsWith('**') && token.endsWith('**')) ||
      (token.startsWith('__') && token.endsWith('__'))
    ) {
      parts.push(
        <strong key={key} className="font-semibold text-[#f5f5f5]">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (
      (token.startsWith('*') && token.endsWith('*')) ||
      (token.startsWith('_') && token.endsWith('_'))
    ) {
      parts.push(
        <em key={key} className="italic text-[#d0d0d0]">
          {token.slice(1, -1)}
        </em>,
      );
    } else if (token.startsWith('~~') && token.endsWith('~~')) {
      parts.push(
        <del key={key} className="text-[#808080] line-through">
          {token.slice(2, -2)}
        </del>,
      );
    } else if (token.startsWith('[[') && token.endsWith(']]')) {
      const inner = token.slice(2, -2);
      const [target, label] = inner.split('|');
      const className =
        'inline-flex items-center rounded border border-[#2b3e58] bg-[#1c2838] px-1.5 py-0.5 text-xs font-medium text-[#62a3f8]';
      parts.push(
        onWikilinkClick ? (
          <button
            type="button"
            key={key}
            className={`${className} cursor-pointer hover:bg-[#24344a] hover:underline`}
            title={wikilinkTitle(target!)}
            onClick={() => onWikilinkClick(target!)}
          >
            {label ?? target}
          </button>
        ) : (
          <span key={key} className={className} title={wikilinkTitle(target!)}>
            {label ?? target}
          </span>
        ),
      );
    } else {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      const href = linkMatch[2]!.trim();
      parts.push(
        /^(https?:\/\/|mailto:|tel:|\/|#|\.\.?\/)/i.test(href) ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#4a8fe8] hover:underline"
          >
            {linkMatch[1]}
          </a>
        ) : (
          <span key={key}>{linkMatch[1]}</span>
        ),
      );
    }

    lastIndex = INLINE_REGEX.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  return parts;
}

export function parseMarkdownBlocks(content: string): readonly MarkdownBlock[] {
  // Agent outputs are sometimes a raw JSON payload instead of Markdown.
  const json = parseJsonDocument(content);
  if (json !== null) return [{ type: 'code', language: 'json', code: json }];

  // Imported issue descriptions sometimes flatten Markdown into one long line.
  // Restore heading boundaries outside fenced code without changing the stored text.
  const normalized = content
    .split(/(```[\s\S]*?```)/g)
    .map((part, index) =>
      index % 2 === 0 ? part.replace(/([^\r\n])\s+(#{1,6})\s+/g, '$1\n\n$2 ') : part,
    )
    .join('');
  const lines = normalized.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    // Mermaid directive blocks may contain indented source without a code fence.
    const mermaidDirective = /^\s*:::\s*mermaid(?:\s+(.+?))?\s*$/.exec(line);
    if (mermaidDirective) {
      const declaration = mermaidDirective[1]?.trim() ?? '';
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^\s*:::\s*$/.test(lines[i]!)) {
        codeLines.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++;

      const nonEmptyLines = codeLines.filter((codeLine) => codeLine.trim().length > 0);
      const indentation = nonEmptyLines.length
        ? Math.min(...nonEmptyLines.map((codeLine) => /^\s*/.exec(codeLine)![0].length))
        : 0;
      const source = codeLines
        .map((codeLine) => codeLine.slice(indentation))
        .join('\n')
        .trim();
      const startsWithDeclaration =
        /^(?:flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline)\b/m.test(
          source,
        );
      const code = [!startsWithDeclaration ? declaration : '', source].filter(Boolean).join('\n');
      if (code.trim().length > 0) {
        blocks.push({ type: 'code', language: 'mermaid', code });
      }
      continue;
    }

    // 1. Code block
    if (line.trim().startsWith('```')) {
      const language = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trim().startsWith('```')) {
        codeLines.push(lines[i]!);
        i++;
      }
      if (i < lines.length) {
        i++; // skip closing ```
      }
      const codeContent = codeLines.join('\n');
      if (codeContent.trim().length > 0) {
        blocks.push({
          type: 'code',
          language,
          code: codeContent,
        });
      }
      continue;
    }

    // 2. Indented code block (4 spaces or tab, standard Markdown / ASCII diagrams)
    if (
      (line.startsWith('    ') || line.startsWith('\t')) &&
      !/^(\s*)([-*+]|\d+\.)\s+/.test(line)
    ) {
      const codeLines: string[] = [];
      while (i < lines.length) {
        const curLine = lines[i]!;
        if (curLine.startsWith('    ') || curLine.startsWith('\t')) {
          const stripped = curLine.startsWith('    ') ? curLine.slice(4) : curLine.slice(1);
          codeLines.push(stripped);
          i++;
        } else if (
          curLine.trim().length === 0 &&
          i + 1 < lines.length &&
          (lines[i + 1]!.startsWith('    ') || lines[i + 1]!.startsWith('\t'))
        ) {
          codeLines.push('');
          i++;
        } else {
          break;
        }
      }
      const codeContent = codeLines.join('\n');
      if (codeContent.trim().length > 0) {
        blocks.push({
          type: 'code',
          language: '',
          code: codeContent,
        });
      }
      continue;
    }

    // Raw HTML block: runs until a blank line once its root element is closed.
    const htmlRoot = htmlBlockRoot(line);
    if (htmlRoot !== null) {
      const htmlLines = [line];
      i++;
      while (
        i < lines.length &&
        (lines[i]!.trim().length > 0 || isHtmlBlockOpen(htmlLines.join('\n'), htmlRoot))
      ) {
        htmlLines.push(lines[i]!);
        i++;
      }
      blocks.push({ type: 'html', html: htmlLines.join('\n') });
      continue;
    }

    // 2. Setext headings
    if (i + 1 < lines.length && line.trim().length > 0) {
      const nextLine = lines[i + 1]!.trim();
      if (/^={2,}$/.test(nextLine)) {
        blocks.push({ type: 'heading', level: 1, text: line.trim() });
        i += 2;
        continue;
      }
      if (/^-{2,}$/.test(nextLine)) {
        blocks.push({ type: 'heading', level: 2, text: line.trim() });
        i += 2;
        continue;
      }
    }

    // 3. ATX Headings
    const headingMatch = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (headingMatch) {
      const level = headingMatch[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: 'heading', level, text: headingMatch[2]! });
      i++;
      continue;
    }

    // 4. Horizontal rule
    if (/^(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line.trim())) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // 5. Blockquote
    if (line.trim().startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('>')) {
        const stripped = lines[i]!.trim().replace(/^>\s?/, '');
        quoteLines.push(stripped);
        i++;
      }
      blocks.push({ type: 'blockquote', text: quoteLines.join('\n') });
      continue;
    }

    // 6. Table
    if (
      line.trim().startsWith('|') &&
      i + 1 < lines.length &&
      lines[i + 1]!.trim().startsWith('|') &&
      lines[i + 1]!.includes('-')
    ) {
      const parseCells = (row: string) =>
        row
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split('|')
          .map((c) => c.trim());

      const headers = parseCells(line);
      const sepRow = parseCells(lines[i + 1]!);
      const alignments: ('left' | 'center' | 'right')[] = sepRow.map((col) => {
        if (col.startsWith(':') && col.endsWith(':')) return 'center';
        if (col.endsWith(':')) return 'right';
        return 'left';
      });

      i += 2; // skip header and separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) {
        rows.push(parseCells(lines[i]!));
        i++;
      }

      blocks.push({ type: 'table', headers, alignments, rows });
      continue;
    }

    // 7. Lists (ordered or unordered)
    const listMatch = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (listMatch) {
      const isOrdered = /^\d+\./.test(listMatch[2]!);
      const itemRegex = isOrdered ? /^(\s*)\d+\.\s+(.*)$/ : /^(\s*)[-*+]\s+(.*)$/;
      const items: { text: string; indent: number; checked?: boolean }[] = [];

      while (i < lines.length) {
        if (lines[i]!.trim().length === 0) {
          if (i + 1 < lines.length && itemRegex.test(lines[i + 1]!)) {
            i++;
            continue;
          }
          break;
        }

        const curLine = lines[i]!;
        const curMatch = itemRegex.exec(curLine);
        if (!curMatch) break;

        const indent = curMatch[1]!.length;
        let itemText = curMatch[2]!;
        let checked: boolean | undefined = undefined;

        // Checkbox detection: - [ ] or - [x]
        const checkMatch = /^\[([ xX])\]\s+(.*)$/.exec(itemText);
        if (checkMatch) {
          checked = checkMatch[1]!.toLowerCase() === 'x';
          itemText = checkMatch[2]!;
        }

        items.push({ text: itemText, indent, checked });
        i++;
      }

      blocks.push({ type: 'list', ordered: isOrdered, items });
      continue;
    }

    // 8. Empty line
    if (line.trim().length === 0) {
      i++;
      continue;
    }

    // 9. Regular Paragraph
    const paraLines: string[] = [lines[i]!.trim()];
    i++;

    while (
      i < lines.length &&
      lines[i]!.trim().length > 0 &&
      !lines[i]!.trim().startsWith('```') &&
      !/^(#{1,6})\s+/.test(lines[i]!.trim()) &&
      !lines[i]!.trim().startsWith('>') &&
      !(
        lines[i]!.trim().startsWith('|') &&
        i + 1 < lines.length &&
        lines[i + 1]!.trim().startsWith('|') &&
        lines[i + 1]!.includes('-')
      ) &&
      !/^(\s*)([-*+]|\d+\.)\s+/.test(lines[i]!) &&
      !/^(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(lines[i]!.trim()) &&
      !(lines[i]!.startsWith('    ') || lines[i]!.startsWith('\t')) &&
      htmlBlockRoot(lines[i]!) === null
    ) {
      paraLines.push(lines[i]!.trim());
      i++;
    }

    blocks.push({ type: 'paragraph', text: paraLines.join(' ') });
  }

  return blocks;
}

export function stripLeadingTitleHeading(content: string, title?: string): string {
  if (!content || !title) return content;
  const cleanTitle = title.trim().toLowerCase();
  const match = content.match(/^#\s+([^\r\n]+)(?:\r?\n|$)/);
  if (match && match[1]?.trim().toLowerCase() === cleanTitle) {
    const afterHeading = content.slice(match[0].length);
    return afterHeading.replace(/^\r?\n+/, '');
  }
  return content;
}
