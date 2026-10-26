import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RequestResult } from '../src/features/apitests/api-test-types.js';
import { ResponsePane } from '../src/features/apitests/integration/ResponsePane.js';
import type { ResponseEntry } from '../src/features/apitests/integration/integration-model.js';

function result(patch: Partial<RequestResult> = {}): RequestResult {
  return {
    requestId: 'r1',
    name: 'Get user',
    path: [],
    method: 'GET',
    url: 'https://api.test/users/1',
    status: 200,
    durationMs: 120,
    sizeBytes: 20,
    passed: true,
    assertions: [],
    response: { headers: { 'content-type': 'application/json' }, bodyPreview: '{"id":1}' },
    ...patch,
  };
}

const entry = (patch: Partial<ResponseEntry> = {}): ResponseEntry => ({
  runId: 'run-1',
  at: Date.UTC(2026, 0, 1, 12),
  result: result(),
  error: null,
  ...patch,
});

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: 'Ações da resposta' }));
const tab = (name: RegExp) => fireEvent.click(screen.getByRole('tab', { name }));

afterEach(() => vi.restoreAllMocks());

describe('ResponsePane', () => {
  it('says it is waiting for the local runner, and lets the send be cancelled', () => {
    const onCancel = vi.fn();
    render(
      <ResponsePane
        entries={[]}
        target="local"
        pending={{ runId: 'run-1', startedAt: Date.now(), status: 'queued' }}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText(/devkit runner/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar requisição' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('copies and downloads the body, clears it and changes the layout', () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const createObjectURL = vi.fn(() => 'blob:x');
    Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const onClear = vi.fn();
    const onToggleLayout = vi.fn();
    render(
      <ResponsePane
        entries={[entry()]}
        target="remote"
        layout="vertical"
        onClear={onClear}
        onToggleLayout={onToggleLayout}
      />,
    );
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Copiar resposta/ }));
    expect(writeText).toHaveBeenCalledWith('{"id":1}');
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Baixar resposta/ }));
    expect(click).toHaveBeenCalled();
    const anchor = click.mock.contexts[0] as HTMLAnchorElement;
    expect(anchor.download).toBe('response.json');
    openMenu();
    fireEvent.click(screen.getByRole('menuitem', { name: /Limpar resposta/ }));
    expect(onClear).toHaveBeenCalled();
    openMenu();
    const layout = screen.getByRole('menuitem', { name: /Alterar layout/ });
    expect(layout.querySelector('.ti-layout-columns')).toBeTruthy();
    fireEvent.click(layout);
    expect(onToggleLayout).toHaveBeenCalled();
  });

  it('downloads a text body as .txt and shows the raw text', () => {
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:x', configurable: true });
    Object.defineProperty(URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    render(
      <ResponsePane
        entries={[entry({ result: result({ response: { headers: {}, bodyPreview: 'plain' } }) })]}
        target="remote"
        layout="horizontal"
        onToggleLayout={() => undefined}
      />,
    );
    openMenu();
    expect(
      screen.getByRole('menuitem', { name: /Alterar layout/ }).querySelector('.ti-layout-rows'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('menuitem', { name: /Baixar resposta/ }));
    expect((click.mock.contexts[0] as HTMLAnchorElement).download).toBe('response.txt');

    fireEvent.click(screen.getByRole('button', { name: 'Código' }));
    expect(within(screen.getByTestId('response-body')).getByText('plain')).toBeTruthy();
  });

  it('shows the error of a send, the empty body in raw view, and no headers', () => {
    render(
      <ResponsePane
        entries={[
          entry({
            error: 'Network down',
            result: result({ status: 502, response: { headers: {}, bodyPreview: '' } }),
          }),
        ]}
        target="remote"
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe('Network down');
    expect(screen.getByTestId('response-status').className).toContain('danger');
    fireEvent.click(screen.getByRole('button', { name: 'Código' }));
    expect(screen.getByText('(body vazio)')).toBeTruthy();
    tab(/Headers/);
    expect(screen.getByText('Sem headers.')).toBeTruthy();
  });

  it('lists the headers, the timeline and the tests', () => {
    render(
      <ResponsePane
        entries={[
          entry({
            result: result({
              assertions: [
                { id: 'a1', label: 'status eq 200', passed: true },
                { id: 'a2', label: 'json id eq 2', passed: false, actual: '1' },
                { id: 'a3', label: 'header exists', passed: false },
              ],
            }),
          }),
          entry({ runId: 'run-0', result: result({ status: 404 }) }),
          entry({ runId: 'run-x', result: result({ status: null }) }),
          entry({ runId: 'run-e', result: null, error: 'Timed out' }),
        ]}
        target="remote"
      />,
    );
    tab(/Headers/);
    expect(screen.getByText('content-type')).toBeTruthy();
    expect(screen.getByText('application/json')).toBeTruthy();

    tab(/Linha do tempo/);
    const timeline = screen.getByTestId('response-timeline');
    const rows = within(timeline).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(rows[1]!.textContent).toContain('404');
    expect(rows[2]!.textContent).toContain('—');
    expect(rows[3]!.textContent).toContain('Timed out');

    tab(/Testes/);
    const tests = screen.getByTestId('response-tests');
    expect(within(tests).getByText('status eq 200')).toBeTruthy();
    expect(tests.textContent).toContain('obtido: 1');
    expect(within(tests).getAllByRole('listitem')).toHaveLength(3);
  });

  it('says there are no tests when the request has no assertions', () => {
    render(<ResponsePane entries={[entry({ result: null, error: 'Boom' })]} target="remote" />);
    expect(screen.getByRole('alert').textContent).toBe('Boom');
    tab(/Testes/);
    expect(screen.getByText('Sem asserções.')).toBeTruthy();
  });

  it('shows when there was no response, with the error the run recorded', () => {
    render(
      <ResponsePane
        entries={[entry({ result: result({ status: null, error: 'ECONNREFUSED' }) })]}
        target="remote"
      />,
    );
    expect(screen.getByTestId('response-status').textContent).toBe('Sem resposta');
    expect(screen.getByRole('alert').textContent).toBe('ECONNREFUSED');
  });
});
