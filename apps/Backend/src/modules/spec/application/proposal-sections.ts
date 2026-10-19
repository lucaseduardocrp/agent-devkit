import type { Specification } from '../domain/specification.js';

type Section = Specification['sections'][number];
type ProposalCandidate = {
  templateSectionId?: unknown;
  id?: unknown;
  title?: unknown;
  content?: unknown;
};

function decodeVisibleEscapes(text: string): string {
  if (text.includes('\n') || !text.includes('\\n')) return text;
  return text
    .replaceAll('\\r\\n', '\n')
    .replaceAll('\\n', '\n')
    .replaceAll('\\t', '\t')
    .replaceAll('\\"', '"');
}

function expandCandidate(candidate: unknown): readonly ProposalCandidate[] {
  if (!candidate || typeof candidate !== 'object') return [];
  const value = candidate as ProposalCandidate;
  if (typeof value.content !== 'string') return [value];
  const decoded = decodeVisibleEscapes(value.content).trim();
  const unfenced = decoded.replace(/^```(?:json|spec-update)?\s*\n?/iu, '').replace(/\n?```$/u, '');
  if (/^[{[]/u.test(unfenced)) {
    try {
      // Text starting with `{` or `[` only parses to an object or an array.
      const object = JSON.parse(unfenced) as { sections?: unknown; content?: unknown };
      if (Array.isArray(object.sections)) return object.sections.flatMap(expandCandidate);
      if (typeof object.content === 'string') {
        return [{ ...value, content: decodeVisibleEscapes(object.content) }];
      }
    } catch {
      // Keep malformed agent output as readable Markdown after decoding visible escapes.
    }
  }
  return [{ ...value, content: decoded }];
}
const normalize = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, '');
const concepts = [
  /problem|problema|objective|objetivo|context|contexto|scope|escopo/,
  /actor|ator|atores|persona|stakeholder/,
  /requirement|requisito|businessrule|regras?|regradenegocio|regrasdenegocio/,
  /acceptance|aceite|aceitacao/,
  /dependenc|impact/,
];

function matchSection(reference: string, sections: readonly Section[]): Section | undefined {
  const key = normalize(reference);
  const exact = sections.find((section) =>
    [section.templateSectionId, section.title].some((value) => normalize(value) === key),
  );
  if (exact) return exact;
  const concept = concepts.find((pattern) => pattern.test(key));
  return (
    concept &&
    sections.find(
      (section) =>
        concept.test(normalize(section.title)) ||
        concept.test(normalize(section.templateSectionId)),
    )
  );
}

/** Preserve Markdown bodies, including fenced code, while routing headings to existing fields. */
export function distributeProposalSections(
  candidates: readonly unknown[],
  sections: readonly Section[],
) {
  const last = sections.at(-1);
  if (!last) return [];
  const mapped = new Map<string, string[]>();
  const unmatched: string[] = [];
  for (const candidate of candidates.flatMap(expandCandidate)) {
    const value = candidate;
    if (typeof value.content !== 'string' || !value.content.trim()) continue;
    const destination = [value.templateSectionId, value.id, value.title]
      .filter((item): item is string => typeof item === 'string')
      .map((reference) => matchSection(reference, sections))
      .find(Boolean);
    let active = destination;
    let level = 0;
    let fence = '';
    let lines: string[] = [];
    const flush = () => {
      const text = lines.join('\n').trim();
      if (text) {
        if (active) {
          const parts = mapped.get(active.templateSectionId) ?? [];
          parts.push(text);
          mapped.set(active.templateSectionId, parts);
        } else unmatched.push(text);
      }
      lines = [];
    };
    for (const line of value.content.replace(/\r\n?/gu, '\n').split('\n')) {
      const delimiter = /^\s*(`{3,}|~{3,})/u.exec(line);
      if (delimiter) {
        if (!fence) fence = delimiter[1]!;
        else if (line.trim() === fence) fence = '';
        lines.push(line);
        continue;
      }
      const heading = !fence && /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
      if (heading) {
        const target = matchSection(heading[2]!.replace(/^\d+[.)\s-]+/u, ''), sections);
        if (target || heading[1]!.length <= level || level === 0) {
          flush();
          active = target;
          level = heading[1]!.length;
          if (target) continue;
        }
      }
      lines.push(line);
    }
    flush();
  }
  if (unmatched.length) {
    const parts = mapped.get(last.templateSectionId) ?? [last.content.trim()];
    mapped.set(last.templateSectionId, [...parts, ...unmatched].filter(Boolean));
  }
  return [...mapped].map(([templateSectionId, parts]) => ({
    templateSectionId,
    content: parts.join('\n\n'),
  }));
}
