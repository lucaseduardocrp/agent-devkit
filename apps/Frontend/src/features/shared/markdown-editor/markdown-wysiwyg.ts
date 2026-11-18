import { INLINE_HTML_TAG, sanitizeHtml } from '../../../lib/sanitize-html.js';
import { isSafeImageSource } from '../media.js';
import {
  INLINE_REGEX,
  parseMarkdownBlocks,
  type MarkdownBlock,
} from '../../brain/markdown-parser.js';

/**
 * Two-way bridge between Markdown and the DOM of the formatted editor. The Markdown text stays
 * the source of truth: `markdownToEditorHtml` renders it for editing and `editorToMarkdown`
 * writes the edited DOM back. Constructs the editor cannot edit (raw HTML blocks, wikilinks)
 * are kept as atoms that carry their Markdown in `data-md-raw` and are written back verbatim.
 */

const RAW = 'data-md-raw';
const NBSP_PATTERN = new RegExp(String.fromCharCode(0xa0), 'g');
const ZERO_WIDTH_PATTERN = new RegExp(String.fromCharCode(0x200b), 'g');
const WIKILINK_CLASS =
  'inline-flex items-center rounded border border-[#2b3e58] bg-[#1c2838] px-1.5 py-0.5 text-xs font-medium text-[#62a3f8]';
const SAFE_LINK = /^(https?:\/\/|mailto:|tel:|\/|#|\.\.?\/)/i;
const ATOM_START = String.fromCharCode(0xe000);
const ATOM_END = String.fromCharCode(0xe001);

export const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---------------------------------------------------------------------------------------------
// Markdown -> editor HTML
// ---------------------------------------------------------------------------------------------

/** Text between tokens: inline HTML tags are kept (and sanitized later), the rest is escaped. */
function plainHtml(text: string): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(new RegExp(INLINE_HTML_TAG.source, 'gi'))) {
    out += escapeHtml(text.slice(last, match.index)) + match[0];
    last = match.index + match[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

function inlineHtml(text: string, atoms: string[]): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(new RegExp(INLINE_REGEX.source, 'g'))) {
    const token = match[0];
    out += plainHtml(text.slice(last, match.index));
    last = match.index + token.length;
    if (token.startsWith('`')) {
      out += `<code>${escapeHtml(token.slice(1, -1))}</code>`;
    } else if (token.startsWith('![')) {
      const image = /^!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+[^)]*)?\)$/.exec(token)!;
      out += isSafeImageSource(image[2]!)
        ? `<img src="${escapeHtml(image[2]!)}" alt="${escapeHtml(image[1]!)}">`
        : escapeHtml(image[1]!);
    } else if (token.startsWith('***') || token.startsWith('___')) {
      out += `<strong><em>${escapeHtml(token.slice(3, -3))}</em></strong>`;
    } else if (token.startsWith('**') || token.startsWith('__')) {
      out += `<strong>${inlineHtml(token.slice(2, -2), atoms)}</strong>`;
    } else if (token.startsWith('~~')) {
      out += `<del>${inlineHtml(token.slice(2, -2), atoms)}</del>`;
    } else if (token.startsWith('[[')) {
      const [target, label] = token.slice(2, -2).split('|');
      atoms.push(
        `<span ${RAW}="${escapeHtml(token)}" contenteditable="false" class="${WIKILINK_CLASS}">${escapeHtml(label ?? target!)}</span>`,
      );
      out += `${ATOM_START}${atoms.length - 1}${ATOM_END}`;
    } else if (token.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      const href = link[2]!.trim();
      out += SAFE_LINK.test(href)
        ? `<a href="${escapeHtml(href)}">${escapeHtml(link[1]!)}</a>`
        : escapeHtml(link[1]!);
    } else {
      out += `<em>${inlineHtml(token.slice(1, -1), atoms)}</em>`;
    }
  }
  return out + plainHtml(text.slice(last));
}

/** Inline Markdown as sanitized editor HTML. */
function inlineToHtml(text: string): string {
  const atoms: string[] = [];
  return sanitizeHtml(inlineHtml(text, atoms)).replace(
    new RegExp(`${ATOM_START}(\\d+)${ATOM_END}`, 'g'),
    (_, index: string) => atoms[Number(index)]!,
  );
}

type ListBlock = Extract<MarkdownBlock, { type: 'list' }>;

function listToHtml(block: ListBlock): string {
  const tag = block.ordered ? 'ol' : 'ul';
  const open: number[] = [];
  let html = '';
  for (const item of block.items) {
    if (!open.length || item.indent > open.at(-1)!) {
      html += `<${tag}>`;
      open.push(item.indent);
    } else {
      html += '</li>';
      while (open.length > 1 && item.indent < open.at(-1)!) {
        html += `</${tag}></li>`;
        open.pop();
      }
    }
    const checkbox =
      item.checked === undefined ? '' : `<input type="checkbox"${item.checked ? ' checked' : ''}> `;
    html += `<li>${checkbox}${inlineToHtml(item.text)}`;
  }
  html += '</li>';
  while (open.length > 1) {
    html += `</${tag}></li>`;
    open.pop();
  }
  return `${html}</${tag}>`;
}

function blockToHtml(block: MarkdownBlock): string {
  switch (block.type) {
    case 'heading':
      return `<h${block.level}>${inlineToHtml(block.text)}</h${block.level}>`;
    case 'paragraph':
      return `<p>${inlineToHtml(block.text)}</p>`;
    case 'list':
      return listToHtml(block);
    case 'code':
      return `<pre data-lang="${escapeHtml(block.language)}"><code>${escapeHtml(block.code)}</code></pre>`;
    case 'blockquote':
      return `<blockquote>${block.text
        .split('\n')
        .map((line) => `<p>${inlineToHtml(line)}</p>`)
        .join('')}</blockquote>`;
    case 'hr':
      return '<hr>';
    case 'html':
      return `<div ${RAW}="${escapeHtml(block.html)}" contenteditable="false">${sanitizeHtml(block.html)}</div>`;
    case 'table': {
      const cell = (tag: string, text: string, index: number) =>
        `<${tag} data-align="${block.alignments[index] ?? 'left'}">${inlineToHtml(text)}</${tag}>`;
      const head = block.headers.map((text, index) => cell('th', text, index)).join('');
      const body = block.rows
        .map(
          (row) =>
            `<tr>${block.headers.map((_, index) => cell('td', row[index] ?? '', index)).join('')}</tr>`,
        )
        .join('');
      return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    }
  }
}

/** HTML the formatted editor shows for a Markdown document. */
export function markdownToEditorHtml(markdown: string): string {
  const blocks = parseMarkdownBlocks(markdown);
  return blocks.length ? blocks.map(blockToHtml).join('') : '<p><br></p>';
}

// ---------------------------------------------------------------------------------------------
// Editor DOM -> Markdown
// ---------------------------------------------------------------------------------------------

const BLOCK_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'DIV', 'UL', 'OL']);
const BLOCK_ONLY_TAGS = new Set(['PRE', 'TABLE', 'BLOCKQUOTE', 'HR']);
const FORMAT_SELECTOR = 'strong,b,em,i,del,s,strike,code,a,img,mark,u,span,font,sub,sup,kbd';

function toHex(color: string): string | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex) return `#${hex[1]!.toLowerCase()}`;
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color);
  return rgb
    ? `#${[rgb[1], rgb[2], rgb[3]].map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`
    : null;
}

/** Keeps the spaces outside the markers, where Markdown needs them (`**a **` is not bold). */
function wrapInline(marker: string, content: string, close = marker): string {
  const parts = /^(\s*)([\s\S]*?)(\s*)$/.exec(content)!;
  return parts[2] ? `${parts[1]}${marker}${parts[2]}${close}${parts[3]}` : content;
}

function emphasis(node: HTMLElement, marker: string, tag: string): string {
  const inner = inlineNodes(node.childNodes);
  const only =
    node.children.length === 1 && node.childNodes.length === 1 ? node.children[0]! : null;
  if (
    marker !== '~~' &&
    only &&
    /^(STRONG|B|EM|I)$/.test(only.tagName) &&
    (marker === '**') !== /^(STRONG|B)$/.test(only.tagName) &&
    !only.querySelector(FORMAT_SELECTOR)
  ) {
    return wrapInline('***', only.textContent);
  }
  return node.querySelector(FORMAT_SELECTOR)
    ? wrapInline(`<${tag}>`, inner, `</${tag}>`)
    : wrapInline(marker, inner);
}

function styledInline(node: HTMLElement, inner: string): string {
  const color = toHex(node.style.color || node.getAttribute('color') || '');
  const background = node.style.backgroundColor;
  let out = inner;
  if (color) out = wrapInline(`<span style="color: ${color}">`, out, '</span>');
  if (background && background !== 'transparent' && !/^rgba\(.*,\s*0\)$/.test(background)) {
    out = wrapInline('<mark>', out, '</mark>');
  }
  return out;
}

function inlineNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node
      .textContent!.replace(NBSP_PATTERN, ' ')
      .replace(ZERO_WIDTH_PATTERN, '')
      .replace(/\s*\n\s*/g, ' ');
  }
  if (!(node instanceof HTMLElement)) return '';
  const raw = node.getAttribute(RAW);
  if (raw !== null) return raw;
  const inner = () => inlineNodes(node.childNodes);
  switch (node.tagName) {
    case 'STRONG':
    case 'B':
      return emphasis(node, '**', 'strong');
    case 'EM':
    case 'I':
      return emphasis(node, '*', 'em');
    case 'DEL':
    case 'S':
    case 'STRIKE':
      return emphasis(node, '~~', 'del');
    case 'CODE':
      return wrapInline('`', node.textContent);
    case 'A': {
      const href = node.getAttribute('href');
      return href ? `[${inner()}](${href})` : inner();
    }
    case 'IMG': {
      const src = node.getAttribute('data-adk-src') ?? node.getAttribute('src') ?? '';
      return src ? `![${node.getAttribute('alt') ?? ''}](${src})` : '';
    }
    case 'BR':
      return '<br>';
    case 'U':
    case 'MARK':
    case 'SUB':
    case 'SUP':
    case 'KBD':
    case 'SMALL': {
      const tag = node.tagName.toLowerCase();
      return wrapInline(`<${tag}>`, inner(), `</${tag}>`);
    }
    case 'SPAN':
    case 'FONT':
      return styledInline(node, inner());
    case 'INPUT':
      return '';
    default:
      return inner();
  }
}

function inlineNodes(nodes: Iterable<Node>): string {
  return [...nodes].map(inlineNode).join('');
}

/** Inline content of a block, without the `<br>` browsers leave at its ends. */
function blockInline(nodes: Iterable<Node>): string {
  return inlineNodes(nodes)
    .replace(/^(?:<br>\s*)+|(?:\s*<br>)+\s*$/g, '')
    .trim();
}

/** Text of a code block: `<br>` and line `<div>`s that browsers add are line breaks. */
function codeText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent!.replace(ZERO_WIDTH_PATTERN, '');
  if (!(node instanceof HTMLElement)) return '';
  if (node.tagName === 'BR') return '\n';
  const text = [...node.childNodes].map(codeText).join('');
  return node.tagName === 'DIV' && node.previousSibling ? `\n${text}` : text;
}

function listMarkdown(list: HTMLElement, depth: number): string {
  const ordered = list.tagName === 'OL';
  return [...list.children]
    .filter((item) => item.tagName === 'LI')
    .map((item, index) => {
      const nested = [...item.children].filter(
        (child) => child.tagName === 'UL' || child.tagName === 'OL',
      ) as HTMLElement[];
      const checkbox = [...item.children].find(
        (child): child is HTMLInputElement =>
          child instanceof HTMLInputElement && child.type === 'checkbox',
      );
      const skipped = new Set<Node>([...nested, ...(checkbox ? [checkbox] : [])]);
      const content = blockInline([...item.childNodes].filter((child) => !skipped.has(child)));
      const task = checkbox ? (checkbox.checked ? '[x] ' : '[ ] ') : '';
      return [
        `${'  '.repeat(depth)}${ordered ? `${index + 1}.` : '-'} ${task}${content}`,
        ...nested.map((child) => listMarkdown(child, depth + 1)),
      ].join('\n');
    })
    .join('\n');
}

function tableMarkdown(table: HTMLElement): string {
  const lines = [...table.querySelectorAll('tr')];
  if (!lines.length) return '';
  const rows = lines.map((row) => [...row.children].map((cell) => blockInline(cell.childNodes)));
  const head = rows[0]!;
  const alignments = [...lines[0]!.children].map((cell) => cell.getAttribute('data-align'));
  const line = (cells: readonly string[]) =>
    `| ${head.map((_, index) => cells[index] ?? '').join(' | ')} |`;
  const separator = head.map((_, index) => {
    const align = alignments[index];
    return align === 'center' ? ':---:' : align === 'right' ? '---:' : '---';
  });
  return [line(head), `| ${separator.join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

function blockNode(node: HTMLElement): string {
  const raw = node.getAttribute(RAW);
  if (raw !== null) return raw;
  switch (node.tagName) {
    case 'UL':
    case 'OL':
      return listMarkdown(node, 0);
    case 'PRE': {
      const code = codeText(node).replace(/\n+$/, '');
      return code.trim() ? `\`\`\`${node.getAttribute('data-lang') ?? ''}\n${code}\n\`\`\`` : '';
    }
    case 'TABLE':
      return tableMarkdown(node);
    case 'BLOCKQUOTE':
      return blockNodes(node.childNodes)
        .join('\n\n')
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    case 'HR':
      return '---';
    default: {
      const heading = /^H([1-6])$/.exec(node.tagName);
      return heading
        ? `${'#'.repeat(Number(heading[1]))} ${blockInline(node.childNodes)}`
        : blockNodes(node.childNodes).join('\n\n');
    }
  }
}

function blockNodes(nodes: Iterable<Node>): string[] {
  const out: string[] = [];
  let run: Node[] = [];
  const flush = () => {
    const text = blockInline(run);
    if (text) out.push(text);
    run = [];
  };
  for (const node of nodes) {
    if (
      node instanceof HTMLElement &&
      (BLOCK_TAGS.has(node.tagName) || BLOCK_ONLY_TAGS.has(node.tagName))
    ) {
      flush();
      const markdown = blockNode(node);
      if (markdown) out.push(markdown);
    } else {
      run.push(node);
    }
  }
  flush();
  return out;
}

/** Markdown of the edited DOM. */
export function editorToMarkdown(root: HTMLElement): string {
  return blockNodes(root.childNodes).join('\n\n');
}

// ---------------------------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------------------------

export interface OutlineEntry {
  readonly level: number;
  readonly text: string;
}

/** Headings of a document, in the order the formatted editor shows them. */
export function markdownOutline(markdown: string): OutlineEntry[] {
  return parseMarkdownBlocks(markdown).flatMap((block) =>
    block.type === 'heading'
      ? [
          {
            level: block.level,
            text: block.text
              .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
              .replace(/[*_`~]/g, '')
              .trim(),
          },
        ]
      : [],
  );
}

/** Where each heading of `outline` starts in the Markdown source (0 when it cannot be found). */
export function outlineOffsets(markdown: string, headings: readonly OutlineEntry[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of markdown.split('\n')) {
    const heading = headings[offsets.length];
    if (
      heading &&
      line
        .replace(/^\s*#{1,6}\s+/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`~]/g, '')
        .trim() === heading.text
    ) {
      offsets.push(offset);
    }
    offset += line.length + 1;
  }
  return headings.map((_, index) => offsets[index] ?? 0);
}
