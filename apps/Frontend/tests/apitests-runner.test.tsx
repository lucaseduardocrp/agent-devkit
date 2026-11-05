import React from 'react';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ApiCollection,
  ApiRun,
  CollectionRunResult,
  RequestResult,
  RuntimeState,
} from '../src/features/apitests/api-test-types.js';
import { CollectionRunner } from '../src/features/apitests/integration/CollectionRunner.js';
import { RuntimeDialog } from '../src/features/apitests/integration/RuntimePane.js';

const request = (id: string, name: string) => ({
  id,
  type: 'request' as const,
  name,
  method: 'GET' as const,
  url: '/',
  headers: [],
  query: [],
  body: { mode: 'none' as const },
  auth: { type: 'inherit' as const },
  assertions: [],
  captures: [],
});

const collection: ApiCollection = {
  id: 'c1',
  workspaceId: 'w1',
  name: 'Orders API',
  variables: [],
  auth: { type: 'none' },
  source: { kind: 'manual' },
  updatedAt: '',
  items: [request('a', 'Login'), { ...request('b', 'Stream'), kind: 'sse' }],
};

const result = (patch: Partial<RequestResult>): RequestResult => ({
  requestId: 'a',
  name: 'Login',
  path: [],
  method: 'GET',
  url: '/',
  status: 200,
  durationMs: 10,
  sizeBytes: 1,
  passed: true,
  assertions: [{ id: '1', label: 'status', passed: true }],
  ...patch,
});

const run = (patch: Partial<ApiRun<CollectionRunResult>>): ApiRun<CollectionRunResult> => ({
  id: 'r1',
  kind: 'integration',
  collectionId: 'c1',
  scenarioId: null,
  environmentId: null,
  name: 'Orders API',
  target: 'remote',
  status: 'failed',
  claimLabel: null,
  error: null,
  createdAt: '2026-10-24T10:00:00Z',
  startedAt: null,
  finishedAt: null,
  result: {
    durationMs: 1200,
    total: 4,
    passed: 1,
    failed: 2,
    skipped: 1,
    iterations: 2,
    results: [
      result({ iteration: 1, tests: [{ id: 't', label: 'script test', passed: false }] }),
      result({
        iteration: 1,
        requestId: 'b',
        name: 'Stream',
        kind: 'sse',
        status: 500,
        passed: false,
      }),
      result({ iteration: 2, status: null, passed: false }),
      result({ iteration: 2, requestId: 'b', name: 'Stream', skipped: true, status: null }),
    ],
  },
  ...patch,
});

function renderRunner(
  current: ApiRun<CollectionRunResult> | null,
  props: Partial<React.ComponentProps<typeof CollectionRunner>> = {},
) {
  const handlers = {
    onRun: vi.fn(),
    onCancel: vi.fn(),
    onReset: vi.fn(),
    onOpenRequest: vi.fn(),
  };
  const view = render(
    <CollectionRunner
      collection={collection}
      run={current}
      target="remote"
      readOnly={false}
      {...handlers}
      {...props}
    />,
  );
  return { view, ...handlers };
}

afterEach(() => vi.restoreAllMocks());

describe('CollectionRunner', () => {
  it('runs the chosen requests with iterations, delay and bail', () => {
    const { view, onRun } = renderRunner(null);
    fireEvent.change(view.getByTestId('runner-iterations'), { target: { value: '3' } });
    fireEvent.change(view.getByTestId('runner-delay'), { target: { value: '250' } });
    fireEvent.click(view.getByLabelText('Parar na primeira falha'));
    fireEvent.click(view.getByLabelText('Stream'));
    fireEvent.click(view.getByTestId('run-collection'));
    expect(onRun).toHaveBeenCalledWith({
      itemIds: ['a'],
      bail: true,
      iterations: 3,
      delayMs: 250,
    });
    fireEvent.click(view.getByLabelText('Stream'));
    fireEvent.change(view.getByTestId('runner-iterations'), { target: { value: 'x' } });
    fireEvent.change(view.getByTestId('runner-delay'), { target: { value: '' } });
    fireEvent.click(view.getByTestId('run-collection'));
    expect(onRun).toHaveBeenLastCalledWith({ itemIds: [], bail: true, iterations: 1, delayMs: 0 });
    // Select all off and on.
    const all = view.getByLabelText('Selecionar todas', { exact: false });
    fireEvent.click(all);
    expect((view.getByTestId('run-collection') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(all);
    expect((view.getByTestId('run-collection') as HTMLButtonElement).disabled).toBe(false);
  });

  it('previews a CSV data file and runs one iteration per row', async () => {
    const { view, onRun } = renderRunner(null);
    fireEvent.change(view.getByTestId('data-file-input'), {
      target: { files: [new File(['user,pass\n"a, b",1\nc,2'], 'users.csv')] },
    });
    const preview = await view.findByTestId('data-preview');
    expect(within(preview).getByText('2 linhas')).toBeTruthy();
    expect(within(preview).getByText('a, b')).toBeTruthy();
    fireEvent.click(view.getByTestId('run-collection'));
    expect(onRun).toHaveBeenLastCalledWith(
      expect.objectContaining({
        iterations: 2,
        data: [
          { user: 'a, b', pass: '1' },
          { user: 'c', pass: '2' },
        ],
      }),
    );
    // Fewer iterations than rows: only that many.
    fireEvent.change(view.getByTestId('runner-iterations'), { target: { value: '5000' } });
    fireEvent.click(view.getByTestId('run-collection'));
    expect(onRun).toHaveBeenLastCalledWith(expect.objectContaining({ iterations: 2 }));
    fireEvent.click(view.getByRole('button', { name: 'Remover' }));
    expect(view.queryByTestId('data-preview')).toBeNull();
  });

  it('refuses a bad data file', async () => {
    const { view } = renderRunner(null);
    fireEvent.change(view.getByTestId('data-file-input'), {
      target: { files: [new File(['{"a":1}'], 'rows.json')] },
    });
    expect((await view.findByRole('alert')).textContent).toBe(
      'O JSON deve ser um array de objetos.',
    );
    expect((view.getByTestId('run-collection') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(view.getByTestId('data-file-input'), { target: { files: [{} as File] } });
    await waitFor(() =>
      expect(view.getByRole('alert').textContent).toBe('O arquivo não tem linhas.'),
    );
  });

  it('groups results by iteration, counts tests, filters and exports', () => {
    const create = vi.fn(() => 'blob:run');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const { view, onRun, onReset, onOpenRequest } = renderRunner(
      run({ finishedAt: '2026-10-24T10:00:01Z' }),
    );
    const results = view.getByTestId('run-results');
    expect(within(results).getByText('Iteração 1')).toBeTruthy();
    expect(within(results).getByText('Iteração 2')).toBeTruthy();
    expect(within(results).getByText('Passaram: 1')).toBeTruthy();
    expect(within(results).getByText('Falharam: 2')).toBeTruthy();
    expect(within(results).getByText('Ignoradas: 1')).toBeTruthy();
    expect(view.getByTestId('tests-count').textContent).toBe('Testes: 4/5');
    expect(within(results).getByText('1.20s')).toBeTruthy();

    fireEvent.click(within(results).getByRole('button', { name: 'Ignoradas' }));
    expect(within(results).getAllByText('Stream')).toHaveLength(1);
    expect(within(results).queryByText('Iteração 1')).toBeNull();
    fireEvent.click(within(results).getByRole('button', { name: 'Passaram' }));
    expect(within(results).getAllByText('Login')).toHaveLength(1);
    fireEvent.click(within(results).getByRole('button', { name: 'Falharam' }));
    expect(within(results).getAllByText(/Login|Stream/)).toHaveLength(2);
    fireEvent.click(within(results).getByRole('button', { name: 'Todos' }));

    fireEvent.click(within(results).getAllByText('Login')[0]!);
    expect(view.getByTestId('response-pane')).toBeTruthy();
    fireEvent.click(within(results).getAllByRole('button', { name: 'Abrir requisição' })[0]!);
    expect(onOpenRequest).toHaveBeenCalledWith('a');

    fireEvent.click(view.getByTestId('export-run'));
    expect(create).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    fireEvent.click(view.getByTestId('run-again'));
    expect(onRun).toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: /Resetar|Limpar|Reiniciar/ }));
    expect(onReset).toHaveBeenCalled();
  });

  it('dates a result of a run that has not finished', () => {
    const { view } = renderRunner(run({ createdAt: '' }));
    fireEvent.click(within(view.getByTestId('run-results')).getAllByText('Login')[0]!);
    expect(view.getByTestId('response-pane')).toBeTruthy();
  });

  it('shows a run in progress, its error and the local runner hint', () => {
    const active = run({
      status: 'running',
      error: 'worker lost',
      result: { durationMs: 0, total: 4, passed: 0, failed: 0, results: [result({})] },
    });
    const { view, onCancel } = renderRunner(active);
    expect(view.getByRole('alert').textContent).toBe('worker lost');
    expect(view.queryByText(/Iteração/)).toBeNull();
    fireEvent.click(view.getByRole('button', { name: /Cancelar/ }));
    expect(onCancel).toHaveBeenCalled();
    expect(view.queryByTestId('export-run')).toBeNull();

    const queued = renderRunner(run({ status: 'queued', target: 'local', result: null }), {
      readOnly: true,
    });
    expect(within(queued.view.container).getByText(/devkit runner/)).toBeTruthy();
    const waiting = renderRunner(run({ status: 'queued', result: null }));
    expect(within(waiting.view.container).getByText(/Aguardando/)).toBeTruthy();
  });

  it('lists no requests for an empty collection', () => {
    const { view } = renderRunner(null, {
      collection: { ...collection, items: [] },
      readOnly: true,
    });
    expect(view.queryByTestId('run-collection')).toBeNull();
  });
});

describe('RuntimeDialog', () => {
  const runtime: RuntimeState = {
    variables: [{ key: 'token', value: 'abc' }],
    cookies: [
      { name: 'sid', value: '1', domain: 'api.test', path: '/', expires: Date.parse('2030-01-01') },
      { name: 'theme', value: 'dark', domain: 'api.test', path: '/' },
    ],
  };

  it('edits, saves and clears the runtime variables', async () => {
    const onSave = vi.fn(() => Promise.resolve());
    const onClear = vi.fn(() => Promise.resolve());
    const onClose = vi.fn();
    const view = render(
      <RuntimeDialog
        open
        collectionName="Orders API"
        runtime={runtime}
        error={null}
        onSave={onSave}
        onClear={onClear}
        onClose={onClose}
      />,
    );
    const dialog = view.getByTestId('runtime-dialog');
    expect(within(dialog).getByText(/Runtime · Orders API/)).toBeTruthy();
    expect(within(dialog).getByTestId<HTMLButtonElement>('runtime-save').disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('token'), { target: { value: 'xyz' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Adicionar variável/ }));
    fireEvent.change(within(dialog).getAllByLabelText('Chave')[1]!, { target: { value: 'id' } });
    fireEvent.click(within(dialog).getByTestId('runtime-save'));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        variables: [
          { key: 'token', value: 'xyz' },
          { key: 'id', value: '' },
        ],
        cookies: runtime.cookies,
      }),
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Excluir token' }));
    expect(within(dialog).queryByLabelText('token')).toBeNull();
    fireEvent.click(within(dialog).getByTestId('runtime-clear'));
    await waitFor(() => expect(onClear).toHaveBeenCalled());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fechar' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('lists and deletes cookies', async () => {
    const onSave = vi.fn(() => Promise.resolve());
    const view = render(
      <RuntimeDialog
        open
        collectionName="Orders API"
        runtime={runtime}
        error={null}
        onSave={onSave}
        onClear={vi.fn(() => Promise.resolve())}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(view.getByRole('tab', { name: /Cookies/ }));
    const cookies = view.getByTestId('runtime-cookies');
    expect(within(cookies).getByText('Sessão')).toBeTruthy();
    fireEvent.click(within(cookies).getByRole('button', { name: 'Excluir sid' }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({
        variables: runtime.variables,
        cookies: [runtime.cookies[1]],
      }),
    );
    fireEvent.click(view.getByTestId('cookies-clear'));
    await waitFor(() =>
      expect(onSave).toHaveBeenLastCalledWith({ variables: runtime.variables, cookies: [] }),
    );
  });

  it('shows loading, errors and empty lists', () => {
    const view = render(
      <RuntimeDialog
        open
        collectionName="Orders API"
        runtime={null}
        error={null}
        onSave={vi.fn(() => Promise.resolve())}
        onClear={vi.fn(() => Promise.resolve())}
        onClose={vi.fn()}
      />,
    );
    expect(view.getByRole('status').textContent).toBe('Carregando...');
    view.rerender(
      <RuntimeDialog
        open
        collectionName="Orders API"
        runtime={{ variables: [], cookies: [] }}
        error="offline"
        onSave={vi.fn(() => Promise.resolve())}
        onClear={vi.fn(() => Promise.resolve())}
        onClose={vi.fn()}
      />,
    );
    expect(view.getByRole('alert').textContent).toBe('offline');
    expect(view.getByText(/Nenhuma variável de runtime/)).toBeTruthy();
    expect((view.getByTestId('runtime-clear') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(view.getByRole('tab', { name: /Cookies/ }));
    expect(view.getByText('Nenhum cookie.')).toBeTruthy();
  });
});
