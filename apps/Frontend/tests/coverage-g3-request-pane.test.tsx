import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  newRequest,
  type ApiCollection,
  type ApiRequestSpec,
  type RequestKind,
} from '../src/features/apitests/api-test-types.js';
import { RequestPane } from '../src/features/apitests/integration/RequestPane.js';

const collection = (patch: Partial<ApiCollection> = {}): ApiCollection => ({
  id: 'c1',
  workspaceId: 'w1',
  name: 'Orders API',
  variables: [],
  auth: { type: 'none' },
  items: [],
  source: { kind: 'adk' },
  updatedAt: '',
  ...patch,
});

const request = (kind: RequestKind, patch: Partial<ApiRequestSpec> = {}): ApiRequestSpec => ({
  ...newRequest('r', kind, '{{baseUrl}}'),
  id: 'r1',
  ...patch,
});

function Harness({
  initial,
  onChange,
  withCollection,
  mocksFailed = false,
}: {
  initial: ApiRequestSpec;
  onChange?: (request: ApiRequestSpec) => void;
  withCollection?: ApiCollection;
  mocksFailed?: boolean;
}) {
  const [current, setCurrent] = useState(initial);
  return (
    <RequestPane
      request={current}
      collection={withCollection}
      readOnly={false}
      mocksFailed={mocksFailed}
      onChange={(next) => {
        setCurrent(next);
        onChange?.(next);
      }}
    />
  );
}

const openTab = (name: RegExp | string) =>
  fireEvent.click(
    within(screen.getByRole('tablist', { name: 'Requisição' })).getByRole('tab', { name }),
  );
const last = (spy: ReturnType<typeof vi.fn>): ApiRequestSpec =>
  spy.mock.calls[spy.mock.calls.length - 1]![0] as ApiRequestSpec;

describe('RequestPane assertions and captures', () => {
  it('edits one assertion among several, including its expected value', () => {
    const onChange = vi.fn();
    render(<Harness initial={request('graphql')} onChange={onChange} />);
    openTab(/Asserções/);
    // The GraphQL request starts with a status and an `errors` check; the second has no value.
    const expected = screen.getAllByLabelText<HTMLInputElement>('Esperado');
    expect(expected).toHaveLength(2);
    expect(expected[1]!.value).toBe('');
    fireEvent.change(expected[0]!, { target: { value: '201' } });
    expect(last(onChange).assertions[0]!.expected).toBe('201');
    expect(last(onChange).assertions[1]!.operator).toBe('notExists');
  });

  it('edits one capture among several, one of them without a path', () => {
    const onChange = vi.fn();
    render(
      <Harness
        initial={request('http', {
          captures: [
            { variable: 'code', source: 'status' },
            { variable: 'token', source: 'json', path: 'data.token' },
          ],
        })}
        onChange={onChange}
      />,
    );
    openTab(/Capturas/);
    const paths = screen.getAllByLabelText<HTMLInputElement>('Caminho');
    expect(paths[0]!.value).toBe('');
    fireEvent.change(screen.getAllByLabelText('Variável')[0]!, { target: { value: 'status' } });
    expect(last(onChange).captures[0]!.variable).toBe('status');
    expect(last(onChange).captures[1]).toEqual({
      variable: 'token',
      source: 'json',
      path: 'data.token',
    });
  });
});

describe('RequestPane tabs', () => {
  it('edits the headers and the auth of the request', () => {
    const onChange = vi.fn();
    render(<Harness initial={request('http')} onChange={onChange} withCollection={collection()} />);
    openTab(/Headers/);
    fireEvent.click(screen.getByRole('button', { name: /Adicionar/ }));
    expect(last(onChange).headers).toEqual([{ key: '', value: '' }]);
    openTab(/Auth/);
    fireEvent.change(screen.getByLabelText('Autenticação'), { target: { value: 'none' } });
    expect(last(onChange).auth).toEqual({ type: 'none' });
  });

  it('falls back to the first tab of the kind when the request changes kind', () => {
    const view = render(<RequestPane request={request('http')} readOnly onChange={vi.fn()} />);
    openTab(/Params|Query/);
    view.rerender(<RequestPane request={request('websocket')} readOnly onChange={vi.fn()} />);
    expect(screen.getByRole('tab', { selected: true }).textContent).toContain('Mensagens');
  });

  it('keeps working when the mocks fail and no retry handler was given', () => {
    render(
      <Harness
        initial={request('http', { method: 'POST', body: { mode: 'json', content: '{}' } })}
        mocksFailed
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Mocks' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(screen.getByText('Não foi possível carregar os mocks agora.')).toBeTruthy();
  });

  it('shows the defaults of the collection as the placeholders of the request settings', () => {
    render(
      <Harness
        initial={request('http')}
        withCollection={collection({ settings: { timeoutMs: 5000, maxRedirects: 3 } })}
      />,
    );
    openTab(/Configurações|Settings/);
    expect(screen.getByLabelText<HTMLInputElement>('Timeout (ms)').placeholder).toBe('5000');
    expect(screen.getByLabelText<HTMLInputElement>('Máximo de redirecionamentos').placeholder).toBe(
      '3',
    );
  });
});
