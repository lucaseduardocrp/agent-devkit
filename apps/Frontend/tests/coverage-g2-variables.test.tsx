import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiCollection } from '../src/features/apitests/api-test-types.js';
import { IntegrationTestsSkeleton } from '../src/features/apitests/ApiTestSkeletons.js';
import { VariableInput } from '../src/features/apitests/VariableInput.js';
import {
  VariablesContext,
  variableSuggestions,
  type VariableSuggestion,
} from '../src/features/apitests/variables-context.js';

describe('variableSuggestions', () => {
  const collection = {
    variables: [
      { key: 'baseUrl', value: 'https://api.test' },
      { key: 'off', value: 'x', enabled: false },
      { key: 'token', value: 'collection-token', secret: true },
    ],
    items: [
      {
        id: 'login',
        type: 'request',
        name: 'Login',
        method: 'POST',
        url: '/login',
        headers: [],
        query: [],
        body: { mode: 'none' },
        auth: { type: 'inherit' },
        assertions: [],
        captures: [{ variable: 'jwt', source: 'json', path: 'token' }],
      },
    ],
  } as unknown as Pick<ApiCollection, 'variables' | 'items'>;

  it('puts runtime first, then environment, collection, captures and mocks without repeats', () => {
    const list = variableSuggestions(
      collection,
      {
        variables: [
          { key: 'token', value: 'env-token', secret: true },
          { key: 'region', value: 'eu' },
          { key: 'disabled', value: 'no', enabled: false },
        ],
      },
      [{ name: '$randomName', group: 'person', sample: 'Ana' }],
      [
        { key: 'region', value: 'runtime-region' },
        { key: 'skip', value: 'no', enabled: false },
        { key: '', value: 'nameless' },
      ],
    );
    expect(list.map((item) => `${item.source}:${item.name}`)).toEqual([
      'runtime:region',
      'environment:token',
      'collection:baseUrl',
      'capture:jwt',
      'dynamic:$randomName',
    ]);
    expect(list[0]!.value).toBe('runtime-region');
    expect(list[1]).toMatchObject({ value: 'env-token', secret: true });
  });

  it('works without a collection or an environment', () => {
    const list = variableSuggestions(null, null);
    expect(list.every((item) => item.source === 'dynamic')).toBe(true);
  });
});

describe('IntegrationTestsSkeleton', () => {
  afterEach(() => window.localStorage.removeItem('adk.integrationTests.layout'));

  it('stacks the panes when the screen was left in the vertical layout', () => {
    window.localStorage.setItem('adk.integrationTests.layout', 'vertical');
    const { container } = render(<IntegrationTestsSkeleton />);
    expect(container.querySelectorAll('.flex-col.min-h-0.flex-1').length).toBeGreaterThan(0);
    expect(container.querySelector('.h-px.shrink-0')).not.toBeNull();
  });

  it('puts the panes side by side by default', () => {
    const { container } = render(<IntegrationTestsSkeleton />);
    expect(container.querySelector('.w-px.shrink-0')).not.toBeNull();
    expect(container.querySelector('.h-px.shrink-0')).toBeNull();
  });
});

const VARIABLES: VariableSuggestion[] = [
  { name: 'baseUrl', source: 'collection', value: 'https://api.test' },
  { name: 'password', source: 'environment', secret: true },
  { name: 'token', source: 'runtime', value: 'abc' },
  { name: 'jwt', source: 'capture' },
  { name: 'bar', source: 'dynamic', value: 'sample' },
];

function Field({
  initial = '',
  variables = VARIABLES,
  onKeyDown,
  onBlur,
  ...rest
}: {
  initial?: string;
  variables?: VariableSuggestion[] | null;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onBlur?: (event: React.FocusEvent<HTMLInputElement>) => void;
} & Partial<React.ComponentProps<typeof VariableInput>>) {
  const [value, setValue] = useState(initial);
  return (
    <VariablesContext.Provider value={variables}>
      <VariableInput
        aria-label="Campo"
        value={value}
        onValueChange={setValue}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        {...rest}
      />
      <output data-testid="value">{value}</output>
    </VariablesContext.Provider>
  );
}

const field = () => screen.getByLabelText('Campo') as HTMLInputElement;

/** Types into the focused field with the caret at the end. */
function type(text: string) {
  const input = field();
  input.focus();
  fireEvent.change(input, { target: { value: text } });
  input.setSelectionRange(text.length, text.length);
  fireEvent.keyUp(input, { key: 'x' });
}

describe('VariableInput', () => {
  it('is a plain input outside a variables provider', () => {
    const onValueChange = vi.fn();
    const onKeyDown = vi.fn();
    const onBlur = vi.fn();
    render(
      <VariableInput
        aria-label="Campo"
        value="a"
        mono
        className="extra"
        onValueChange={onValueChange}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
      />,
    );
    fireEvent.change(field(), { target: { value: 'ab' } });
    expect(onValueChange).toHaveBeenCalledWith('ab');
    fireEvent.keyDown(field(), { key: 'a' });
    expect(onKeyDown).toHaveBeenCalled();
    fireEvent.blur(field());
    expect(onBlur).toHaveBeenCalled();
    expect(field().className).toContain('font-mono');
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
  });

  it('highlights known variables and flags unknown ones', () => {
    const { container } = render(<Field initial="{{baseUrl}}/x/{{ nope }}" mono />);
    const chips = container.querySelectorAll('[aria-hidden="true"] span span');
    expect(chips).toHaveLength(2);
    expect(chips[0]!.className).toContain('success');
    expect(chips[1]!.className).toContain('danger');
  });

  it('styles the highlight layer for a small, disabled field', () => {
    const { container } = render(
      <Field initial="x" inputSize="sm" disabled className="text-xs" containerClassName="wide" />,
    );
    const layer = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(layer.className).toContain('px-2.5');
    expect(layer.className).toContain('opacity-50');
    expect(layer.className).toContain('text-xs');
    expect(container.firstElementChild!.className).toContain('wide');
  });

  it('suggests while typing {{ and completes with Enter, replacing the rest of the token', () => {
    render(<Field />);
    type('{{ba');
    expect(field().getAttribute('aria-expanded')).toBe('true');
    const list = screen.getByTestId('variable-suggestions');
    // Names that start with what was typed come before those that merely contain it.
    const names = within(list)
      .getAllByRole('option')
      .map((option) => option.firstElementChild!.textContent);
    expect(names).toEqual(['baseUrl', 'bar']);
    expect(within(list).getAllByRole('option')[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(screen.getByTestId('value').textContent).toBe('{{baseUrl}}');
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
  });

  it('shows the value, hides secrets and names where each variable comes from', () => {
    render(<Field />);
    type('{{');
    const list = screen.getByTestId('variable-suggestions');
    expect(within(list).getByText('https://api.test')).toBeTruthy();
    expect(within(list).getByText('••••••')).toBeTruthy();
    expect(within(list).getAllByRole('option')).toHaveLength(5);
    expect(list.textContent).toContain('sample');
  });

  it('moves through the suggestions with the arrows and wraps around', () => {
    const onKeyDown = vi.fn();
    render(<Field onKeyDown={onKeyDown} />);
    type('{{');
    const selected = () =>
      within(screen.getByTestId('variable-suggestions'))
        .getAllByRole('option')
        .findIndex((option) => option.getAttribute('aria-selected') === 'true');
    fireEvent.keyDown(field(), { key: 'ArrowUp' });
    expect(selected()).toBe(4);
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(selected()).toBe(0);
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    expect(selected()).toBe(1);
    // Keys the menu handles are not passed on.
    expect(onKeyDown).not.toHaveBeenCalled();
    fireEvent.keyDown(field(), { key: 'a' });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(field(), { key: 'Tab' });
    expect(screen.getByTestId('value').textContent).toBe('{{password}}');
  });

  it('closes on Escape without reaching outer handlers', () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <Field />
      </div>,
    );
    type('{{');
    fireEvent.keyDown(field(), { key: 'Escape' });
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });

  it('chooses with the mouse, hovering first, and keeps the caret after the token', () => {
    const frame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    render(<Field initial="" />);
    type('{{');
    const options = within(screen.getByTestId('variable-suggestions')).getAllByRole('option');
    fireEvent.mouseEnter(options[2]!);
    expect(
      within(screen.getByTestId('variable-suggestions'))
        .getAllByRole('option')[2]!
        .getAttribute('aria-selected'),
    ).toBe('true');
    fireEvent.mouseDown(options[2]!);
    expect(screen.getByTestId('value').textContent).toBe('{{token}}');
    expect(field().selectionStart).toBe('{{token}}'.length);
    expect(document.activeElement).toBe(field());
    frame.mockRestore();
  });

  it('replaces the rest of a token when completing in the middle of it', () => {
    render(<Field initial="a {{ba}} b" />);
    const input = field();
    input.focus();
    input.setSelectionRange(6, 6);
    fireEvent.click(input);
    expect(screen.getByTestId('variable-suggestions')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('value').textContent).toBe('a {{baseUrl}} b');
  });

  it('keeps the highlighted entry while the text it started from still matches', () => {
    render(<Field />);
    type('{{');
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    fireEvent.keyDown(field(), { key: 'ArrowDown' });
    // Narrowing the list inside the same token clamps the highlighted entry to the last one.
    type('{{ba');
    const options = within(screen.getByTestId('variable-suggestions')).getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[1]!.getAttribute('aria-selected')).toBe('true');
    // Starting a new token resets it.
    type('{{ba x {{');
    expect(
      within(screen.getByTestId('variable-suggestions'))
        .getAllByRole('option')[0]!
        .getAttribute('aria-selected'),
    ).toBe('true');
  });

  it('closes without suggestions: no match, no {{, no focus or after a blur', () => {
    const onBlur = vi.fn();
    render(<Field onBlur={onBlur} />);
    type('{{zzz');
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
    type('plain');
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
    type('{{ba');
    expect(screen.getByTestId('variable-suggestions')).toBeTruthy();
    fireEvent.blur(field());
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
    expect(onBlur).toHaveBeenCalledTimes(1);
    // Without focus, a click or a key up does not open anything.
    field().blur();
    fireEvent.click(field());
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
  });

  it('closes the list when the window resizes or scrolls', () => {
    render(<Field />);
    type('{{');
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
    type('{{');
    act(() => {
      window.dispatchEvent(new Event('scroll'));
    });
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
  });

  it('syncs the highlight layer with the scroll of the input and ignores navigation keys', () => {
    const { container } = render(<Field initial="abc" />);
    const input = field();
    input.scrollLeft = 12;
    fireEvent.scroll(input);
    expect((container.querySelector('[aria-hidden="true"]') as HTMLElement).scrollLeft).toBe(12);
    // Navigation keys do not refresh the list.
    input.focus();
    input.setSelectionRange(3, 3);
    fireEvent.keyUp(input, { key: 'Enter' });
    expect(screen.queryByTestId('variable-suggestions')).toBeNull();
  });

  it('does nothing when choosing without a menu', () => {
    render(<Field />);
    // Enter with no menu goes to the outer handler.
    const outer = vi.fn();
    field().addEventListener('keydown', outer);
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(outer).toHaveBeenCalled();
    expect(screen.getByTestId('value').textContent).toBe('');
  });

  it('falls back to the end of the text when the field reports no caret', () => {
    render(<Field initial="{{ba" />);
    const input = field();
    Object.defineProperty(input, 'selectionStart', { configurable: true, get: () => null });
    input.focus();
    fireEvent.click(input);
    expect(screen.getByTestId('variable-suggestions')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('value').textContent).toBe('{{baseUrl}}');
  });

  it('adds the padding of the field to where the list opens', () => {
    render(<Field />);
    field().style.paddingLeft = '10px';
    type('{{');
    expect(screen.getByTestId('variable-suggestions').style.left).toBe('10px');
  });

  it('opens at the left edge of the field when its padding is unknown', () => {
    render(<Field />);
    const spy = vi
      .spyOn(window, 'getComputedStyle')
      .mockReturnValue({ paddingLeft: 'auto', font: '' } as unknown as CSSStyleDeclaration);
    type('{{');
    spy.mockRestore();
    expect(screen.getByTestId('variable-suggestions').style.left).toBe('8px');
  });

  it('measures the caret from the text before the token', () => {
    render(<Field />);
    const input = field();
    input.getBoundingClientRect = () =>
      ({ left: 100, bottom: 40, top: 20, width: 200, height: 20, right: 300 }) as DOMRect;
    type('prefix {{');
    const list = screen.getByTestId('variable-suggestions');
    expect(list.style.top).toBe('44px');
    expect(list.style.left).toMatch(/px$/);
  });
});
