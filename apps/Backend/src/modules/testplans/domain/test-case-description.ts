/**
 * Default template of a test case description: bold `## Section` headings in HTML (the format of
 * the Azure DevOps "Description" rich-text field) followed by a text "Process flow" diagram.
 *
 * Models return the sections as structured data and this module renders them, so every case has
 * the same layout regardless of which model (server LLM, MCP host, deterministic fallback) wrote it.
 */

export type DescriptionLanguage = 'pt-BR' | 'en-US';

export type FlowNode =
  | { readonly step: string }
  | { readonly decision: string; readonly yes: string; readonly no: string };

export interface DescriptionSections {
  readonly useCase: string;
  readonly preconditions: string;
  readonly inputData: string;
  readonly expectedResult: string;
  readonly postconditions: string;
  readonly flow: readonly FlowNode[];
}

const SECTION_KEYS = [
  'useCase',
  'preconditions',
  'inputData',
  'expectedResult',
  'postconditions',
] as const;

const LABELS: Readonly<
  Record<DescriptionLanguage, Record<(typeof SECTION_KEYS)[number] | 'flow', string>>
> = {
  'pt-BR': {
    useCase: 'Caso de uso',
    preconditions: 'Pré-condições',
    inputData: 'Dados de entrada',
    expectedResult: 'Resultado esperado',
    postconditions: 'Pós-condições',
    flow: 'Fluxo do Processo',
  },
  'en-US': {
    useCase: 'Use case',
    preconditions: 'Preconditions',
    inputData: 'Input data',
    expectedResult: 'Expected result',
    postconditions: 'Postconditions',
    flow: 'Process flow',
  },
};

const BRANCHES: Readonly<Record<DescriptionLanguage, { yes: string; no: string }>> = {
  'pt-BR': { yes: 'SIM', no: 'NÃO' },
  'en-US': { yes: 'YES', no: 'NO' },
};

const NOT_INFORMED: Readonly<Record<DescriptionLanguage, string>> = {
  'pt-BR': 'Não informado.',
  'en-US': 'Not provided.',
};

/** Keeps the diagram readable: boxes grow with the label, so long labels are shortened. */
const MAX_FLOW_LABEL = 60;
const MAX_FLOW_NODES = 12;
/** Non-breaking space: kept by both HTML renderers (Azure DevOps) and plain-text views. */
const NBSP = ' ';

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

function label(value: string): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > MAX_FLOW_LABEL ? `${clean.slice(0, MAX_FLOW_LABEL - 1)}…` : clean;
}

const bracket = (value: string, open: string, close: string) =>
  value.startsWith(open) && value.endsWith(close) ? value : `${open}${value}${close}`;

function box(content: string): string[] {
  const width = content.length + 2;
  return [`┌${'─'.repeat(width)}┐`, `│${NBSP}${content}${NBSP}│`, `└${'─'.repeat(width)}┘`];
}

/** Text diagram: boxes for steps, a decision box with YES/NO branches, arrows between nodes. */
export function renderFlow(
  nodes: readonly FlowNode[],
  language: DescriptionLanguage = 'pt-BR',
): string[] {
  const lines: string[] = [];
  const branches = BRANCHES[language];
  nodes.slice(0, MAX_FLOW_NODES).forEach((node, index) => {
    if (index > 0) lines.push('│', '▼');
    if ('decision' in node) {
      lines.push(...box(bracket(label(node.decision), '(', ')')));
      lines.push(
        '│',
        `├─(${branches.yes})─▶️${NBSP}${bracket(label(node.yes), '[', ']')}`,
        '│',
        `└─(${branches.no})─▶️${NBSP}${bracket(label(node.no), '[', ']')}`,
      );
    } else {
      lines.push(...box(bracket(label(node.step), '[', ']')));
    }
  });
  return lines;
}

function paragraph(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

export function renderTestCaseDescription(
  sections: DescriptionSections,
  language: DescriptionLanguage = 'pt-BR',
): string {
  const labels = LABELS[language];
  const blocks = SECTION_KEYS.map(
    (key) =>
      `<b>## ${labels[key]}</b><br>${paragraph(sections[key].trim() || NOT_INFORMED[language])}`,
  );
  const flow = renderFlow(sections.flow, language);
  if (flow.length) {
    blocks.push(`<b>## ${labels.flow}</b><br>${flow.map(escapeHtml).join('<br>')}`);
  }
  return blocks.join('<br><br>');
}

function toFlow(value: unknown): FlowNode[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): FlowNode[] => {
    if (typeof item === 'string' && item.trim()) return [{ step: item.trim() }];
    if (!item || typeof item !== 'object') return [];
    const node = item as Record<string, unknown>;
    const decision = text(node.decision);
    if (decision) {
      return [{ decision, yes: text(node.yes) || '-', no: text(node.no) || '-' }];
    }
    const step = text(node.step) || text(node.label);
    return step ? [{ step }] : [];
  });
}

/** Linear flow from the test steps, used when a model did not describe the process. */
export function flowFromSteps(actions: readonly string[]): FlowNode[] {
  return actions
    .map((action) => action.trim().replace(/[.;:]+$/, ''))
    .filter(Boolean)
    .map((step) => ({ step }));
}

const HEADING = /^\s*(?:<b>\s*)?#{1,6}\s*([^<\n]+?)\s*(?:<\/b>)?\s*$/i;

/** Maps legacy plain-text descriptions (`## Caso de uso` lines) onto the structured sections. */
function sectionsFromText(value: string): Partial<Record<(typeof SECTION_KEYS)[number], string>> {
  const byLabel = new Map<string, (typeof SECTION_KEYS)[number]>();
  for (const labels of Object.values(LABELS)) {
    for (const key of SECTION_KEYS) byLabel.set(labels[key].toLowerCase(), key);
  }
  const found: Partial<Record<(typeof SECTION_KEYS)[number], string>> = {};
  let current: (typeof SECTION_KEYS)[number] | undefined;
  let matched = false;
  for (const line of value.replace(/<br\s*\/?>/gi, '\n').split(/\r?\n/)) {
    const heading = HEADING.exec(line)?.[1]?.replace(/:$/, '').trim().toLowerCase();
    const key = heading ? byLabel.get(heading) : undefined;
    if (key) {
      current = key;
      matched = true;
      found[key] = '';
    } else if (current) {
      found[current] = `${found[current] as string}\n${line.replace(/<[^>]+>/g, '')}`.trim();
    }
  }
  return matched ? found : { useCase: value.replace(/<[^>]+>/g, '').trim() };
}

/**
 * Normalizes whatever a model or client sent as the description (structured sections, legacy
 * text with `##` headings or free text) into the default HTML template.
 */
export function normalizeTestCaseDescription(
  raw: unknown,
  language: DescriptionLanguage,
  stepActions: readonly string[],
): string {
  let sections: Partial<Record<(typeof SECTION_KEYS)[number], string>>;
  let flow: FlowNode[] = [];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const value = raw as Record<string, unknown>;
    sections = Object.fromEntries(SECTION_KEYS.map((key) => [key, text(value[key])]));
    flow = toFlow(value.flow);
  } else {
    sections = sectionsFromText(text(raw).replace(/\\n/g, '\n'));
  }
  return renderTestCaseDescription(
    {
      useCase: sections.useCase ?? '',
      preconditions: sections.preconditions ?? '',
      inputData: sections.inputData ?? '',
      expectedResult: sections.expectedResult ?? '',
      postconditions: sections.postconditions ?? '',
      flow: flow.length ? flow : flowFromSteps(stepActions),
    },
    language,
  );
}
