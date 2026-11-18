import { describe, expect, it } from 'vitest';
import { replaceStep, topLevelSteps } from '../src/modules/e2e/application/script-steps.js';

// Shaped like a real spec: a login before the first step, helpers, regexes, templates, comments.
const SPEC = `import { test, expect } from '@playwright/test';

test('TC002 - Abrir relatório', async ({ page }) => {
  const heading = page.getByText(/^(Documental Compliance|Conformidade Documental)$/).first();
  const half = 10 / 2 / 5; // not a regex: / 2 /
  const label = \`card \${half > 0 ? "a}" : 'b'} {\`;

  await page.goto('/dashboard');
  /* await test.step('not a step', async () => {}); */
  // await test.step('also not a step', async () => {});
  const text = "await test.step('inside a string', async () => {});";

  await test.step('Step 1 - Filtrar', async () => {
    await expect(heading).toBeVisible();
    await test.step('nested', async () => {
      await page.keyboard.press('Escape');
    });
  });

  await test.step("Step 2 - Ler o modal", async () => {
    await expect(page.getByText(/modal [)}]/)).toBeVisible();
  });

  await test.step(\`Step 3 - \${label}\`, async () => { await expect(heading).toBeVisible(); });
  test.step('Step 4 - sem await', async () => {});
  await mytest.step('not ours', async () => {});
});
`;

describe('top-level steps of a spec', () => {
  it('finds the steps in order, skipping nested ones, strings, comments and regular expressions', () => {
    const steps = topLevelSteps(SPEC);
    expect(steps).toHaveLength(4);
    const titles = steps.map((step) => SPEC.slice(step.title!.start, step.title!.end));
    expect(titles).toEqual([
      "'Step 1 - Filtrar'",
      '"Step 2 - Ler o modal"',
      '`Step 3 - ${label}`',
      "'Step 4 - sem await'",
    ]);
    // A statement starts at its await and ends after its semicolon.
    expect(SPEC.slice(steps[0]!.start, steps[0]!.start + 10)).toBe('await test');
    expect(SPEC.slice(steps[0]!.end - 3, steps[0]!.end)).toBe('});');
    expect(SPEC.slice(steps[3]!.start, steps[3]!.start + 9)).toBe('test.step');
    expect(SPEC.slice(steps[0]!.start, steps[0]!.end)).toContain("test.step('nested'");
  });

  it('reads escapes, flags and unfinished code without losing its place', () => {
    const find = (source: string) => topLevelSteps(source).length;
    // Escaped quotes and backticks, escaped slashes and flags of a regular expression.
    expect(find("const a = 'it\\'s'; await test.step('x', async () => {});")).toBe(1);
    expect(find("const a = `a\\`b ${1}`; await test.step('x', async () => {});")).toBe(1);
    expect(find("const r = /a\\/b[/]c/gi; await test.step('x', async () => {});")).toBe(1);
    expect(find("const r = /x/; await test.step('x', async () => {});")).toBe(1);
    // A comment, a regular expression or a step that the file ends in the middle of.
    expect(find("await test.step('x', async () => {}); // the end")).toBe(1);
    expect(find("await test.step('x', async () => {}); /* never closed")).toBe(1);
    expect(find('const r = /x')).toBe(0);
    expect(find('await test.step(')).toBe(1);
  });

  it('has no steps when the spec declares none, and tolerates a step that never closes', () => {
    expect(topLevelSteps("test('x', async () => { await page.goto('/'); });")).toEqual([]);
    expect(topLevelSteps("await test.step('open', async () => {")).toHaveLength(1);
    // Titles that are not a literal still count as a step, without a name to keep.
    const [step] = topLevelSteps('await test.step(name, async () => {});');
    expect(step!.title).toBeNull();
    expect(
      topLevelSteps('await test.step( `a ${`b`}` , async () => {});')[0]!.title,
    ).not.toBeNull();
  });
});

describe('replacing one step of a spec', () => {
  const rewritten = `await test.step('Passo 2 - Outro nome', async () => {
    await expect(page.getByText('novo')).toBeVisible();
  });`;

  it('changes that step alone, byte for byte, and keeps the name it had', () => {
    const swapped = replaceStep(SPEC, 2, rewritten);
    expect(swapped).toEqual({ ok: true, script: expect.any(String) });
    if (!swapped.ok) return;
    const before = topLevelSteps(SPEC);
    const target = before[1]!;
    // Everything before and after the step is the original text.
    expect(swapped.script.slice(0, target.start)).toBe(SPEC.slice(0, target.start));
    expect(swapped.script.endsWith(SPEC.slice(target.end))).toBe(true);
    expect(swapped.script).toContain('"Step 2 - Ler o modal"');
    expect(swapped.script).not.toContain('Outro nome');
    expect(swapped.script).toContain('toBeVisible();\n  });\n\n  await test.step(`Step 3');
    expect(swapped.script).toContain("getByText('novo')");
    expect(topLevelSteps(swapped.script)).toHaveLength(4);
  });

  it('accepts the answer with spaces around it and a step with no name to keep', () => {
    const swapped = replaceStep(SPEC, 4, '\n  test.step(title, async () => {});\n');
    expect(swapped.ok).toBe(true);
    const unnamed = replaceStep('await test.step(name, async () => {});', 1, rewritten);
    expect(unnamed).toEqual({ ok: true, script: rewritten });
    const keeps = replaceStep(
      "await test.step('Step 1 - A', async () => {});",
      1,
      'await test.step(title, async () => {});',
    );
    expect(keeps).toEqual({ ok: true, script: 'await test.step(title, async () => {});' });
  });

  it('refuses a step the spec does not have', () => {
    expect(replaceStep(SPEC, 9, rewritten)).toEqual({
      ok: false,
      problem: 'The script has no step 9.',
    });
    expect(replaceStep(SPEC, 0, rewritten)).toMatchObject({ ok: false });
  });

  it('refuses an answer that is more, less or something else than one step', () => {
    const wrong = [
      SPEC,
      `${rewritten}\n${rewritten}`,
      `const x = 1;\n${rewritten}`,
      `${rewritten}\nawait page.goto('/');`,
      'await page.goto("/");',
      '',
    ];
    for (const answer of wrong) {
      const swapped = replaceStep(SPEC, 2, answer);
      expect(swapped.ok).toBe(false);
      expect(swapped).toMatchObject({
        problem: expect.stringContaining('exactly one await test.step'),
      });
    }
  });
});
