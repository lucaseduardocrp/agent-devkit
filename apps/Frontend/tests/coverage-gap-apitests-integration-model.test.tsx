import { fireEvent, render, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiItem } from '../src/features/apitests/api-test-types.js';
import { EnvironmentsPane } from '../src/features/apitests/integration/EnvironmentsPane.js';
import {
  cloneItem,
  composeUrl,
  fillPathParams,
  findRequest,
  formatDuration,
  prettyBody,
  sameUrl,
  statusLine,
  toCurl,
} from '../src/features/apitests/integration/integration-model.js';
import { VariableInput } from '../src/features/apitests/VariableInput.js';
import { VariablesContext } from '../src/features/apitests/variables-context.js';
import type { ApiClient } from '../src/lib/api-client.js';

afterEach(() => vi.restoreAllMocks());

const request = {
  id: 'r',
  type: 'request',
  name: 'R',
  method: 'GET',
  url: 'https://api.test/:id/:other',
  headers: [],
  query: [],
  body: { mode: 'none' },
  auth: { type: 'bearer', token: 'abc' },
  assertions: [{ id: 'a', source: 'status', operator: 'eq', expected: '200' }],
  captures: [],
  pathParams: [{ key: 'id', value: '7' }],
} as unknown as Extract<ApiItem, { type: 'request' }>;

describe('integration-model formatting and tree helpers', () => {
  it('describes statuses, durations and bodies', () => {
    expect(statusLine(299)).toBe('299');
    expect(formatDuration(1500)).toBe('1.50s');
    expect(prettyBody('<a/>').language).toBe('xml');
    expect(prettyBody('plain')).toEqual({ code: 'plain', language: 'plaintext' });
  });

  it('finds only requests and clones folders with new ids', () => {
    const folder: ApiItem = { id: 'f', type: 'folder', name: 'F', items: [request] };
    expect(findRequest([folder], 'f')).toBeNull();
    expect(findRequest([folder], 'missing')).toBeNull();
    expect(findRequest([folder], 'r')).toBe(request);
    const copy = cloneItem(folder, 'F copy');
    expect(copy.name).toBe('F copy');
    expect(copy.id).not.toBe('f');
    const inner = (copy as Extract<ApiItem, { type: 'folder' }>).items[0] as typeof request;
    expect(inner.id).not.toBe('r');
    expect(inner.assertions[0]!.id).not.toBe('a');
  });

  it('keeps unknown path params and writes bearer auth', () => {
    expect(fillPathParams(request.url, request.pathParams)).toBe('https://api.test/7/:other');
    expect(toCurl(request, { auth: { type: 'none' } })).toContain(`-H 'Authorization: Bearer abc'`);
  });

  it('composes the URL bar from the enabled query rows', () => {
    const rows = [
      { key: 'a', value: '1' },
      { key: 'flag', value: '' },
      { key: '', value: '' },
      { key: 'off', value: 'x', enabled: false },
    ];
    expect(composeUrl('/x', rows)).toBe('/x?a=1&flag');
    expect(composeUrl('/x?z=0', [{ key: 'a', value: '1' }])).toBe('/x?z=0&a=1');
    expect(composeUrl('/x', [])).toBe('/x');
    expect(sameUrl('/x?=v', '/x', [{ key: '', value: 'v' }])).toBe(true);
  });
});

describe('VariableInput details', () => {
  it('completes at the end of the text when the caret is unknown and forwards blur', () => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0);
    const onBlur = vi.fn();
    function Field() {
      const [value, setValue] = useState('');
      return (
        <VariablesContext.Provider value={[{ name: 'baseUrl', source: 'collection' }]}>
          <VariableInput aria-label="URL" value={value} onValueChange={setValue} onBlur={onBlur} />
        </VariablesContext.Provider>
      );
    }
    const view = render(<Field />);
    const input = view.getByLabelText('URL') as HTMLInputElement;
    Object.defineProperty(input, 'selectionStart', { configurable: true, get: () => null });
    input.focus();
    fireEvent.change(input, { target: { value: '{{b' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('{{baseUrl}}');
    fireEvent.blur(input);
    expect(onBlur).toHaveBeenCalled();
  });
});

describe('EnvironmentsPane errors', () => {
  it('shows save errors and non-Error delete failures', async () => {
    const api = {
      saveApiEnvironment: vi.fn(() => Promise.reject(new Error('name taken'))),
      deleteApiEnvironment: vi.fn().mockRejectedValue('locked'),
    };
    const view = render(
      <EnvironmentsPane
        apiClient={api as unknown as ApiClient}
        environments={[{ id: 'e1', name: 'Staging', variables: [] }]}
        activeId=""
        readOnly={false}
        onChanged={vi.fn()}
        onActivate={vi.fn()}
      />,
    );
    fireEvent.change(view.getByTestId('environment-name'), { target: { value: 'Prod' } });
    fireEvent.click(view.getByTestId('save-environment'));
    expect((await view.findByRole('alert')).textContent).toBe('name taken');
    fireEvent.click(view.getByRole('button', { name: /Excluir/ }));
    const dialog = await view.findByRole('alertdialog');
    fireEvent.click(dialog.querySelectorAll('button')[1]!);
    await waitFor(() => expect(view.getByRole('alert').textContent).toBe('locked'));
  });
});

describe('VariableInput placement', () => {
  it('places the suggestions when the input has no computed padding', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      paddingLeft: '',
      font: '',
    } as CSSStyleDeclaration);
    function Field() {
      const [value, setValue] = useState('');
      return (
        <VariablesContext.Provider value={[{ name: 'baseUrl', source: 'collection' }]}>
          <VariableInput aria-label="URL" value={value} onValueChange={setValue} />
        </VariablesContext.Provider>
      );
    }
    const view = render(<Field />);
    const input = view.getByLabelText('URL') as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: '{{', selectionStart: 2, selectionEnd: 2 } });
    expect(view.getByTestId('variable-suggestions').style.left).toBe('8px');
  });
});
