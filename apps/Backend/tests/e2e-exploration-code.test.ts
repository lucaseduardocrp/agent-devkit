import { describe, expect, it } from 'vitest';
import { explorationCode } from '../src/modules/e2e/domain/e2e-exploration-code.js';
import type { E2eExplorationLogEntry } from '../src/modules/e2e/domain/e2e-insight.js';

const entry = (
  action: E2eExplorationLogEntry['action'],
  target: string,
  reason?: string,
): E2eExplorationLogEntry => ({
  atMs: 1,
  action,
  target,
  result: null,
  ...(reason ? { reason } : {}),
});

describe('explorationCode', () => {
  it('turns every action of the agent into a test step', () => {
    const code = explorationCode(
      {
        description: 'Only the\nissues screen',
        log: [
          entry('navigate', 'http://localhost:4000/'),
          entry('sign_in', 'qa@example.com'),
          entry('click', 'New "issue"', 'It opens\nthe form'),
          entry('type', 'Title = Bug = 1'),
          entry('type', 'Search'),
          entry('select', 'Priority = High'),
          entry('select', 'Status'),
          entry('press', 'Enter'),
          entry('scroll', 'down'),
          entry('scroll', 'up'),
          entry('note', 'agent_done'),
        ],
      },
      'My run',
    );

    expect(code).toContain(' * Scope: Only the issues screen');
    expect(code).toContain('test("Exploration of My run"');
    expect(code).toContain('await page.goto("http://localhost:4000/");');
    expect(code).toContain('process.env.E2E_PASSWORD');
    expect(code).not.toContain('qa@example.com');
    expect(code).toContain('page.getByText("New \\"issue\\"", { exact: true }).first().click();');
    expect(code).toContain('// It opens the form');
    expect(code).toContain('.getByLabel("Title = Bug").or(page.getByPlaceholder("Title = Bug"))');
    expect(code).toContain('.fill("1");');
    expect(code).toContain('.fill("");');
    expect(code).toContain('.selectOption("High");');
    expect(code).toContain('.selectOption("");');
    expect(code).toContain('page.keyboard.press("Enter");');
    expect(code).toContain('page.mouse.wheel(0, 600); // down');
    expect(code).toContain('page.mouse.wheel(0, -600); // up');
    // A note is not something the browser does.
    expect(code).not.toContain('agent_done');
    expect(code).not.toContain('test.step("11');
    expect(code).toContain('test.step("10 - scroll up"');
  });

  it('is still a valid test when the agent did nothing', () => {
    const code = explorationCode({ description: null, log: [] }, 'Empty');
    expect(code).not.toContain('Scope:');
    expect(code).toContain('test("Exploration of Empty"');
    expect(code).toContain('=> {\n\n});');
  });
});
