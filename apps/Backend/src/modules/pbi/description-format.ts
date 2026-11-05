/**
 * ADK descriptions are either HTML (rich editor, imported work items) or Markdown (Brain notes,
 * agents). Providers render one of them, or let the person choose (Azure DevOps), so the push
 * converts the description to the format the destination displays.
 */
export type DescriptionFormat = 'html' | 'markdown';

export function isHtmlDescription(value: string): boolean {
  return /<\/?[a-z][^>]*>/i.test(value);
}

/** The description in the requested format; empty and already matching values are kept. */
export function descriptionAs(value: string, format: DescriptionFormat): string {
  if (!value.trim()) return value;
  const html = isHtmlDescription(value);
  if (format === 'html') return html ? value : markdownToHtml(value);
  return html ? htmlToMarkdown(value) : value;
}

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const safeUrl = (url: string): string => (/^\s*(javascript|vbscript|data):/i.test(url) ? '#' : url);

function inlineMarkdown(text: string): string {
  const codes: string[] = [];
  const withoutCode = text.replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  return (
    escapeHtml(withoutCode)
      .replace(
        /!\[([^\]]*)\]\(([^)\s]+)\)/g,
        (_, alt: string, src: string) => `<img src="${safeUrl(src)}" alt="${alt}">`,
      )
      .replace(
        /\[([^\]]+)\]\(([^)\s]+)\)/g,
        (_, label: string, href: string) => `<a href="${safeUrl(href)}">${label}</a>`,
      )
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>')
      .replace(/(^|[^\w*])\*(?=\S)([^*]*?\S)\*(?![\w*])/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_(?=\S)([^_]*?\S)_(?!\w)/g, '$1<em>$2</em>')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>')
      // The marker is a control character so that no document text can collide with it.
      // eslint-disable-next-line no-control-regex
      .replace(/\u0000(\d+)\u0000/g, (_, index: string) => codes[Number(index)]!)
  );
}

const listItemPattern = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const tableDividerPattern = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const tableCells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((cell) => cell.trim());

function listHtml(entries: readonly { indent: number; ordered: boolean; text: string }[]): string {
  let html = '';
  const open: { indent: number; tag: string }[] = [];
  for (const entry of entries) {
    while (open.length > 1 && entry.indent < open.at(-1)!.indent)
      html += `</li></${open.pop()!.tag}>`;
    const top = open.at(-1);
    if (!top || entry.indent > top.indent) {
      const tag = entry.ordered ? 'ol' : 'ul';
      open.push({ indent: entry.indent, tag });
      html += `<${tag}><li>`;
    } else html += '</li><li>';
    const task = entry.text.match(/^\[([ xX])\]\s+(.*)$/);
    html += task
      ? `${task[1] === ' ' ? '☐' : '☑'} ${inlineMarkdown(task[2]!)}`
      : inlineMarkdown(entry.text);
  }
  while (open.length) html += `</li></${open.pop()!.tag}>`;
  return html;
}

export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks: string[] = [];
  const startsBlock = (line: string): boolean =>
    /^\s*(```|~~~|#{1,6}\s|>)/.test(line) || listItemPattern.test(line);
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.trim().startsWith(fence[1]!))
        code.push(lines[index++]!);
      index += 1;
      blocks.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1]!.length;
      blocks.push(`<h${level}>${inlineMarkdown(heading[2]!)}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push('<hr>');
      index += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index]!))
        quoted.push(lines[index++]!.replace(/^\s*>\s?/, ''));
      blocks.push(`<blockquote>${markdownToHtml(quoted.join('\n'))}</blockquote>`);
      continue;
    }
    if (line.includes('|') && tableDividerPattern.test(lines[index + 1] ?? '')) {
      const header = tableCells(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index]!.includes('|'))
        rows.push(tableCells(lines[index++]!));
      blocks.push(
        `<table><thead><tr>${header.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('')}</tr></thead>` +
          `<tbody>${rows
            .map(
              (row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`,
            )
            .join('')}</tbody></table>`,
      );
      continue;
    }
    if (listItemPattern.test(line)) {
      const entries: { indent: number; ordered: boolean; text: string }[] = [];
      while (index < lines.length && lines[index]!.trim()) {
        const item = lines[index]!.match(listItemPattern);
        if (item)
          entries.push({
            indent: item[1]!.replace(/\t/g, '    ').length,
            ordered: /\d/.test(item[2]!),
            text: item[3]!,
          });
        else if (/^\s/.test(lines[index]!)) entries.at(-1)!.text += ` ${lines[index]!.trim()}`;
        else break;
        index += 1;
      }
      blocks.push(listHtml(entries));
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index]!.trim() &&
      (!paragraph.length || !startsBlock(lines[index]!))
    )
      paragraph.push(lines[index++]!.trim());
    blocks.push(`<p>${paragraph.map(inlineMarkdown).join('<br>')}</p>`);
  }
  return blocks.join('');
}

interface HtmlElement {
  readonly tag: string;
  readonly attributes: Record<string, string>;
  readonly children: HtmlNode[];
}
type HtmlNode = HtmlElement | string;

const voidTags = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'wbr', 'source']);
const namedEntities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};
const decodeEntities = (value: string): string =>
  value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (entity, code: string) => {
    if (code[0] === '#')
      return String.fromCodePoint(
        code[1]!.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)),
      );
    return namedEntities[code.toLowerCase()] ?? entity;
  });

function parseHtml(html: string): HtmlElement {
  const root: HtmlElement = { tag: '#root', attributes: {}, children: [] };
  const stack: HtmlElement[] = [root];
  const pattern =
    /<!--[\s\S]*?-->|<(\/?)([a-z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>|[^<]+|</gi;
  for (const match of html.matchAll(pattern)) {
    const [token, closing, rawTag, rawAttributes, selfClosing] = match;
    if (token.startsWith('<!--')) continue;
    if (!rawTag) {
      stack.at(-1)!.children.push(decodeEntities(token));
      continue;
    }
    const tag = rawTag.toLowerCase();
    if (closing) {
      const openIndex = stack.map((element) => element.tag).lastIndexOf(tag);
      if (openIndex > 0) stack.length = openIndex;
      continue;
    }
    const attributes: Record<string, string> = {};
    for (const attribute of rawAttributes!.matchAll(
      /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g,
    ))
      attributes[attribute[1]!.toLowerCase()] = decodeEntities(
        attribute[2] ?? attribute[3] ?? attribute[4] ?? '',
      );
    const element: HtmlElement = { tag, attributes, children: [] };
    stack.at(-1)!.children.push(element);
    if (!voidTags.has(tag) && !selfClosing) stack.push(element);
  }
  return root;
}

const textContent = (node: HtmlNode): string =>
  typeof node === 'string'
    ? node
    : node.tag === 'br'
      ? '\n'
      : node.children.map(textContent).join('');
const descendants = (node: HtmlElement, tags: readonly string[]): HtmlElement[] =>
  node.children.flatMap((child) =>
    typeof child === 'string' ? [] : tags.includes(child.tag) ? [child] : descendants(child, tags),
  );
const block = (content: string): string => (content.trim() ? `\n\n${content.trim()}\n\n` : '');
const wrap = (marker: string, content: string): string =>
  content.trim() ? `${marker}${content.trim()}${marker}` : content;

function markdownOf(node: HtmlNode): string {
  if (typeof node === 'string') return node.replace(/\s+/g, ' ');
  const inner = (): string => node.children.map(markdownOf).join('');
  switch (node.tag) {
    case 'br':
      return '  \n';
    case 'hr':
      return '\n\n---\n\n';
    case 'strong':
    case 'b':
      return wrap('**', inner());
    case 'em':
    case 'i':
      return wrap('_', inner());
    case 'del':
    case 's':
    case 'strike':
      return wrap('~~', inner());
    case 'code':
      return `\`${textContent(node)}\``;
    case 'pre':
      return `\n\n\`\`\`\n${textContent(node).replace(/\n$/, '')}\n\`\`\`\n\n`;
    case 'a':
      return node.attributes.href ? `[${inner().trim()}](${node.attributes.href})` : inner();
    case 'img':
      return node.attributes.src ? `![${node.attributes.alt ?? ''}](${node.attributes.src})` : '';
    case 'input':
      return node.attributes.type === 'checkbox'
        ? `[${'checked' in node.attributes ? 'x' : ' '}] `
        : '';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return block(`${'#'.repeat(Number(node.tag[1]))} ${inner().trim()}`);
    case 'blockquote':
      return block(
        inner()
          .trim()
          .replace(/\n{3,}/g, '\n\n')
          .split('\n')
          .map((line) => `> ${line}`.trimEnd())
          .join('\n'),
      );
    case 'ul':
    case 'ol': {
      const items = node.children.filter(
        (child): child is HtmlElement => typeof child !== 'string' && child.tag === 'li',
      );
      return block(
        items
          .map((item, position) => {
            const marker = node.tag === 'ol' ? `${position + 1}. ` : '- ';
            const [first = '', ...rest] = markdownOf(item)
              .trim()
              .replace(/\n{2,}/g, '\n')
              .replace(/^(\[[ x]\]) +/, '$1 ')
              .split('\n');
            return [marker + first, ...rest.map((line) => ' '.repeat(marker.length) + line)].join(
              '\n',
            );
          })
          .join('\n'),
      );
    }
    case 'table': {
      const rows = descendants(node, ['tr']).map((row) =>
        descendants(row, ['th', 'td']).map((cell) =>
          markdownOf(cell)
            .trim()
            .replace(/\s*\n\s*/g, ' ')
            .replaceAll('|', '\\|'),
        ),
      );
      if (!rows.length) return '';
      const width = Math.max(...rows.map((row) => row.length));
      const line = (row: string[]) =>
        `| ${Array.from({ length: width }, (_, cell) => row[cell] ?? '').join(' | ')} |`;
      return block(
        [
          line(rows[0]!),
          line(Array.from({ length: width }, () => '---')),
          ...rows.slice(1).map(line),
        ].join('\n'),
      );
    }
    case 'script':
    case 'style':
      return '';
    case 'p':
    case 'div':
    case 'section':
    case 'article':
    case 'header':
    case 'footer':
      return block(inner());
    default:
      return inner();
  }
}

export function htmlToMarkdown(html: string): string {
  return markdownOf(parseHtml(html))
    .split('\n')
    .map((line) => (line.endsWith('  ') && line.trim() ? line : line.trimEnd()))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
