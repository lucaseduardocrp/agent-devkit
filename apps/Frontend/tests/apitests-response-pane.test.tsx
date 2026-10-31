import { fireEvent, render, waitFor, within, type RenderResult } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RequestResult, StreamMessage } from '../src/features/apitests/api-test-types.js';
import type { ResponseEntry } from '../src/features/apitests/integration/integration-model.js';
import { ResponsePane } from '../src/features/apitests/integration/ResponsePane.js';

const result = (patch: Partial<RequestResult> = {}): RequestResult => ({
  requestId: 'r1',
  name: 'Login',
  path: [],
  method: 'POST',
  url: 'https://api.test/login',
  status: 200,
  durationMs: 120,
  sizeBytes: 64,
  passed: true,
  assertions: [],
  ...patch,
});

const entry = (patch: Partial<ResponseEntry> = {}): ResponseEntry => ({
  runId: 'run-1',
  at: Date.parse('2026-10-24T10:00:00Z'),
  result: result(),
  error: null,
  ...patch,
});

const pane = (entries: readonly ResponseEntry[], props: Record<string, unknown> = {}) =>
  render(<ResponsePane entries={entries} target="remote" {...props} />);

const openTab = (view: RenderResult, name: RegExp | string) =>
  fireEvent.click(
    within(view.getByRole('tablist', { name: 'Resposta' })).getByRole('tab', { name }),
  );

const tabNames = (view: RenderResult) =>
  within(view.getByRole('tablist', { name: 'Resposta' }))
    .getAllByRole('tab')
    .map((tab) => tab.textContent.replace(/[0-9/•]+$/, ''));

describe('ResponsePane', () => {
  it('waits for the response, then shows the shortcuts again when it is cleared', () => {
    const onCancel = vi.fn();
    const pending = pane([], {
      pending: { runId: 'run-1', startedAt: Date.now(), status: 'running' },
      onCancel,
    });
    expect(pending.getByText('Enviando…')).toBeInTheDocument();
    fireEvent.click(pending.getByRole('button', { name: 'Cancelar requisição' }));
    expect(onCancel).toHaveBeenCalled();
    pending.unmount();

    const local = pane([], {
      pending: { runId: 'run-1', startedAt: Date.now(), status: 'queued' },
      target: 'local',
    });
    expect(local.getByText(/devkit runner/)).toBeInTheDocument();
    local.unmount();

    expect(pane([]).getByTestId('response-placeholder')).toBeInTheDocument();
  });

  it('shows the body, its headers, and copies and downloads it', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    const createObjectURL = vi.fn(() => 'blob:x');
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const onClear = vi.fn();
    const onToggleLayout = vi.fn();
    const view = pane(
      [
        entry({
          result: result({
            response: {
              headers: { 'content-type': 'application/json' },
              bodyPreview: '{"token":"abc"}',
              statusText: 'OK',
            },
          }),
        }),
      ],
      { onClear, onToggleLayout, layout: 'vertical' },
    );
    expect(tabNames(view)).toEqual([
      'Resposta',
      'Headers',
      'Linha do tempo',
      'Testes',
      'Console',
      'Histórico',
    ]);
    expect(view.getByTestId('response-status').textContent).toBe('200 OK');
    expect(view.getByTestId('response-body').textContent).toContain('"token"');
    // Raw and pretty views of the same body.
    fireEvent.click(view.getByRole('button', { name: 'Código' }));
    expect(view.getByTestId('response-body').textContent).toContain('{"token":"abc"}');

    openTab(view, /Headers/);
    expect(view.getByText('content-type')).toBeInTheDocument();

    fireEvent.click(view.getByRole('button', { name: 'Ações da resposta' }));
    fireEvent.click(view.getByRole('menuitem', { name: 'Copiar resposta' }));
    expect(writeText).toHaveBeenCalledWith('{"token":"abc"}');
    fireEvent.click(view.getByRole('button', { name: 'Ações da resposta' }));
    fireEvent.click(view.getByRole('menuitem', { name: 'Baixar resposta' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    fireEvent.click(view.getByRole('button', { name: 'Ações da resposta' }));
    fireEvent.click(view.getByRole('menuitem', { name: 'Limpar resposta' }));
    expect(onClear).toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Ações da resposta' }));
    fireEvent.click(view.getByRole('menuitem', { name: 'Alterar layout' }));
    expect(onToggleLayout).toHaveBeenCalled();
  });

  it('previews an HTML page in a sandboxed frame and warns when the body was cut', () => {
    const view = pane([
      entry({
        result: result({
          sizeBytes: 2048,
          response: {
            headers: { 'Content-Type': 'text/html' },
            bodyPreview: '<html><body>Hi</body></html>',
            truncated: true,
          },
        }),
      }),
    ]);
    expect(view.getByRole('status').textContent).toContain('Só os primeiros');
    fireEvent.click(view.getByTestId('html-preview'));
    const frame = view.getByTitle('Prévia da página') as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('Hi');
    fireEvent.click(view.getByTestId('html-preview'));
    expect(view.queryByTitle('Prévia da página')).toBeNull();
  });

  it('shows an error, and a request a script skipped', () => {
    const failed = pane([entry({ result: null, error: 'connect ECONNREFUSED' })]);
    expect(failed.getByRole('alert').textContent).toContain('ECONNREFUSED');
    expect(failed.queryByTestId('response-pane-status')).toBeNull();
    failed.unmount();

    const errored = pane([entry({ result: result({ status: null, error: 'timeout' }) })]);
    expect(errored.getByTestId('response-status').textContent).toBe('Sem resposta');
    expect(errored.getByRole('alert').textContent).toContain('timeout');
    errored.unmount();

    const skipped = pane([
      entry({ result: result({ skipped: true, response: { headers: {}, bodyPreview: '' } }) }),
    ]);
    expect(skipped.getByTestId('response-status').textContent).toBe('Pulada');
    expect(skipped.getByTestId('response-skipped')).toBeInTheDocument();
  });

  it('shows the timeline: the request as sent, the timings and the redirects', () => {
    const view = pane([
      entry({
        result: result({
          response: { headers: {}, bodyPreview: 'ok' },
          timeline: {
            request: {
              method: 'POST',
              url: 'https://api.test/login',
              headers: { 'content-type': 'application/json' },
              bodyPreview: '{"user":"ana"}',
            },
            httpVersion: 'HTTP/1.1',
            remoteAddress: '203.0.113.7:443',
            redirects: [{ status: 302, url: 'https://api.test/login/' }],
            timings: { dns: 4, connect: 8, tls: 12, firstByte: 80, download: 16, total: 120 },
          },
        }),
      }),
    ]);
    openTab(view, /Linha do tempo/);
    const timeline = view.getByTestId('response-timeline');
    expect(timeline.textContent).toContain('HTTP/1.1');
    expect(timeline.textContent).toContain('203.0.113.7:443');
    expect(timeline.textContent).toContain('{"user":"ana"}');
    expect(within(timeline).getByText('content-type')).toBeInTheDocument();
    expect(within(timeline).getByTestId('timeline-timings').textContent).toContain('Consulta DNS');
    expect(within(timeline).getByTestId('timeline-redirects').textContent).toContain('302');
  });

  it('says when there is no timeline', () => {
    const view = pane([entry({ result: result({ response: { headers: {}, bodyPreview: '' } }) })]);
    openTab(view, /Linha do tempo/);
    expect(view.getByTestId('response-timeline').textContent).toBe(
      'Sem linha do tempo para esta resposta.',
    );
    const headers = view.getByRole('tablist', { name: 'Resposta' });
    fireEvent.click(within(headers).getByRole('tab', { name: /Headers/ }));
    expect(view.getByText('Sem headers.')).toBeInTheDocument();
  });

  it('counts the assertions and the script tests in the tab, and lists both', () => {
    const view = pane([
      entry({
        result: result({
          passed: false,
          assertions: [
            { id: 'a1', label: 'status eq 200', passed: true },
            { id: 'a2', label: 'json token exists', passed: false, actual: 'undefined' },
          ],
          tests: [{ id: 't1', label: 'keeps the session', passed: true }],
        }),
      }),
    ]);
    expect(
      within(view.getByRole('tablist', { name: 'Resposta' })).getByRole('tab', { name: /Testes/ })
        .textContent,
    ).toContain('2/3');
    openTab(view, /Testes/);
    const tests = view.getByTestId('response-tests');
    expect(within(tests).getByText('status eq 200')).toBeInTheDocument();
    expect(within(tests).getByText('keeps the session')).toBeInTheDocument();
    expect(within(tests).getByText(/obtido: undefined/)).toBeInTheDocument();
    expect(within(tests).getAllByRole('img', { name: 'Passou' })).toHaveLength(2);
    expect(within(tests).getByRole('img', { name: 'Falhou' })).toBeInTheDocument();
  });

  it('says when nothing was checked and when the scripts wrote nothing', () => {
    const view = pane([entry()]);
    openTab(view, /Testes/);
    expect(view.getByTestId('response-tests').textContent).toContain('Sem asserções');
    openTab(view, /Console/);
    expect(view.getByTestId('response-console').textContent).toBe(
      'Os scripts não escreveram nada.',
    );
  });

  it('shows the script console with a color per level', () => {
    const view = pane([
      entry({
        result: result({
          logs: [
            { level: 'log', message: 'hello', source: 'request pre-request' },
            { level: 'info', message: 'info', source: 'request tests' },
            { level: 'warn', message: 'careful', source: 'request tests' },
            { level: 'error', message: 'boom', source: 'request tests' },
            { level: 'debug', message: 'detail', source: 'request tests' },
          ],
        }),
      }),
    ]);
    const tab = within(view.getByRole('tablist', { name: 'Resposta' })).getByRole('tab', {
      name: /Console/,
    });
    expect(tab.textContent).toContain('5');
    openTab(view, /Console/);
    const console = view.getByTestId('response-console');
    expect(within(console).getByText('boom')).toBeInTheDocument();
    expect(within(console).getAllByText('request tests')).toHaveLength(4);
  });

  it('lists the messages of a stream, filters them and expands the JSON ones', () => {
    const messages: StreamMessage[] = [
      { direction: 'info', at: 1000, data: 'connected' },
      { direction: 'sent', at: 1100, data: '{"type":"ping","id":1}', type: 'json' },
      { direction: 'received', at: 1250, data: 'pong', type: 'text', event: 'message' },
    ];
    const view = pane([
      entry({
        result: result({
          kind: 'websocket',
          status: 101,
          response: { headers: {}, bodyPreview: '', messages },
        }),
      }),
    ]);
    expect(view.getByTestId('response-status').textContent).toBe('101 Switching Protocols');
    expect(tabNames(view)).toContain('Mensagens');
    openTab(view, /Mensagens/);
    const panel = view.getByTestId('response-messages');
    expect(within(panel).getAllByTestId('stream-message')).toHaveLength(3);
    expect(panel.textContent).toContain('+250ms');
    expect(panel.textContent).toContain('message');

    // The JSON message expands into a pretty view.
    fireEvent.click(within(panel).getByRole('button', { name: 'Expandir' }));
    expect(panel.textContent).toContain('"type": "ping"');
    fireEvent.click(within(panel).getByRole('button', { name: 'Recolher' }));
    expect(panel.textContent).not.toContain('"type": "ping"');

    fireEvent.change(within(panel).getByLabelText('Direção'), { target: { value: 'received' } });
    expect(within(panel).getAllByTestId('stream-message')).toHaveLength(1);
    fireEvent.change(within(panel).getByLabelText('Direção'), { target: { value: 'all' } });
    fireEvent.change(within(panel).getByLabelText('Filtrar mensagens'), {
      target: { value: 'ping' },
    });
    expect(within(panel).getAllByTestId('stream-message')).toHaveLength(1);
    fireEvent.change(within(panel).getByLabelText('Filtrar mensagens'), {
      target: { value: 'nothing' },
    });
    expect(within(panel).getByText('Nenhuma mensagem.')).toBeInTheDocument();
  });

  it('names a gRPC status and its trailers', () => {
    const view = pane([
      entry({
        result: result({
          kind: 'grpc',
          status: 7,
          passed: false,
          response: {
            headers: {},
            bodyPreview: '',
            trailers: { 'grpc-status': '7', 'grpc-message': 'no%20access' },
            messages: [],
          },
        }),
      }),
    ]);
    expect(view.getByTestId('response-status').textContent).toBe('7 PERMISSION_DENIED');
    openTab(view, /Trailers/);
    const trailers = view.getByTestId('response-trailers');
    expect(trailers.textContent).toContain('7 PERMISSION_DENIED');
    expect(trailers.textContent).toContain('no access');
  });

  it('shows an empty trailers tab for a gRPC call that sent none', () => {
    const view = pane([
      entry({
        result: result({ kind: 'grpc', status: 0, response: { headers: {}, bodyPreview: '{}' } }),
      }),
    ]);
    expect(view.getByTestId('response-status').textContent).toBe('0 OK');
    openTab(view, /Trailers/);
    expect(view.getByText('Sem trailers.')).toBeInTheDocument();
  });

  it('says a socket connected, and lists the sends in the history', () => {
    const view = pane([
      entry({
        runId: 'run-2',
        result: result({ kind: 'socket', status: 0, response: { headers: {}, bodyPreview: 'hi' } }),
      }),
      entry({ result: result({ status: 500 }) }),
      entry({ runId: 'run-0', result: null, error: 'refused' }),
    ]);
    expect(view.getByTestId('response-status').textContent).toBe('Conectado');
    openTab(view, /Histórico/);
    const history = view.getByTestId('response-history');
    expect(history.children).toHaveLength(3);
    expect(history.textContent).toContain('refused');
    expect(history.textContent).toContain('500');
  });
});

describe('ResponsePane corners', () => {
  it('names a status the engine did not phrase, and shows an empty body', () => {
    const view = pane([
      entry({ result: result({ status: 299, response: { headers: {}, bodyPreview: '' } }) }),
    ]);
    expect(view.getByTestId('response-status').textContent).toBe('299');
    fireEvent.click(view.getByRole('button', { name: 'Código' }));
    expect(view.getByTestId('response-body').textContent).toContain('(body vazio)');
  });

  it('downloads a body that is not JSON', async () => {
    const createObjectURL = vi.fn(() => 'blob:x');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const view = pane([
      entry({ result: result({ response: { headers: {}, bodyPreview: 'plain text' } }) }),
    ]);
    fireEvent.click(view.getByRole('button', { name: 'Ações da resposta' }));
    fireEvent.click(view.getByRole('menuitem', { name: 'Baixar resposta' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
  });

  it('keeps the chosen tab only while the response has it', () => {
    const messages: StreamMessage[] = [{ direction: 'received', at: 1, data: 'x' }];
    const view = pane([
      entry({
        result: result({ kind: 'sse', response: { headers: {}, bodyPreview: '', messages } }),
      }),
    ]);
    openTab(view, /Mensagens/);
    expect(view.getByTestId('response-messages')).toBeInTheDocument();
    // A plain response has no Messages tab, so the pane falls back to the body.
    view.rerender(
      <ResponsePane
        entries={[entry({ result: result({ response: { headers: {}, bodyPreview: 'ok' } }) })]}
        target="remote"
      />,
    );
    expect(view.getByTestId('response-body')).toBeInTheDocument();
  });

  it('leaves out the timings a run did not measure, and the messages of an empty stream', () => {
    const view = pane([
      entry({
        result: result({
          kind: 'websocket',
          response: { headers: {}, bodyPreview: '', messages: [] },
          timeline: {
            request: { method: 'GET', url: 'wss://x', headers: {} },
            timings: { total: 50 },
          },
        }),
      }),
    ]);
    openTab(view, /Mensagens/);
    expect(view.getByText('Nenhuma mensagem.')).toBeInTheDocument();
    openTab(view, /Linha do tempo/);
    const timings = view.getByTestId('timeline-timings');
    expect(timings.textContent).toContain('Total');
    expect(timings.textContent).not.toContain('Consulta DNS');
    expect(view.queryByTestId('timeline-redirects')).toBeNull();
    expect(view.getByTestId('response-timeline').textContent).not.toContain('Versão HTTP');
  });

  it('keeps a trailer message that is not percent-encoded', () => {
    const view = pane([
      entry({
        result: result({
          kind: 'grpc',
          status: 13,
          response: {
            headers: {},
            bodyPreview: '',
            trailers: { 'grpc-status': '13', 'grpc-message': '100% broken' },
          },
        }),
      }),
    ]);
    openTab(view, /Trailers/);
    expect(view.getByTestId('response-trailers').textContent).toContain('100% broken');
  });

  it('shows the timeline of a response that has none when nothing was sent', () => {
    const view = pane([entry({ result: null, error: 'refused' })]);
    openTab(view, /Linha do tempo/);
    expect(view.getByText('Sem linha do tempo para esta resposta.')).toBeInTheDocument();
    openTab(view, /Testes/);
    expect(view.getByTestId('response-tests').textContent).toContain('Sem asserções');
  });
});
