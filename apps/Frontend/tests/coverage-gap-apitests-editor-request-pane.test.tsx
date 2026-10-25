import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ApiCollection,
  ApiRequestSpec,
  RequestAuth,
} from '../src/features/apitests/api-test-types.js';
import {
  AuthEditor,
  RequestPane,
  UrlBar,
} from '../src/features/apitests/integration/RequestPane.js';

function request(patch: Partial<ApiRequestSpec> = {}): ApiRequestSpec {
  return {
    id: 'r1',
    type: 'request',
    name: 'Get user',
    method: 'GET',
    url: '{{baseUrl}}/users',
    headers: [],
    query: [],
    body: { mode: 'none' },
    auth: { type: 'inherit' },
    assertions: [],
    captures: [],
    ...patch,
  };
}

const collection: ApiCollection = {
  id: 'c1',
  workspaceId: 'w1',
  name: 'Users',
  variables: [],
  auth: { type: 'none' },
  source: { kind: 'manual' },
  updatedAt: '',
  items: [],
} as unknown as ApiCollection;

/** Keeps the request in state, as the view does, and reports each change. */
function Pane({
  initial,
  readOnly = false,
  spy,
}: {
  initial: ApiRequestSpec;
  readOnly?: boolean;
  spy?: (request: ApiRequestSpec) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <RequestPane
      request={value}
      readOnly={readOnly}
      onChange={(next) => {
        spy?.(next);
        setValue(next);
      }}
    />
  );
}

const tab = (name: RegExp) => fireEvent.click(screen.getByRole('tab', { name }));
const last = (spy: ReturnType<typeof vi.fn>) =>
  spy.mock.calls[spy.mock.calls.length - 1]![0] as ApiRequestSpec;

afterEach(() => vi.useRealTimers());

describe('UrlBar code dialog', () => {
  it('copies the cURL, says so, and closes from the header button', async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(
      <UrlBar
        request={request()}
        collection={collection}
        readOnly={false}
        dirty={false}
        sending={false}
        onChange={() => undefined}
        onSend={() => undefined}
        onCancel={() => undefined}
        onSave={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId('generate-code'));
    const dialog = screen.getByTestId('code-dialog');
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: /Copiar/ }));
      await Promise.resolve();
    });
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('curl'));
    expect(within(dialog).getByRole('button', { name: /Copiado/ })).toBeTruthy();
    act(() => void vi.advanceTimersByTime(1500));
    expect(within(dialog).getByRole('button', { name: /Copiar/ })).toBeTruthy();
    // The icon button in the header closes it too.
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Fechar' })[0]!);
    expect(screen.queryByTestId('code-dialog')).toBeNull();
  });

  it('keeps the typed URL until the field is left', () => {
    const onChange = vi.fn();
    render(
      <UrlBar
        request={request()}
        collection={collection}
        readOnly
        dirty={false}
        sending={false}
        onChange={onChange}
        onSend={() => undefined}
        onCancel={() => undefined}
        onSave={() => undefined}
      />,
    );
    const url = screen.getByLabelText<HTMLInputElement>('URL');
    fireEvent.blur(url);
    expect(url.value).toBe('{{baseUrl}}/users');
    expect(screen.queryByTestId('run-request')).toBeNull();
  });
});

describe('AuthEditor', () => {
  function Auth({ initial, spy }: { initial: RequestAuth; spy: (auth: RequestAuth) => void }) {
    const [auth, setAuth] = useState(initial);
    return (
      <AuthEditor
        auth={auth}
        allowInherit
        readOnly={false}
        onChange={(next) => {
          spy(next);
          setAuth(next);
        }}
      />
    );
  }

  it('switches between the kinds and edits each field', () => {
    const spy = vi.fn();
    render(<Auth initial={{ type: 'inherit' }} spy={spy} />);
    expect(screen.getByText('Usa a autenticação da pasta ou da coleção.')).toBeTruthy();
    const type = screen.getByLabelText('Autenticação');

    fireEvent.change(type, { target: { value: 'bearer' } });
    expect(spy).toHaveBeenLastCalledWith({ type: 'bearer', token: '{{token}}' });
    fireEvent.change(screen.getByLabelText('Token'), { target: { value: 'abc' } });
    expect(spy).toHaveBeenLastCalledWith({ type: 'bearer', token: 'abc' });

    fireEvent.change(type, { target: { value: 'basic' } });
    fireEvent.change(screen.getByLabelText('Usuário'), { target: { value: 'ana' } });
    fireEvent.change(screen.getByLabelText('Senha'), { target: { value: 'pw' } });
    expect(spy).toHaveBeenLastCalledWith({ type: 'basic', username: 'ana', password: 'pw' });

    fireEvent.change(type, { target: { value: 'apikey' } });
    fireEvent.change(screen.getByLabelText('Chave'), { target: { value: 'X-Key' } });
    fireEvent.change(screen.getByLabelText('Valor'), { target: { value: 'v' } });
    fireEvent.change(screen.getByLabelText('Adicionar em'), { target: { value: 'query' } });
    expect(spy).toHaveBeenLastCalledWith({ type: 'apikey', key: 'X-Key', value: 'v', in: 'query' });

    fireEvent.change(type, { target: { value: 'none' } });
    expect(spy).toHaveBeenLastCalledWith({ type: 'none' });
  });
});

describe('RequestPane', () => {
  it('opens on the body when there is one, and switches the body modes keeping the content', () => {
    const spy = vi.fn();
    render(<Pane initial={request({ body: { mode: 'json', content: '{}' } })} spy={spy} />);
    expect(screen.getByLabelText<HTMLTextAreaElement>('Body').value).toBe('{}');
    const mode = screen.getByLabelText('Tipo do body');

    fireEvent.change(mode, { target: { value: 'xml' } });
    expect(last(spy).body).toEqual({ mode: 'xml', content: '{}' });
    fireEvent.change(screen.getByLabelText('Body'), { target: { value: '<a/>' } });
    expect(last(spy).body).toEqual({ mode: 'xml', content: '<a/>' });

    fireEvent.change(mode, { target: { value: 'form' } });
    expect(last(spy).body).toEqual({ mode: 'form', fields: [] });
    fireEvent.click(screen.getByRole('button', { name: /Adicionar/ }));
    expect(last(spy).body).toEqual({ mode: 'form', fields: [{ key: '', value: '' }] });

    fireEvent.change(mode, { target: { value: 'urlencoded' } });
    expect(last(spy).body).toEqual({ mode: 'urlencoded', fields: [{ key: '', value: '' }] });
    fireEvent.change(mode, { target: { value: 'text' } });
    expect(last(spy).body).toEqual({ mode: 'text', content: '' });

    fireEvent.change(mode, { target: { value: 'none' } });
    expect(last(spy).body).toEqual({ mode: 'none' });
    expect(screen.getByText('Esta requisição não tem corpo.')).toBeTruthy();
  });

  it('edits the query, the path params, the headers and the auth', () => {
    const spy = vi.fn();
    render(<Pane initial={request({ url: '{{baseUrl}}/users/:id' })} spy={spy} />);
    const params = screen.getByTestId('path-params');
    fireEvent.change(within(params).getByLabelText('id'), { target: { value: '7' } });
    expect(last(spy).pathParams).toEqual([expect.objectContaining({ key: 'id', value: '7' })]);
    fireEvent.click(screen.getAllByRole('button', { name: /Adicionar/ })[0]!);
    expect(last(spy).query).toEqual([{ key: '', value: '' }]);

    tab(/Headers/);
    fireEvent.click(screen.getByRole('button', { name: /Adicionar/ }));
    expect(last(spy).headers).toEqual([{ key: '', value: '' }]);

    tab(/Auth/);
    fireEvent.change(screen.getByLabelText('Autenticação'), { target: { value: 'none' } });
    expect(last(spy).auth).toEqual({ type: 'none' });
  });

  it('adds, edits and removes assertions', () => {
    const spy = vi.fn();
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('a-1-b-2-c');
    render(<Pane initial={request()} spy={spy} />);
    tab(/Asserções/);
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar asserção' }));
    expect(last(spy).assertions).toEqual([
      { id: 'a-1-b-2-c', source: 'status', operator: 'eq', expected: '200' },
    ]);
    // Status has no path; the expected value is editable.
    expect(screen.getByLabelText<HTMLInputElement>('Caminho').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Esperado'), { target: { value: '201' } });
    expect(last(spy).assertions[0]!.expected).toBe('201');

    fireEvent.change(screen.getByLabelText('Verificar'), { target: { value: 'json' } });
    expect(screen.getByLabelText<HTMLInputElement>('Caminho').placeholder).toBe('data.items[0].id');
    fireEvent.change(screen.getByLabelText('Caminho'), { target: { value: 'data.id' } });
    fireEvent.change(screen.getByLabelText('Verificar'), { target: { value: 'header' } });
    expect(screen.getByLabelText<HTMLInputElement>('Caminho').placeholder).toBe('content-type');

    fireEvent.change(screen.getByLabelText('Operador'), { target: { value: 'exists' } });
    expect(last(spy).assertions[0]).toMatchObject({
      source: 'header',
      path: 'data.id',
      operator: 'exists',
    });
    expect(screen.getByLabelText<HTMLInputElement>('Esperado').disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Remover' }));
    expect(last(spy).assertions).toEqual([]);
    vi.restoreAllMocks();
  });

  it('adds, edits and removes captures', () => {
    const spy = vi.fn();
    render(<Pane initial={request()} spy={spy} />);
    tab(/Capturas/);
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar captura' }));
    expect(last(spy).captures).toEqual([{ variable: '', source: 'json', path: '' }]);
    fireEvent.change(screen.getByLabelText('Variável'), { target: { value: 'token' } });
    fireEvent.change(screen.getByLabelText('Caminho'), { target: { value: 'data.token' } });
    fireEvent.change(screen.getByLabelText('Verificar'), { target: { value: 'status' } });
    expect(last(spy).captures).toEqual([
      { variable: 'token', source: 'status', path: 'data.token' },
    ]);
    expect(screen.getByLabelText<HTMLInputElement>('Caminho').disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Remover' }));
    expect(last(spy).captures).toEqual([]);
  });

  it('edits the description', () => {
    const spy = vi.fn();
    render(<Pane initial={request()} spy={spy} />);
    tab(/Descrição/);
    fireEvent.change(screen.getByLabelText('Descrição'), { target: { value: 'Notes' } });
    expect(last(spy).description).toBe('Notes');
  });

  it('edits one of several assertions and captures, leaving the others as they are', () => {
    const spy = vi.fn();
    const first = { id: 'a1', source: 'status' as const, operator: 'eq' as const };
    const second = {
      id: 'a2',
      source: 'status' as const,
      operator: 'eq' as const,
      expected: '200',
    };
    render(
      <Pane
        initial={request({
          assertions: [first, second],
          captures: [
            { variable: 'a', source: 'json', path: 'x' },
            { variable: 'b', source: 'json' },
          ],
        })}
        spy={spy}
      />,
    );
    tab(/Asserções/);
    expect(screen.getAllByLabelText<HTMLInputElement>('Esperado')[0]!.value).toBe('');
    fireEvent.change(screen.getAllByLabelText('Esperado')[1]!, { target: { value: '204' } });
    expect(last(spy).assertions).toEqual([first, { ...second, expected: '204' }]);

    tab(/Capturas/);
    fireEvent.change(screen.getAllByLabelText('Variável')[1]!, { target: { value: 'c' } });
    expect(last(spy).captures).toEqual([
      { variable: 'a', source: 'json', path: 'x' },
      { variable: 'c', source: 'json' },
    ]);
  });

  it('offers to load the mocks again without a handler from the view', async () => {
    render(
      <RequestPane
        request={request({ body: { mode: 'json', content: '' } })}
        readOnly={false}
        mocksFailed
        onChange={() => undefined}
      />,
    );
    fireEvent.click(screen.getByTestId('mocks'));
    fireEvent.click(await screen.findByRole('button', { name: 'Tentar novamente' }));
    expect(screen.getByText('Não foi possível carregar os mocks agora.')).toBeTruthy();
  });

  it('shows everything without editing tools to read-only members', () => {
    render(
      <Pane
        readOnly
        initial={request({
          description: 'doc',
          auth: { type: 'bearer', token: 't' },
          body: { mode: 'form', fields: [{ key: 'a', value: '1' }] },
          assertions: [{ id: 'x', source: 'json', operator: 'eq', path: 'a', expected: '1' }],
          captures: [{ variable: 'v', source: 'body' }],
        })}
      />,
    );
    expect(screen.getByLabelText<HTMLSelectElement>('Tipo do body').disabled).toBe(true);
    tab(/Asserções/);
    expect(screen.queryByRole('button', { name: 'Adicionar asserção' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Remover' })).toBeNull();
    tab(/Capturas/);
    expect(screen.queryByRole('button', { name: 'Adicionar captura' })).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Caminho').value).toBe('');
    tab(/Descrição/);
    expect(screen.getByLabelText<HTMLTextAreaElement>('Descrição').value).toBe('doc');
  });
});
