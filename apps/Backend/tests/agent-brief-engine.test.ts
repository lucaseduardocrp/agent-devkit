import { describe, expect, it } from 'vitest';
import {
  assessComplexity,
  buildConsiderations,
  effortFor,
  generateBrief,
  levelForScore,
  recommend,
  tierOf,
  type AvailableModel,
  type BriefEngineInput,
} from '../src/modules/issues/agent-brief/brief-engine.js';
import type { IssueAgentBrief } from '../src/modules/issues/agent-brief/brief-types.js';

const model = (
  provider: string,
  name: string,
  price: [number, number] | null = [1, 5],
  inUse = false,
): AvailableModel => ({
  provider,
  model: name,
  inUse,
  inputUsdPerMillion: price?.[0] ?? null,
  outputUsdPerMillion: price?.[1] ?? null,
});

function input(
  overrides: Partial<Omit<BriefEngineInput, 'issue'>> & {
    issue?: Partial<BriefEngineInput['issue']>;
  } = {},
): BriefEngineInput {
  const { issue, ...rest } = overrides;
  return {
    issue: {
      id: 'issue-1',
      workspaceId: 'ws',
      number: 7,
      title: 'Update the button',
      description: '',
      type: '',
      priority: 'medium',
      attachmentCount: 0,
      ...issue,
    },
    pbi: null,
    commentCount: 0,
    models: [],
    references: [],
    now: new Date('2026-11-05T12:00:00Z'),
    ...rest,
  };
}

describe('tierOf', () => {
  it('classifies models by name', () => {
    expect(tierOf('claude-haiku-5-5')).toBe('fast');
    expect(tierOf('gpt-5-mini')).toBe('fast');
    expect(tierOf('claude-opus-5-5')).toBe('frontier');
    expect(tierOf('gpt-5')).toBe('frontier');
    expect(tierOf('claude-sonnet-5-5')).toBe('balanced');
    expect(tierOf('something-new')).toBe('balanced');
  });
});

describe('assessComplexity', () => {
  it('scores a plain short issue as trivial', () => {
    expect(assessComplexity(input())).toEqual({ score: 1, level: 'trivial', signals: [] });
  });

  it('adds the signals of a heavy, long and discussed issue', () => {
    const words = (count: number) => Array.from({ length: count }, () => 'word').join(' ');
    const heavy = assessComplexity(
      input({
        issue: {
          type: 'epic',
          description: `Refactor the architecture. ${words(420)}`,
          priority: 'urgent',
          attachmentCount: 2,
        },
        pbi: { title: 'Big', childCount: 12 },
        commentCount: 6,
      }),
    );
    expect(heavy.level).toBe('epic');
    expect(heavy.score).toBe(10);
    expect(heavy.signals.join('|')).toMatch(/Long description/);
    expect(heavy.signals.join('|')).toMatch(/PBI has 12 children/);
  });

  it('weighs each description size, bug type, medium PBI and light changes', () => {
    const words = (count: number) => Array.from({ length: count }, () => 'w').join(' ');
    expect(assessComplexity(input({ issue: { description: words(130) } })).signals[0]).toMatch(
      /Detailed/,
    );
    expect(assessComplexity(input({ issue: { description: words(40) } })).signals[0]).toMatch(
      /Short description/,
    );
    expect(assessComplexity(input({ issue: { type: 'bug' } })).signals[0]).toMatch(/Bug/);
    expect(assessComplexity(input({ pbi: { title: 'p', childCount: 3 } })).signals[0]).toMatch(
      /3 children/,
    );
    expect(assessComplexity(input({ pbi: { title: 'p', childCount: 1 } })).signals).toEqual([]);
    const light = assessComplexity(input({ issue: { title: 'Fix typo in label' } }));
    expect(light.score).toBe(1);
    expect(light.signals[0]).toMatch(/small text/);
  });

  it('clamps the level for scores above the table', () => {
    expect(levelForScore(99)).toBe('epic');
    expect(levelForScore(3)).toBe('small');
  });
});

describe('effortFor', () => {
  it('raises small bugs and urgent work but not trivial work', () => {
    expect(effortFor('small', input({ issue: { type: 'bug' } }))).toBe('medium');
    expect(effortFor('small', input())).toBe('low');
    expect(effortFor('trivial', input({ issue: { priority: 'urgent' } }))).toBe('low');
    expect(effortFor('large', input({ issue: { priority: 'urgent' } }))).toBe('max');
    expect(effortFor('epic', input({ issue: { priority: 'urgent' } }))).toBe('max');
  });
});

const budget = { maxInputTokens: 1_000_000, maxOutputTokens: 100_000 };

describe('recommend', () => {
  it('explains when no provider is configured', () => {
    const result = recommend('medium', 'medium', budget, []);
    expect(result).toMatchObject({ provider: '', model: '', estimatedCostUsd: null });
    expect(result.rationale).toMatch(/No LLM provider/);
  });

  it('picks the cheapest model of the needed tier, preferring the one in use', () => {
    const models = [
      model('anthropic', 'claude-haiku-5-5', [1, 5]),
      model('openai', 'gpt-5-mini', [0.2, 1]),
      model('anthropic', 'claude-sonnet-5-5', [3, 15], true),
      model('openai', 'gpt-4o', [2, 8]),
      model('anthropic', 'claude-opus-5-5', [15, 75]),
    ];
    const fast = recommend('trivial', 'low', budget, models);
    expect(fast).toMatchObject({ model: 'gpt-5-mini', provider: 'openai' });
    expect(fast.estimatedCostUsd).toBe(0.3);
    expect(fast.rationale).toMatch(/best match/);
    expect(fast.alternatives.map((item) => item.model)).toEqual(['claude-sonnet-5-5']);
    const balanced = recommend('medium', 'medium', budget, models);
    expect(balanced.model).toBe('claude-sonnet-5-5');
    expect(balanced.rationale).toMatch(/already in use/);
    expect(balanced.alternatives.map((item) => item.reason)).toEqual([
      expect.stringMatching(/Cheaper/),
      expect.stringMatching(/Escalate/),
    ]);
    const frontier = recommend('epic', 'max', budget, models);
    expect(frontier.model).toBe('claude-opus-5-5');
    expect(frontier.alternatives).toHaveLength(1);
  });

  it('falls back to the nearest tier and tolerates missing rates', () => {
    const onlyFast = recommend('large', 'high', budget, [model('groq', 'llama-3-8b', null)]);
    expect(onlyFast.model).toBe('llama-3-8b');
    expect(onlyFast.rationale).toMatch(/closest available \(fast\)/);
    expect(onlyFast.rationale).toMatch(/No cost rate/);
    expect(onlyFast.estimatedCostUsd).toBeNull();
    const priceless = recommend('medium', 'medium', budget, [
      model('a', 'zeta-model', null),
      model('b', 'alpha-model', null),
      model('c', 'beta-model', [1, 1]),
    ]);
    expect(priceless.model).toBe('beta-model');
    const tie = recommend('medium', 'medium', budget, [
      model('a', 'zeta-model'),
      model('b', 'alpha-model'),
    ]);
    expect(tie.model).toBe('alpha-model');
    const downFromFrontier = recommend('trivial', 'low', budget, [
      model('o', 'claude-opus-5-5'),
      model('s', 'claude-sonnet-5-5'),
    ]);
    expect(downFromFrontier.model).toBe('claude-sonnet-5-5');
    const onlyOpus = recommend('trivial', 'low', budget, [model('o', 'claude-opus-5-5')]);
    expect(onlyOpus.rationale).toMatch(/closest available \(frontier\)/);
  });
});

describe('buildConsiderations', () => {
  it('adds a rule for every relevant signal', () => {
    const items = buildConsiderations(
      input({
        issue: {
          type: 'bug',
          title: 'Security: migrate the database for performance',
          priority: 'urgent',
          attachmentCount: 1,
        },
        pbi: { title: 'Checkout', childCount: 2 },
        commentCount: 2,
      }),
    ).join('\n');
    for (const expected of [
      /Reproduce first/,
      /PBI "Checkout"/,
      /attached images/,
      /conversation/,
      /authorization/,
      /reversible/,
      /Measure before/,
      /smallest safe change/,
      /existing patterns/,
      /ambiguous/,
    ])
      expect(items).toMatch(expected);
  });

  it('keeps only the generic rules for a plain issue', () => {
    expect(buildConsiderations(input())).toHaveLength(2);
  });
});

describe('generateBrief', () => {
  const references = [
    { kind: 'pbi' as const, label: 'Parent', ref: 'p1', reason: 'scope' },
    { kind: 'pbi' as const, label: 'Parent again', ref: 'p1', reason: 'dup' },
    ...Array.from({ length: 14 }, (_, index) => ({
      kind: 'issue' as const,
      label: `#${index}`,
      ref: `i${index}`,
      reason: 'related',
    })),
  ];

  it('builds a complete brief with a prompt that lists what to read', () => {
    const brief = generateBrief(
      input({
        issue: { description: 'Do the thing.' },
        references,
        models: [model('anthropic', 'claude-haiku-5-5')],
      }),
    );
    expect(brief).toMatchObject({
      issueId: 'issue-1',
      workspaceId: 'ws',
      source: 'engine',
      locked: [],
      generatedAt: '2026-11-05T12:00:00.000Z',
      budget: { maxInputTokens: 4000, maxOutputTokens: 1000 },
    });
    expect(brief.readFirst).toHaveLength(12);
    expect(brief.readFirst.filter((item) => item.ref === 'p1')).toHaveLength(1);
    expect(brief.prompt.task).toContain('Work on issue #7: Update the button');
    expect(brief.prompt.task).toContain('1. [pbi] Parent (p1) - scope');
    expect(brief.prompt.outputFormat).toContain('80 words');
    expect(brief.recommendation.model).toBe('claude-haiku-5-5');
  });

  it('writes a prompt without reads or description when there is nothing to read', () => {
    const brief = generateBrief(input());
    expect(brief.prompt.task).toContain('(no description)');
    expect(brief.prompt.task).not.toContain('Read first');
  });

  it('keeps every locked field and rebuilds the rest around them', () => {
    const generated = generateBrief(input({ references }));
    const edited: IssueAgentBrief = {
      ...generated,
      locked: ['recommendation', 'readFirst', 'considerations', 'prompt', 'budget'],
      recommendation: { ...generated.recommendation, model: 'human-pick' },
      readFirst: [{ kind: 'file', label: 'a.ts', ref: 'a.ts', reason: 'x' }],
      considerations: ['Only this'],
      prompt: { system: 's', task: 't', outputFormat: 'o' },
      budget: { maxInputTokens: 1, maxOutputTokens: 2 },
    };
    const regenerated = generateBrief(input({ references }), edited);
    expect(regenerated.source).toBe('edited');
    expect(regenerated.locked).toEqual(edited.locked);
    expect(regenerated.recommendation.model).toBe('human-pick');
    expect(regenerated.readFirst).toEqual(edited.readFirst);
    expect(regenerated.considerations).toEqual(['Only this']);
    expect(regenerated.prompt).toEqual(edited.prompt);
    expect(regenerated.budget).toEqual(edited.budget);
    // An unlocked prompt is rebuilt from the locked considerations.
    const partial = generateBrief(input({ references }), {
      ...generated,
      locked: ['considerations'],
      considerations: ['Human rule'],
    });
    expect(partial.prompt.task).toContain('- Human rule');
    expect(partial.considerations).toEqual(['Human rule']);
  });
});
