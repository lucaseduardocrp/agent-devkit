import { fireEvent, render, waitFor, within } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ApiCollection,
  ApiEnvironment,
  ApiItem,
  ApiRun,
  CollectionRunResult,
} from '../src/features/apitests/api-test-types.js';
import { CollectionRunner } from '../src/features/apitests/integration/CollectionRunner.js';
import { CollectionSettingsPane } from '../src/features/apitests/integration/CollectionSettingsPane.js';
import { EnvironmentsPane } from '../src/features/apitests/integration/EnvironmentsPane.js';
import {
  addItem,
  formatSize,
  insertAfter,
  itemMatches,
  readLayout,
  removeItem,
  requestIds,
  sameUrl,
  splitUrl,
  toCurl,
  writeLayout,
} from '../src/features/apitests/integration/integration-model.js';
import { VariableInput } from '../src/features/apitests/VariableInput.js';
import {
  VariablesContext,
  variableSuggestions,
  type VariableSuggestion,
} from '../src/features/apitests/variables-context.js';
import type { ApiClient } from '../src/lib/api-client.js';

const request = (id: string, extra: Partial<ApiItem> = {}): ApiItem =>
  ({
    id,
    type: 'request',
    name: id,
    method: 'GET',
    url: `https://api.test/${id}`,
    headers: [],
    query: [],
    body: { mode: 'none' },
    auth: { type: 'inherit' },
    assertions: [],
    captures: [],
    ...extra,
  }) as ApiItem;

const tree: ApiItem[] = [
  request('a'),
  { id: 'f', type: 'folder', name: 'Folder', items: [request('b'), request('c')] },
];

const collection: ApiCollection = {
  id: 'c1',
  workspaceId: 'w1',
  name: 'Orders API',
  variables: [{ key: 'baseUrl', value: 'https://api.test' }],
  auth: { type: 'none' },
  source: { kind: 'postman' },
  updatedAt: '2026-10-24T10:00:00Z',
  items: tree,
};

afterEach(() => vi.restoreAllMocks());

describe('integration-model helpers', () => {
  it('formats sizes in bytes, kilobytes and megabytes', () => {
    expect(formatSize(10)).toBe('10B');
    expect(formatSize(2048)).toBe('2.00KB');
    expect(formatSize(3 * 1024 * 1024)).toBe('3.00MB');
  });

  it('adds, removes, inserts and finds requests in the tree', () => {
    expect(requestIds(removeItem(tree, 'b'))).toEqual(['a', 'c']);
    expect(requestIds(addItem(tree, null, request('z')))).toEqual(['a', 'b', 'c', 'z']);
    expect(requestIds(addItem(tree, 'f', request('z')))).toEqual(['a', 'b', 'c', 'z']);
    // A request is not a folder: nothing is added to it.
    expect(requestIds(addItem(tree, 'a', request('z')))).toEqual(['a', 'b', 'c']);
    expect(requestIds(insertAfter(tree, 'b', request('z')))).toEqual(['a', 'b', 'z', 'c']);
    expect(itemMatches(tree[1]!, 'folder')).toBe(true);
    expect(itemMatches(tree[1]!, 'api.test/c')).toBe(true);
    expect(itemMatches(tree[1]!, 'nothing')).toBe(false);
  });

  it('remembers the layout and survives blocked storage', () => {
    writeLayout('vertical');
    expect(readLayout()).toBe('vertical');
    writeLayout('horizontal');
    expect(readLayout()).toBe('horizontal');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => writeLayout('vertical')).not.toThrow();
    expect(readLayout()).toBe('horizontal');
  });

  it('writes every kind of auth and body as cURL', () => {
    const base = request('x', {
      url: 'https://api.test/x?a=1',
      query: [{ key: 'b', value: '2' }],
    }) as Extract<ApiItem, { type: 'request' }>;
    const curl = (patch: object, auth: ApiCollection['auth'] = { type: 'none' }) =>
      toCurl({ ...base, ...patch }, { auth });

    expect(curl({})).toContain(`'https://api.test/x?a=1&b=2'`);
    expect(curl({}, { type: 'basic', username: 'u', password: 'p' })).toContain(`-u 'u:p'`);
    expect(curl({ auth: { type: 'apikey', key: 'X-Key', value: 'k', in: 'header' } })).toContain(
      `-H 'X-Key: k'`,
    );
    expect(curl({ auth: { type: 'apikey', key: 'X-Key', value: 'k', in: 'query' } })).not.toContain(
      'X-Key',
    );
    expect(curl({ headers: [{ key: 'X-A', value: '1' }] })).toContain(`-H 'X-A: 1'`);
    const text = curl({ body: { mode: 'text', content: '' } });
    expect(text).toContain('Content-Type: text/plain');
    expect(text).not.toContain('--data-raw');
    expect(
      curl({
        headers: [{ key: 'content-type', value: 'application/xml' }],
        body: { mode: 'xml', content: '<a/>' },
      }),
    ).not.toContain("'Content-Type: application/xml'");
    expect(
      curl({
        body: {
          mode: 'urlencoded',
          fields: [
            { key: 'a', value: '1' },
            { key: '', value: '' },
          ],
        },
      }),
    ).toContain(`--data-urlencode 'a=1'`);
    expect(curl({ body: { mode: 'form', fields: [{ key: 'f', value: 'v' }] } })).toContain(
      `-F 'f=v'`,
    );
  });

  it('splits and compares URLs with a query', () => {
    expect(splitUrl('/x?a=1&&b', [{ key: 'off', value: '', enabled: false }])).toEqual({
      url: '/x',
      query: [
        { key: 'a', value: '1' },
        { key: 'b', value: '' },
        { key: 'off', value: '', enabled: false },
      ],
    });
    expect(sameUrl('/x?a', '/x', [{ key: 'a', value: '' }])).toBe(true);
    expect(sameUrl('/x?a=1', '/x', [{ key: 'a', value: '2' }])).toBe(false);
    expect(sameUrl('/y', '/x', [])).toBe(false);
  });
});

describe('variableSuggestions', () => {
  it('lists enabled collection variables after the environment ones', () => {
    const list = variableSuggestions(
      {
        variables: [
          { key: 'baseUrl', value: 'col' },
          { key: 'only', value: '1', secret: true },
          { key: 'off', value: '', enabled: false },
        ],
        items: [],
      },
      { variables: [{ key: 'baseUrl', value: 'env' }] },
      [{ name: '$x', group: 'ids', sample: '' }],
    );
    expect(list).toEqual([
      { name: 'baseUrl', source: 'environment', value: 'env', secret: undefined },
      { name: 'only', source: 'collection', value: '1', secret: true },
      { name: '$x', source: 'dynamic' },
    ]);
  });
});

const suggestions: VariableSuggestion[] = [
  { name: 'baseUrl', source: 'environment', value: 'https://api.test' },
  { name: 'token', source: 'capture' },
];

function Field({
  variables = suggestions,
  onKeyDown,
  initial = '',
}: {
  readonly variables?: VariableSuggestion[] | null;
  readonly onKeyDown?: (event: React.KeyboardEvent) => void;
  readonly initial?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <VariablesContext.Provider value={variables}>
      <VariableInput
        aria-label="URL"
        value={value}
        onValueChange={setValue}
        onKeyDown={onKeyDown}
        inputSize="sm"
        className="text-xs"
        mono
        disabled={false}
      />
    </VariablesContext.Provider>
  );
}

const type = (input: HTMLInputElement, value: string) => {
  input.focus();
  fireEvent.change(input, {
    target: { value, selectionStart: value.length, selectionEnd: value.length },
  });
};

describe('VariableInput', () => {
  it('is a plain input outside a variables provider', () => {
    const view = render(<Field variables={null} />);
    const input = view.getByLabelText('URL') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'plain' } });
    expect(input.value).toBe('plain');
    expect(view.queryByTestId('variable-suggestions')).toBeNull();
  });

  it('moves through the suggestions with the keyboard and the mouse', () => {
    const onKeyDown = vi.fn();
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      paddingLeft: '12px',
      font: '',
    } as CSSStyleDeclaration);
    const view = render(<Field onKeyDown={onKeyDown} />);
    const input = view.getByLabelText('URL') as HTMLInputElement;
    type(input, '{{');
    const list = view.getByTestId('variable-suggestions');
    const options = within(list).getAllByRole('option');
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(
      within(view.getByTestId('variable-suggestions'))
        .getAllByRole('option')[1]!
        .getAttribute('aria-selected'),
    ).toBe('true');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.mouseEnter(
      within(view.getByTestId('variable-suggestions')).getAllByRole('option')[1]!,
    );
    expect(
      within(view.getByTestId('variable-suggestions'))
        .getAllByRole('option')[1]!
        .getAttribute('aria-selected'),
    ).toBe('true');
    // Other keys reach the caller.
    fireEvent.keyDown(input, { key: 'a' });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    // Typing more keeps the highlighted entry when it still fits.
    fireEvent.keyUp(input, { key: 'b' });
    fireEvent.keyUp(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input.value).toBe('{{token}}');
    expect(view.queryByTestId('variable-suggestions')).toBeNull();
  });

  it('closes the suggestions on Escape, blur, scroll and when nothing fits', () => {
    const view = render(<Field />);
    const input = view.getByLabelText('URL') as HTMLInputElement;
    type(input, '{{');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(view.queryByTestId('variable-suggestions')).toBeNull();
    type(input, '{{t');
    fireEvent.scroll(window);
    expect(view.queryByTestId('variable-suggestions')).toBeNull();
    type(input, '{{t');
    fireEvent(window, new Event('resize'));
    expect(view.queryByTestId('variable-suggestions')).toBeNull();
    type(input, '{{zzz');
    expect(view.queryByTestId('variable-suggestions')).toBeNull();
    type(input, 'no token');
    expect(view.queryByTestId('variable-suggestions')).toBeNull();
    type(input, '{{t');
    fireEvent.blur(input);
    input.blur();
    expect(view.queryByTestId('variable-suggestions')).toBeNull();
    // Without focus nothing is suggested.
    fireEvent.click(input);
    expect(view.queryByTestId('variable-suggestions')).toBeNull();
  });

  it('completes a suggestion picked with the mouse and colors unknown variables', async () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 0;
    });
    const view = render(<Field initial="{{nope}}" />);
    const input = view.getByLabelText('URL') as HTMLInputElement;
    expect(view.container.querySelector('.bg-\\[var\\(--bg-danger\\)\\]')?.textContent).toBe(
      '{{nope}}',
    );
    type(input, '{{bas');
    fireEvent.mouseDown(within(view.getByTestId('variable-suggestions')).getByText('baseUrl'));
    await waitFor(() => expect(input.value).toBe('{{baseUrl}}'));
    expect(raf).toHaveBeenCalled();
    expect(input.selectionStart).toBe('{{baseUrl}}'.length);
  });
});

describe('CollectionSettingsPane', () => {
  it('edits the overview, variables and auth, exports and deletes', () => {
    const onChange = vi.fn();
    const onExport = vi.fn();
    const onDelete = vi.fn();
    const view = render(
      <CollectionSettingsPane
        collection={{ ...collection, description: 'Docs' }}
        readOnly={false}
        onChange={onChange}
        onExport={onExport}
        onDelete={onDelete}
      />,
    );
    expect(view.getByText('Postman')).toBeTruthy();
    expect(view.getByText('3')).toBeTruthy();
    fireEvent.change(view.getByTestId('collection-name'), { target: { value: 'Orders v2' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Orders v2' }));
    fireEvent.change(view.getByDisplayValue('Docs'), { target: { value: 'New docs' } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ description: 'New docs' }));
    fireEvent.click(view.getByRole('button', { name: /Bruno/ }));
    expect(onExport).toHaveBeenCalledWith('bruno');
    fireEvent.click(view.getByRole('button', { name: 'Excluir coleção' }));
    expect(onDelete).toHaveBeenCalled();

    fireEvent.click(view.getByRole('tab', { name: /Variáveis/ }));
    fireEvent.change(view.getByLabelText('baseUrl'), { target: { value: 'https://new' } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ variables: [{ key: 'baseUrl', value: 'https://new' }] }),
    );

    fireEvent.click(view.getByRole('tab', { name: /Auth/ }));
    fireEvent.change(view.getByLabelText('Autenticação'), { target: { value: 'bearer' } });
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ auth: { type: 'bearer', token: '{{token}}' } }),
    );
  });

  it('shows unknown sources as they are and hides deletion when read-only', () => {
    const view = render(
      <CollectionSettingsPane
        collection={{
          ...collection,
          source: { kind: 'custom' },
          auth: { type: 'bearer', token: 't' },
          updatedAt: '',
        }}
        readOnly
        onChange={vi.fn()}
        onExport={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(view.getByText('custom')).toBeTruthy();
    expect(view.getByText('—')).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Excluir coleção' })).toBeNull();
    expect((view.getByTestId('collection-name') as HTMLInputElement).disabled).toBe(true);
  });
});

const environments: ApiEnvironment[] = [
  { id: 'e1', name: 'Staging', variables: [{ key: 'baseUrl', value: 'https://stg' }] },
  { id: 'e2', name: 'Prod', variables: [] },
] as ApiEnvironment[];

function environmentsClient() {
  return {
    saveApiEnvironment: vi.fn((draft: ApiEnvironment, id?: string) =>
      Promise.resolve({ ...draft, id: id ?? 'e3' }),
    ),
    deleteApiEnvironment: vi.fn(() => Promise.resolve()),
  };
}

describe('EnvironmentsPane', () => {
  it('creates, edits, activates and deletes environments', async () => {
    const api = environmentsClient();
    const onChanged = vi.fn(() => Promise.resolve());
    const onActivate = vi.fn();
    const view = render(
      <EnvironmentsPane
        apiClient={api as unknown as ApiClient}
        environments={environments}
        activeId=""
        readOnly={false}
        onChanged={onChanged}
        onActivate={onActivate}
      />,
    );
    const name = view.getByTestId('environment-name') as HTMLInputElement;
    expect(name.value).toBe('Staging');
    const save = view.getByTestId('save-environment') as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'Staging 2' } });
    fireEvent.change(view.getByLabelText('baseUrl'), { target: { value: 'https://stg2' } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(api.saveApiEnvironment).toHaveBeenCalledWith(
        { name: 'Staging 2', variables: [{ key: 'baseUrl', value: 'https://stg2' }] },
        'e1',
      ),
    );
    expect(await view.findByRole('status')).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();

    fireEvent.click(view.getByRole('button', { name: 'Usar este ambiente' }));
    expect(onActivate).toHaveBeenCalledWith('e1');

    // A new one starts with a baseUrl row and is saved without an id.
    fireEvent.click(view.getByTestId('new-environment'));
    expect(name.value).toBe('');
    fireEvent.change(name, { target: { value: 'Dev' } });
    fireEvent.click(save);
    await waitFor(() =>
      expect(api.saveApiEnvironment).toHaveBeenLastCalledWith(
        { name: 'Dev', variables: [{ key: 'baseUrl', value: '' }] },
        undefined,
      ),
    );

    fireEvent.click(view.getByRole('button', { name: 'Prod' }));
    fireEvent.click(view.getByRole('button', { name: /Excluir/ }));
    fireEvent.click(await view.findByRole('button', { name: 'Cancelar' }));
    fireEvent.click(view.getByRole('button', { name: /Excluir/ }));
    const dialog = await view.findByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(api.deleteApiEnvironment).toHaveBeenCalledWith('e2'));
    expect(onActivate).toHaveBeenCalledTimes(1);
  });

  it('deactivates the active environment it deletes and shows errors', async () => {
    const api = environmentsClient();
    api.deleteApiEnvironment.mockRejectedValueOnce(new Error('in use'));
    api.saveApiEnvironment.mockRejectedValueOnce('boom');
    const onActivate = vi.fn();
    const view = render(
      <EnvironmentsPane
        apiClient={api as unknown as ApiClient}
        environments={environments}
        activeId="e2"
        readOnly={false}
        onChanged={vi.fn()}
        onActivate={onActivate}
      />,
    );
    expect((view.getByTestId('environment-name') as HTMLInputElement).value).toBe('Prod');
    fireEvent.change(view.getByTestId('environment-name'), { target: { value: 'Prod 2' } });
    fireEvent.click(view.getByTestId('save-environment'));
    expect((await view.findByRole('alert')).textContent).toBe('boom');

    const deleteOnce = async () => {
      fireEvent.click(view.getByRole('button', { name: /Excluir/ }));
      const dialog = await view.findByRole('alertdialog');
      fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir' }));
    };
    await deleteOnce();
    await waitFor(() => expect(view.getByRole('alert').textContent).toBe('in use'));
    await deleteOnce();
    await waitFor(() => expect(onActivate).toHaveBeenCalledWith(''));
  });

  it('shows an empty page to read-only members without environments', () => {
    const view = render(
      <EnvironmentsPane
        apiClient={environmentsClient() as unknown as ApiClient}
        environments={[]}
        activeId=""
        readOnly
        onChanged={vi.fn()}
        onActivate={vi.fn()}
      />,
    );
    expect(view.getByText('Nenhum ambiente ainda.')).toBeTruthy();
    expect(view.queryByTestId('new-environment')).toBeNull();
  });
});

const result = (id: string, passed: boolean, status: number | null) => ({
  requestId: id,
  name: id,
  path: [],
  method: 'GET' as const,
  url: `https://api.test/${id}`,
  status,
  durationMs: 10,
  sizeBytes: 1,
  passed,
  assertions: [],
});

const run = (patch: Partial<ApiRun<CollectionRunResult>>): ApiRun<CollectionRunResult> => ({
  id: 'r1',
  kind: 'integration',
  collectionId: 'c1',
  scenarioId: null,
  environmentId: null,
  name: 'Orders API',
  target: 'remote',
  status: 'running',
  claimLabel: null,
  error: null,
  createdAt: '2026-10-24T10:00:00Z',
  startedAt: null,
  finishedAt: null,
  result: null,
  ...patch,
});

function renderRunner(props: Partial<React.ComponentProps<typeof CollectionRunner>> = {}) {
  const handlers = {
    onRun: vi.fn(),
    onCancel: vi.fn(),
    onReset: vi.fn(),
    onOpenRequest: vi.fn(),
  };
  const view = render(
    <CollectionRunner
      collection={collection}
      run={null}
      target="remote"
      readOnly={false}
      {...handlers}
      {...props}
    />,
  );
  return { view, ...handlers };
}

describe('CollectionRunner', () => {
  it('runs only the selected requests and stops on the first failure', () => {
    const { view, onRun } = renderRunner();
    fireEvent.click(view.getByLabelText('b'));
    fireEvent.click(view.getByText('Parar na primeira falha'));
    fireEvent.click(view.getByTestId('run-collection'));
    expect(onRun).toHaveBeenLastCalledWith({ itemIds: ['a', 'c'], bail: true });
    fireEvent.click(view.getByLabelText('b'));
    fireEvent.click(view.getByTestId('run-collection'));
    expect(onRun).toHaveBeenLastCalledWith({ itemIds: [], bail: true });
    fireEvent.click(view.getByText('Selecionar todas'));
    expect((view.getByTestId('run-collection') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(view.getByText('Selecionar todas'));
    expect((view.getByTestId('run-collection') as HTMLButtonElement).disabled).toBe(false);
  });

  it('says when the collection has no requests', () => {
    const { view } = renderRunner({ collection: { ...collection, items: [] }, readOnly: true });
    expect(view.getByText('A coleção não tem requisições.')).toBeTruthy();
    expect(view.queryByTestId('run-collection')).toBeNull();
  });

  it('shows progress, filters results and cancels an active run', () => {
    const { view, onCancel, onOpenRequest } = renderRunner({
      run: run({
        status: 'running',
        error: 'worker lost',
        result: {
          durationMs: 30,
          total: 4,
          passed: 1,
          failed: 1,
          results: [result('a', true, 200), result('b', false, null)],
        },
      }),
    });
    expect(view.container.querySelector('[style*="width: 50%"]')).toBeTruthy();
    expect(view.getByRole('alert').textContent).toBe('worker lost');
    expect(view.getByText('—')).toBeTruthy();
    const filters = view.getByRole('group');
    fireEvent.click(within(filters).getByRole('button', { name: 'Passaram' }));
    expect(view.queryByText('b')).toBeNull();
    fireEvent.click(within(filters).getByRole('button', { name: 'Falharam' }));
    expect(view.queryByText('a')).toBeNull();
    fireEvent.click(view.getAllByRole('button', { name: 'Abrir requisição' })[0]!);
    expect(onOpenRequest).toHaveBeenCalledWith('b');
    fireEvent.click(view.getByRole('button', { name: /Cancelar execução/ }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('runs again or resets a finished run, and waits for the local runner', () => {
    const finished = renderRunner({
      run: run({
        status: 'passed',
        finishedAt: 'not a date',
        createdAt: 'not a date',
        result: {
          durationMs: 5,
          total: 1,
          passed: 1,
          failed: 0,
          results: [result('a', true, 200)],
        },
      }),
    });
    fireEvent.click(finished.view.getByText('a'));
    expect(finished.view.getByTestId('response-status').textContent).toBe('200 OK');
    fireEvent.click(finished.view.getByTestId('run-again'));
    expect(finished.onRun).toHaveBeenCalledWith({ itemIds: [], bail: false });
    fireEvent.click(finished.view.getByRole('button', { name: 'Limpar' }));
    expect(finished.onReset).toHaveBeenCalled();
    finished.view.unmount();

    const queued = renderRunner({ run: run({ status: 'queued', target: 'local' }) });
    expect(queued.view.getByText(/devkit runner/)).toBeTruthy();
    queued.view.unmount();
    const waiting = renderRunner({ run: run({ status: 'running' }) });
    expect(waiting.view.getByText('Aguardando os primeiros resultados…')).toBeTruthy();
  });
});
