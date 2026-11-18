import type { E2eExploration, E2eExplorationLogEntry } from './e2e-insight.js';

/** Largest code the user may save for an exploration. */
export const MAX_EXPLORATION_CODE_LENGTH = 200_000;

const q = (text: string): string => JSON.stringify(text);

/** A label of the log is the name of the control: the part before " = " is the control. */
function splitValue(target: string): { name: string; value: string | null } {
  const at = target.lastIndexOf(' = ');
  return at < 0
    ? { name: target, value: null }
    : { name: target.slice(0, at), value: target.slice(at + 3) };
}

/** The line of code of an action; empty for those that are not an action of the browser. */
function stepOf(entry: E2eExplorationLogEntry): string[] {
  const { name, value } = splitValue(entry.target);
  const control = `page.getByText(${q(name)}, { exact: true }).first()`;
  switch (entry.action) {
    case 'navigate':
      return [`await page.goto(${q(entry.target)});`];
    case 'sign_in':
      return [
        '// The account comes from the environment: the password is never written here.',
        'await page.getByLabel(/user|e-?mail|login/i).first().fill(process.env.E2E_USERNAME ?? "");',
        'await page.getByLabel(/password|senha/i).first().fill(process.env.E2E_PASSWORD ?? "");',
        "await page.keyboard.press('Enter');",
      ];
    case 'click':
      return [`await ${control}.click();`];
    case 'type':
      return [
        `await page.getByLabel(${q(name)}).or(page.getByPlaceholder(${q(name)})).first().fill(${q(value ?? '')});`,
      ];
    case 'select':
      return [`await page.getByLabel(${q(name)}).first().selectOption(${q(value ?? '')});`];
    case 'press':
      return [`await page.keyboard.press(${q(entry.target)});`];
    case 'scroll':
      return [
        `await page.mouse.wheel(0, ${entry.target === 'up' ? '-' : ''}600); // ${entry.target}`,
      ];
    default:
      return [];
  }
}

/**
 * Playwright code of what the agent did, one `test.step` per action in the order it was done.
 * It is a starting point: controls are found by the name the agent saw, so the user can refine
 * the locators in the Code tab.
 */
export function explorationCode(
  exploration: Pick<E2eExploration, 'log' | 'description'>,
  title: string,
): string {
  const steps = exploration.log.flatMap((entry, index) => {
    const lines = stepOf(entry);
    if (!lines.length) return [];
    // The account of a sign-in stays out of the code: it comes from the environment.
    const named = entry.action === 'sign_in' ? '' : ` ${entry.target}`;
    const label = `${index + 1} - ${entry.action}${named}`.slice(0, 120);
    const why = entry.reason ? [`    // ${entry.reason.replace(/\s+/g, ' ')}`] : [];
    return [
      `  await test.step(${q(label)}, async () => {`,
      ...why,
      ...lines.map((line) => `    ${line}`),
      '  });',
    ];
  });
  const scope = exploration.description
    ? ` * Scope: ${exploration.description.replace(/\s+/g, ' ')}\n`
    : '';
  return `/**
 * What the agent did while it explored the application, as a Playwright test.
${scope} */
import { test, type Page } from '@playwright/test';

test(${q(`Exploration of ${title}`)}, async ({ page }: { page: Page }) => {
${steps.join('\n')}
});
`;
}
