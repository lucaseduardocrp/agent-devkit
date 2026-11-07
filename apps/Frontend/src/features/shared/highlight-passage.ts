/** Name of the CSS highlight (`::highlight(adk-passage)` in index.css). */
const HIGHLIGHT = 'adk-passage';

interface Position {
  readonly node: Text;
  readonly offset: number;
}

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}

const registry = (): HighlightRegistry | undefined =>
  (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS?.highlights;

/** Letters and digits only, lowercase: markdown marks and spacing differ from the rendered text. */
const keep = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** The passage as it reads once rendered: links keep their text, not their address. */
const normalize = (passage: string): string =>
  keep(passage.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1'));

/** The letters and digits of everything rendered under `root`, each with where it sits. */
function index(root: HTMLElement): { text: string; positions: Position[] } {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest('script, style')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  let text = '';
  const positions: Position[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? '';
    for (let offset = 0; offset < value.length; offset += 1) {
      const kept = keep(value.charAt(offset));
      for (let char = 0; char < kept.length; char += 1)
        positions.push({ node: node as Text, offset });
      text += kept;
    }
  }
  return { text, positions };
}

/** A long passage that does not match whole is looked for by its start. */
const PREFIX = 120;

/**
 * Highlights `passage` inside the rendered `root` and scrolls it into view. Returns whether it
 * was found, so the caller can try again while the content is still rendering.
 */
export function highlightPassage(root: HTMLElement, passage: string): boolean {
  const needle = normalize(passage);
  if (!needle) return false;
  const { text, positions } = index(root);
  let length = needle.length;
  let start = text.indexOf(needle);
  if (start < 0) {
    length = Math.min(needle.length, PREFIX);
    start = text.indexOf(needle.slice(0, length));
  }
  const first = positions[start];
  const last = positions[start + length - 1];
  if (start < 0 || !first || !last) return false;
  const range = document.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  const highlights = registry();
  const Marker = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (highlights && Marker) highlights.set(HIGHLIGHT, new Marker(range));
  first.node.parentElement?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  return true;
}

export function clearPassageHighlight(): void {
  registry()?.delete(HIGHLIGHT);
}
