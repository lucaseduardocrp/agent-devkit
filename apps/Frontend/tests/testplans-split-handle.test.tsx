import { fireEvent, render, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SplitHandle } from '../src/features/testplans/SplitHandle.js';
import { fenceDiagrams, scenarioToMarkdown } from '../src/features/testplans/scenario-markdown.js';
import { applyRevision } from '../src/features/testplans/test-case-revision.js';

afterEach(() => vi.restoreAllMocks());

function Split() {
  const [width, setWidth] = useState(400);
  const box = useRef<HTMLDivElement>(null);
  return (
    <div ref={box} data-testid="box">
      <SplitHandle
        width={width}
        onChange={setWidth}
        min={300}
        container={box}
        reserve={500}
        label="Resize"
      />
      <output data-testid="width">{width}</output>
    </div>
  );
}

const handle = (ui: ReturnType<typeof render>) => ui.getByRole('separator', { name: 'Resize' });
const width = (ui: ReturnType<typeof render>) => Number(ui.getByTestId('width').textContent);

/** jsdom has no PointerEvent: a mouse event of the pointer type carries the coordinates. */
const pointer = (target: Element | Window, type: string, init: MouseEventInit = {}) =>
  fireEvent(target, new MouseEvent(type, { bubbles: true, ...init }));

describe('SplitHandle', () => {
  it('makes the pane at its right wider when dragged to the left, and narrower to the right', async () => {
    const ui = render(<Split />);
    expect(handle(ui)).toHaveAttribute('aria-valuenow', '400');
    pointer(handle(ui), 'pointerdown', { button: 0, clientX: 1000 });
    await waitFor(() => expect(document.body.style.cursor).toBe('col-resize'));
    pointer(window, 'pointermove', { clientX: 900 });
    expect(width(ui)).toBe(500);
    pointer(window, 'pointermove', { clientX: 1200 });
    expect(width(ui)).toBe(300);
    pointer(window, 'pointerup');
    await waitFor(() => expect(document.body.style.cursor).toBe(''));
    // Released: the pointer no longer moves it.
    pointer(window, 'pointermove', { clientX: 0 });
    expect(width(ui)).toBe(300);
  });

  it('never takes the room the other pane needs', async () => {
    const ui = render(<Split />);
    vi.spyOn(ui.getByTestId('box'), 'getBoundingClientRect').mockReturnValue({
      width: 1000,
    } as DOMRect);
    pointer(handle(ui), 'pointerdown', { button: 0, clientX: 1000 });
    await waitFor(() => expect(document.body.style.cursor).toBe('col-resize'));
    pointer(window, 'pointermove', { clientX: 0 });
    expect(width(ui)).toBe(500);
    pointer(window, 'pointercancel');
    await waitFor(() => expect(document.body.style.cursor).toBe(''));
  });

  it('ignores other buttons of the mouse', () => {
    const ui = render(<Split />);
    pointer(handle(ui), 'pointerdown', { button: 2, clientX: 1000 });
    pointer(window, 'pointermove', { clientX: 0 });
    expect(document.body.style.cursor).toBe('');
    expect(width(ui)).toBe(400);
  });

  it('is moved with the arrow keys and ignores the other keys', () => {
    const ui = render(<Split />);
    fireEvent.keyDown(handle(ui), { key: 'ArrowLeft' });
    expect(width(ui)).toBe(424);
    fireEvent.keyDown(handle(ui), { key: 'ArrowRight' });
    fireEvent.keyDown(handle(ui), { key: 'ArrowRight' });
    expect(width(ui)).toBe(376);
    fireEvent.keyDown(handle(ui), { key: 'Enter' });
    expect(width(ui)).toBe(376);
    for (let press = 0; press < 5; press++) fireEvent.keyDown(handle(ui), { key: 'ArrowRight' });
    expect(width(ui)).toBe(300);
  });
});

describe('scenarioToMarkdown', () => {
  it('keeps Markdown as it is', () => {
    const markdown =
      '## Caso de uso\n\nUm **fluxo** com <br> e `código`.\n\n![a](/attachments/files/x)';
    expect(scenarioToMarkdown(markdown)).toBe(markdown);
    expect(scenarioToMarkdown('')).toBe('');
  });

  it('converts the rich text of older cases', () => {
    expect(
      scenarioToMarkdown(
        '<p>Pay the <b>cart</b></p><ul><li>One</li><li>Two</li></ul><h3>Done</h3><img src=x onerror="a()">',
      ),
    ).toBe('Pay the **cart**\n\n- One\n- Two\n\n### Done');
  });
});

describe('fenceDiagrams', () => {
  const box = '┌─────┐\n│ [A] │\n└─────┘';

  it('leaves text without diagrams as it is', () => {
    expect(fenceDiagrams('## Title\n\nSome text\n')).toBe('## Title\n\nSome text\n');
  });

  it('puts the lines of a diagram in a code block, apart from the text around it', () => {
    expect(fenceDiagrams(`## Fluxo\n${box}\n▼\n${box}\nDone`)).toBe(
      `## Fluxo\n\n\`\`\`\n${box}\n▼\n${box}\n\`\`\`\n\nDone`,
    );
    // Without text after it, no blank line is left behind.
    expect(fenceDiagrams(box)).toBe(`\`\`\`\n${box}\n\`\`\``);
    expect(fenceDiagrams(`${box}\n`)).toBe(`\`\`\`\n${box}\n\`\`\`\n`);
  });

  it('keeps blank lines between the lines of a diagram', () => {
    expect(fenceDiagrams('│ a │\n\n│ b │\n\nText')).toBe('```\n│ a │\n\n│ b │\n```\n\n\nText');
  });

  it('reads the <br> of a diagram as line breaks', () => {
    expect(fenceDiagrams('Fluxo\n\n│ a │<br>▼<br />│ b │')).toBe(
      'Fluxo\n\n```\n│ a │\n▼\n│ b │\n```',
    );
  });

  it('does not touch a diagram that is already in a code block', () => {
    const fenced = `\`\`\`\n${box}\n\`\`\`\n\n~~~\n│ x │\n~~~`;
    expect(fenceDiagrams(fenced)).toBe(fenced);
  });

  it('is applied when a case is opened and when the AI rewrites it', () => {
    expect(scenarioToMarkdown(`<p>Fluxo</p><p>│ a │<br>▼<br>│ b │</p>`)).toBe(
      'Fluxo\n\n```\n│ a │\n▼\n│ b │\n```',
    );
    const rewritten = applyRevision(
      { id: 'CT-01', title: 'x', scenario: 'old' },
      { title: 'x', description: 'Fluxo\n│ a │\n▼\n│ b │', steps: [] },
    );
    expect(rewritten.scenario).toBe('Fluxo\n\n```\n│ a │\n▼\n│ b │\n```');
  });
});
