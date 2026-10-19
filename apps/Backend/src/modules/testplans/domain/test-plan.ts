import { normalizeTestCaseDescription, type DescriptionLanguage } from './test-case-description.js';

export interface TestStep {
  readonly order?: number;
  readonly action: string;
  readonly expectedResult: string;
  readonly data?: string;
}

export interface TestPlan {
  readonly title: string;
  readonly description: string;
  readonly steps: readonly TestStep[];
  readonly metadata?: Record<string, unknown>;
}

export interface NormalizeOptions {
  /** Language of the description template headings. */
  readonly language?: DescriptionLanguage;
}

export function parseAndNormalizeTestPlans(
  raw: string,
  options: NormalizeOptions = {},
): readonly TestPlan[] {
  if (!raw || !raw.trim()) {
    throw new Error('Resposta vazia.');
  }

  const cleaned = removeMarkdown(raw);
  const jsonSlice = extractJson(cleaned);
  const rootNormalized = normalizeRoot(jsonSlice);

  let parsed: unknown;
  try {
    parsed = tryParseJson(rootNormalized);
  } catch {
    throw new Error('Falha ao desserializar JSON.');
  }

  const rawList = parsed as readonly unknown[];
  const fixed = fixNulls(rawList);
  const withSteps = fixSteps(fixed);
  const withOrders = fixOrders(withSteps);
  const ready = fixDescriptions(ensureAtLeastOneStep(withOrders), options.language ?? 'pt-BR');

  validate(ready);

  return ready;
}

function removeMarkdown(raw: string): string {
  return raw.replace(/```json|```/gi, '').trim();
}

function extractJson(raw: string): string {
  const startArray = raw.indexOf('[');
  const startObject = raw.indexOf('{');

  let start: number;
  if (startArray === -1 && startObject === -1) {
    throw new Error('JSON não encontrado.');
  } else if (startArray === -1) {
    start = startObject;
  } else if (startObject === -1) {
    start = startArray;
  } else {
    start = Math.min(startArray, startObject);
  }

  const endArray = raw.lastIndexOf(']');
  const endObject = raw.lastIndexOf('}');
  const end = Math.max(endArray, endObject);

  if (end <= start) {
    throw new Error('JSON inválido.');
  }

  return raw.slice(start, end + 1);
}

function normalizeRoot(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    return `[${trimmed}]`;
  }
  return trimmed;
}

function fixNulls(items: readonly unknown[]): Array<{
  title: string;
  description: string;
  steps: unknown[];
  metadata?: Record<string, unknown>;
}> {
  const result: Array<{
    title: string;
    description: string;
    steps: unknown[];
    metadata?: Record<string, unknown>;
  }> = [];

  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const title = normalizeTitle(obj.title);
    // Structured sections are kept as-is and rendered by fixDescriptions once steps are known.
    const description =
      obj.description && typeof obj.description === 'object'
        ? (obj.description as unknown as string)
        : normalizeString(obj.description, '');
    const steps = Array.isArray(obj.steps) ? obj.steps : [];
    const metadata =
      obj.metadata && typeof obj.metadata === 'object'
        ? (obj.metadata as Record<string, unknown>)
        : undefined;

    result.push({ title, description, steps, metadata });
  }

  return result;
}

function fixDescriptions(
  items: readonly TestPlan[],
  language: DescriptionLanguage,
): readonly TestPlan[] {
  return items.map((plan) => {
    const description = normalizeTestCaseDescription(
      plan.description,
      language,
      plan.steps.map((step) => step.action),
    );
    return {
      ...plan,
      description,
      metadata: { ...(plan.metadata ?? {}), formattedDescription: description },
    };
  });
}

function fixSteps(
  items: Array<{
    title: string;
    description: string;
    steps: unknown[];
    metadata?: Record<string, unknown>;
  }>,
): Array<{
  title: string;
  description: string;
  steps: Array<{ order?: number; action: string; expectedResult: string; data?: string }>;
  metadata?: Record<string, unknown>;
}> {
  return items.map((plan) => {
    const validSteps: Array<{
      order?: number;
      action: string;
      expectedResult: string;
      data?: string;
    }> = [];

    for (const s of plan.steps) {
      if (!s || typeof s !== 'object') continue;
      const stepObj = s as Record<string, unknown>;
      const rawAction = stepObj.action ?? stepObj.stepAction;
      const rawExpected = stepObj.expected ?? stepObj.expectedResult ?? stepObj.stepExpected;
      const rawData = stepObj.data;

      const action = normalizeStep(rawAction);
      const expected = normalizeStep(rawExpected);

      if (!action && !expected) continue;

      validSteps.push({
        action: action || 'Executar ação',
        expectedResult: expected || 'Validar resultado esperado',
        data: typeof rawData === 'string' && rawData.trim() ? rawData.trim() : undefined,
      });
    }

    return {
      ...plan,
      steps: validSteps,
    };
  });
}

function fixOrders(
  items: Array<{
    title: string;
    description: string;
    steps: Array<{ order?: number; action: string; expectedResult: string; data?: string }>;
    metadata?: Record<string, unknown>;
  }>,
): typeof items {
  for (const plan of items) {
    plan.steps = plan.steps.map((step, index) => ({
      ...step,
      order: index + 1,
    }));
  }
  return items;
}

function ensureAtLeastOneStep(
  items: Array<{
    title: string;
    description: string;
    steps: Array<{ order?: number; action: string; expectedResult: string; data?: string }>;
    metadata?: Record<string, unknown>;
  }>,
): readonly TestPlan[] {
  return items.map((plan) => {
    if (plan.steps.length === 0) {
      return {
        ...plan,
        steps: [
          {
            order: 1,
            action: 'Executar fluxo principal',
            expectedResult: 'Fluxo executado com sucesso',
          },
        ],
      };
    }
    return plan;
  });
}

function validate(plans: readonly TestPlan[]): void {
  if (plans.length === 0) {
    throw new Error('Nenhum TestPlan encontrado.');
  }

  for (const plan of plans) {
    if (!plan.title.trim()) {
      throw new Error('TestPlan sem título.');
    }
  }
}

function normalizeTitle(value: unknown): string {
  if (typeof value !== 'string') {
    return 'Test Case Sem Título';
  }
  const trimmed = value.trim();
  if (trimmed.toLowerCase() === 'null') {
    return 'Test Case Sem Título';
  }
  return trimmed;
}

function normalizeString(value: unknown, fallback: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().toLowerCase() === 'null') {
    return fallback;
  }
  return value.trim();
}

function normalizeStep(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }
  return value
    .replace(/\\n/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<.*?>/g, '')
    .trim();
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const withoutTrailingCommas = text.replace(/,\s*([\]}])/g, '$1');
    try {
      return JSON.parse(withoutTrailingCommas);
    } catch {
      const sanitized = sanitizeJsonStrings(withoutTrailingCommas);
      return JSON.parse(sanitized);
    }
  }
}

function sanitizeJsonStrings(json: string): string {
  let inString = false;
  let isEscaped = false;
  let result = '';

  for (let i = 0; i < json.length; i++) {
    const char = json[i]!;

    if (inString) {
      if (isEscaped) {
        result += char;
        isEscaped = false;
      } else if (char === '\\') {
        result += char;
        isEscaped = true;
      } else if (char === '"') {
        result += char;
        inString = false;
      } else if (char === '\n') {
        result += '\\n';
      } else if (char === '\r') {
        result += '\\r';
      } else if (char === '\t') {
        result += '\\t';
      } else {
        result += char;
      }
    } else {
      if (char === '"') {
        inString = true;
      }
      result += char;
    }
  }

  return result;
}
