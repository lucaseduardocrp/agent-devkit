import { editorToMarkdown } from '../shared/markdown-editor/markdown-wysiwyg.js';
import { sanitizeRichText } from './test-case-fields.js';

/** Block tags only the old rich text editor wrote; Markdown does not use them. */
const RICH_TEXT_BLOCKS = /<\/?(?:p|div|ul|ol|li|h[1-6])\b/i;

/** Characters that draw the boxes and arrows of a text diagram. */
const DIAGRAM_CHARS = /[─│┌┐└┘├┤┬┴┼▼▶▲◄►]/;
const FENCE = /^\s*(?:```|~~~)/;

/**
 * Puts the text diagrams (boxes and arrows drawn with characters) in code blocks. As plain
 * paragraphs Markdown would join their lines and collapse the spaces, which breaks the drawing;
 * in a code block each line and every space stays where it is. Diagrams already in a code block
 * are left alone.
 */
export function fenceDiagrams(markdown: string): string {
  if (!DIAGRAM_CHARS.test(markdown)) return markdown;
  // A diagram written on one line break at a time may use <br> instead of a new line.
  const lines = markdown
    .split(/\r?\n/)
    .flatMap((line) => (DIAGRAM_CHARS.test(line) ? line.split(/<br\s*\/?>/i) : [line]));
  const out: string[] = [];
  let diagram: string[] = [];
  // Blank lines after a diagram line: they belong to it only when another diagram line follows.
  let blanks: string[] = [];
  let inFence = false;

  const closeDiagram = () => {
    if (diagram.length) {
      if (out.length && out.at(-1)!.trim()) out.push('');
      out.push('```', ...diagram, '```', '');
      diagram = [];
    }
    out.push(...blanks);
    blanks = [];
  };

  for (const line of lines) {
    if (FENCE.test(line)) {
      closeDiagram();
      inFence = !inFence;
      out.push(line);
    } else if (inFence) {
      out.push(line);
    } else if (DIAGRAM_CHARS.test(line)) {
      diagram = diagram.length ? [...diagram, ...blanks, line] : [line];
      blanks = [];
    } else if (!line.trim() && diagram.length) {
      blanks.push(line);
    } else {
      closeDiagram();
      out.push(line);
    }
  }
  closeDiagram();
  // The blank line that follows a closing fence is only needed when text follows it.
  while (out.at(-1) === '') out.pop();
  return out.join('\n') + (/\n$/.test(markdown) ? '\n' : '');
}

/**
 * The description of a test case as Markdown, which is what the editor of the case writes. Cases
 * saved by the old rich text editor (or brought from a platform) hold HTML; they are converted
 * once, when opened, and are saved as Markdown from then on. Text diagrams go in code blocks.
 */
export function scenarioToMarkdown(scenario: string): string {
  if (!RICH_TEXT_BLOCKS.test(scenario)) return fenceDiagrams(scenario);
  const box = document.createElement('div');
  box.innerHTML = sanitizeRichText(scenario);
  return fenceDiagrams(editorToMarkdown(box));
}
