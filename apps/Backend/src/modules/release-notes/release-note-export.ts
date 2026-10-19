import {
  AlignmentType,
  Document,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  TextRun,
} from 'docx';
import PDFDocument from 'pdfkit';
import type { ReleaseNote } from './release-note-store.js';

export type ExportFormat = 'markdown' | 'pdf' | 'docx';

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'quote'; text: string }
  | { type: 'item'; ordered: boolean; level: number; text: string }
  | { type: 'code'; text: string }
  | { type: 'rule' };
interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

/** Parses the Markdown subset agents produce for release notes. */
export function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
    paragraph = [];
  };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      while (++index < lines.length && !/^\s*```/.test(lines[index]!)) code.push(lines[index]!);
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!line.trim()) flush();
    else if (heading) {
      flush();
      blocks.push({ type: 'heading', level: heading[1]!.length, text: heading[2]! });
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flush();
      blocks.push({ type: 'rule' });
    } else if (item) {
      flush();
      blocks.push({
        type: 'item',
        ordered: /\d/.test(item[2]!),
        level: Math.min(3, Math.floor(item[1]!.replace(/\t/g, '  ').length / 2)),
        text: item[3]!,
      });
    } else if (/^\s*>/.test(line)) {
      flush();
      blocks.push({ type: 'quote', text: line.replace(/^\s*>\s?/, '') });
    } else if (/^\s{2,}\S/.test(line) && blocks.at(-1)?.type === 'item' && !paragraph.length) {
      const last = blocks.at(-1) as Extract<Block, { type: 'item' }>;
      last.text += ` ${line.trim()}`;
    } else paragraph.push(line.trim());
  }
  flush();
  return blocks;
}

/** Splits inline Markdown into styled runs; links keep their URL in parentheses. */
export function parseInline(text: string): Run[] {
  const runs: Run[] = [];
  const pattern = /(\*\*|__)(.+?)\1|(\*|_)(?!\s)(.+?)\3|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) runs.push({ text: text.slice(last, match.index) });
    if (match[2] !== undefined) runs.push({ text: match[2], bold: true });
    else if (match[4] !== undefined) runs.push({ text: match[4], italic: true });
    else if (match[5] !== undefined) runs.push({ text: match[5], code: true });
    else runs.push({ text: `${match[6]} (${match[7]})` });
    last = match.index + match[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length ? runs : [{ text: '' }];
}

export function fileName(note: ReleaseNote, extension: string): string {
  const base =
    [note.title, note.version]
      .filter(Boolean)
      .join(' ')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 100) || 'release-note';
  return `${base}.${extension}`;
}

export function toMarkdown(note: ReleaseNote): string {
  return note.content.endsWith('\n') ? note.content : `${note.content}\n`;
}

const headingLevels = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;
const textRuns = (text: string) =>
  parseInline(text).map(
    (run) =>
      new TextRun({
        text: run.text,
        bold: run.bold,
        italics: run.italic,
        font: run.code ? 'Consolas' : undefined,
      }),
  );

export async function toDocx(note: ReleaseNote): Promise<Buffer> {
  const children = parseBlocks(note.content).map((block) => {
    switch (block.type) {
      case 'heading':
        return new Paragraph({
          heading: headingLevels[block.level - 1],
          children: textRuns(block.text),
        });
      case 'item':
        return new Paragraph({
          children: textRuns(block.text),
          ...(block.ordered
            ? { numbering: { reference: 'ordered', level: block.level } }
            : { bullet: { level: block.level } }),
        });
      case 'quote':
        return new Paragraph({ children: textRuns(block.text), indent: { left: 720 } });
      case 'code':
        return new Paragraph({
          children: block.text
            .split('\n')
            .map(
              (line, index) => new TextRun({ text: line, font: 'Consolas', break: index ? 1 : 0 }),
            ),
        });
      case 'rule':
        return new Paragraph({ border: { bottom: { style: 'single', size: 6, color: '999999' } } });
      default:
        return new Paragraph({ children: textRuns(block.text) });
    }
  });
  const document = new Document({
    title: note.title,
    numbering: {
      config: [
        {
          reference: 'ordered',
          levels: [0, 1, 2, 3].map((level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children }],
  });
  return Packer.toBuffer(document);
}

// The standard PDF fonts only cover WinAnsi; map common symbols and drop the rest (e.g. emoji).
const winAnsiExtras = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const replacements: Record<string, string> = { '→': '->', '←': '<-', '✓': 'v', '✔': 'v', '✅': '' };
function pdfText(text: string): string {
  return [...text]
    .map((char) =>
      char.charCodeAt(0) <= 0xff || winAnsiExtras.has(char) ? char : (replacements[char] ?? ''),
    )
    .join('');
}

export function toPdf(note: ReleaseNote): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: 56, info: { Title: note.title } });
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);
    // Starting at x with an explicit width keeps wrapped lines indented.
    const write = (text: string, size: number, x: number) => {
      const runs = parseInline(text);
      const width = pdf.page.width - pdf.page.margins.right - x;
      runs.forEach((run, index) => {
        pdf
          .font(
            run.code
              ? 'Courier'
              : run.bold
                ? 'Helvetica-Bold'
                : run.italic
                  ? 'Helvetica-Oblique'
                  : 'Helvetica',
          )
          .fontSize(size);
        const options = { width, continued: index < runs.length - 1 };
        if (index === 0) pdf.text(pdfText(run.text), x, pdf.y, options);
        else pdf.text(pdfText(run.text), options);
      });
    };
    const left = pdf.page.margins.left;
    // Numbering per nesting level; a level restarts when its list kind changes.
    const counters: { ordered: boolean; count: number }[] = [];
    for (const block of parseBlocks(note.content)) {
      if (block.type !== 'item' && counters.length) {
        counters.length = 0;
        pdf.moveDown(0.5);
      }
      if (block.type === 'heading') {
        pdf.moveDown(0.6);
        pdf.font('Helvetica-Bold').fontSize([20, 16, 13, 12, 11, 11][block.level - 1]!);
        pdf.text(
          pdfText(
            parseInline(block.text)
              .map((run) => run.text)
              .join(''),
          ),
          left,
        );
        pdf.moveDown(0.3);
      } else if (block.type === 'item') {
        counters.length = block.level + 1;
        const current = counters[block.level];
        const count = current?.ordered === block.ordered ? current.count + 1 : 1;
        counters[block.level] = { ordered: block.ordered, count };
        const x = left + 12 + block.level * 16;
        const y = pdf.y;
        pdf
          .font('Helvetica')
          .fontSize(11)
          .text(block.ordered ? `${count}.` : '•', x, y, { lineBreak: false });
        pdf.y = y;
        write(block.text, 11, x + (block.ordered ? 16 : 10));
        pdf.x = left;
        pdf.moveDown(0.15);
      } else if (block.type === 'code') {
        pdf
          .font('Courier')
          .fontSize(9.5)
          .text(pdfText(block.text), left + 12);
        pdf.x = left;
        pdf.moveDown(0.5);
      } else if (block.type === 'rule') {
        pdf.moveDown(0.4);
        pdf
          .moveTo(left, pdf.y)
          .lineTo(pdf.page.width - pdf.page.margins.right, pdf.y)
          .strokeColor('#999999')
          .stroke();
        pdf.moveDown(0.6);
      } else {
        if (block.type === 'quote') pdf.fillColor('#555555');
        write(block.text, 11, block.type === 'quote' ? left + 16 : left);
        pdf.fillColor('#000000');
        pdf.x = left;
        pdf.moveDown(0.5);
      }
    }
    pdf.end();
  });
}
