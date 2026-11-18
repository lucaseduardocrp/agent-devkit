import { fireEvent, render, waitFor, within, type RenderResult } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  newRequest,
  type ApiCollection,
  type ApiMockValue,
  type ApiRequestSpec,
  type GrpcServiceList,
  type RequestKind,
  type RequestResult,
} from '../src/features/apitests/api-test-types.js';
import { grpcServicesCache } from '../src/features/apitests/integration/protocol-model.js';
import { schemaCache } from '../src/features/apitests/integration/graphql-schema.js';
import { RequestPane, UrlBar } from '../src/features/apitests/integration/RequestPane.js';
import type { RequestActions } from '../src/features/apitests/integration/request-actions.js';

const MOCKS: ApiMockValue[] = [{ name: '$randomFullName', group: 'person', sample: 'Ana' }];

const collection = (patch: Partial<ApiCollection> = {}): ApiCollection => ({
  id: 'c1',
  workspaceId: 'w1',
  name: 'Orders API',
  variables: [],
  auth: { type: 'none' },
  items: [],
  source: { kind: 'adk' },
  updatedAt: '2026-10-24T10:00:00Z',
  ...patch,
});

/** The pane with its own state, as the workbench holds it, plus a spy on every change. */
function Harness({
  initial,
  readOnly = false,
  actions,
  collection: apiCollection = collection(),
  onChange,
}: {
  initial: ApiRequestSpec;
  readOnly?: boolean;
  actions?: RequestActions;
  collection?: ApiCollection;
  onChange?: (request: ApiRequestSpec) => void;
}) {
  const [request, setRequest] = useState(initial);
  const change = (next: ApiRequestSpec) => {
    setRequest(next);
    onChange?.(next);
  };
  return (
    <>
      <UrlBar
        request={request}
        collection={apiCollection}
        readOnly={readOnly}
        dirty
        sending={false}
        actions={actions}
        onChange={change}
        onSend={() => undefined}
        onCancel={() => undefined}
        onSave={() => undefined}
      />
      <RequestPane
        request={request}
        collection={apiCollection}
        actions={actions}
        readOnly={readOnly}
        mocks={MOCKS}
        onChange={change}
      />
    </>
  );
}

const request = (kind: RequestKind, patch: Partial<ApiRequestSpec> = {}): ApiRequestSpec => ({
  ...newRequest('r', kind, '{{baseUrl}}'),
  id: 'r1',
  ...patch,
});

const tabNames = (view: RenderResult) =>
  within(view.getByRole('tablist', { name: 'Requisição' }))
    .getAllByRole('tab')
    // The indicator (a count or a bullet) is part of the label text.
    .map((tab) => tab.textContent.replace(/[0-9•]+$/, ''));

const openTab = (view: RenderResult, name: RegExp | string) =>
  fireEvent.click(
    within(view.getByRole('tablist', { name: 'Requisição' })).getByRole('tab', { name }),
  );

const last = (spy: ReturnType<typeof vi.fn>): ApiRequestSpec =>
  spy.mock.calls[spy.mock.calls.length - 1]![0] as ApiRequestSpec;

const result = (patch: Partial<RequestResult> = {}): RequestResult => ({
  requestId: 'r1',
  name: 'r',
  path: [],
  method: 'POST',
  url: 'u',
  status: 200,
  durationMs: 1,
  sizeBytes: 1,
  passed: true,
  assertions: [],
  ...patch,
});

const SCHEMA = {
  data: {
    __schema: {
      queryType: { name: 'Query' },
      mutationType: null,
      subscriptionType: null,
      types: [
        {
          kind: 'OBJECT',
          name: 'Query',
          description: 'The root',
          fields: [
            {
              name: 'user',
              description: 'One user',
              args: [{ name: 'id', type: { kind: 'SCALAR', name: 'ID', ofType: null } }],
              type: { kind: 'OBJECT', name: 'User', ofType: null },
            },
          ],
        },
        {
          kind: 'OBJECT',
          name: 'User',
          fields: [
            {
              name: 'name',
              args: [],
              type: { kind: 'SCALAR', name: 'String', ofType: null },
              isDeprecated: true,
              deprecationReason: 'old',
            },
          ],
        },
        {
          kind: 'INPUT_OBJECT',
          name: 'UserInput',
          inputFields: [{ name: 'name', type: { kind: 'SCALAR', name: 'String', ofType: null } }],
        },
        {
          kind: 'ENUM',
          name: 'Role',
          enumValues: [{ name: 'ADMIN', description: 'all powers' }],
        },
        { kind: 'SCALAR', name: 'ID', description: 'An id' },
        {
          kind: 'INTERFACE',
          name: 'Node',
          fields: [],
          possibleTypes: [{ kind: 'OBJECT', name: 'User', ofType: null }],
        },
      ],
    },
  },
};

const services: GrpcServiceList = {
  services: [
    {
      name: 'shop.Orders',
      methods: [
        {
          name: 'Get',
          path: 'shop.Orders/Get',
          requestType: 'GetIn',
          responseType: 'Order',
          clientStreaming: false,
          serverStreaming: false,
          example: { id: 1 },
        },
        {
          name: 'Watch',
          path: 'shop.Orders/Watch',
          requestType: 'WatchIn',
          responseType: 'Order',
          clientStreaming: true,
          serverStreaming: true,
          example: { id: 2 },
        },
      ],
    },
  ],
};

describe('RequestPane: HTTP', () => {
  it('shows the HTTP tabs and edits the query, vars, docs and settings', () => {
    const onChange = vi.fn();
    const view = render(<Harness initial={request('http')} onChange={onChange} />);
    expect(tabNames(view)).toEqual([
      'Query',
      'Body',
      'Headers',
      'Auth',
      'Vars',
      'Script',
      'Asserções',
      'Capturas',
      'Testes',
      'Descrição',
      'Configurações',
    ]);

    openTab(view, 'Vars');
    fireEvent.click(view.getByRole('button', { name: /Adicionar/ }));
    fireEvent.change(view.getByLabelText('Chave'), { target: { value: 'tenant' } });
    expect(last(onChange).vars).toEqual([{ key: 'tenant', value: '' }]);

    openTab(view, 'Descrição');
    fireEvent.change(view.getByLabelText('Descrição'), { target: { value: 'What it does' } });
    expect(last(onChange).description).toBe('What it does');

    openTab(view, /^Configurações/);
    const settings = view.getByTestId('request-settings');
    fireEvent.change(within(settings).getByLabelText('Timeout (ms)'), {
      target: { value: '5000' },
    });
    expect(last(onChange).timeoutMs).toBe(5000);
    fireEvent.change(within(settings).getByLabelText('Timeout (ms)'), { target: { value: '' } });
    expect(last(onChange).timeoutMs).toBeUndefined();
    fireEvent.change(within(settings).getByLabelText('Tags'), { target: { value: 'smoke, auth' } });
    expect(last(onChange).tags).toEqual(['smoke', 'auth']);
    fireEvent.change(within(settings).getByLabelText('Tags'), { target: { value: ' ' } });
    expect(last(onChange).tags).toBeUndefined();
    fireEvent.change(within(settings).getByLabelText('Seguir redirecionamentos'), {
      target: { value: 'false' },
    });
    expect(last(onChange).settings).toEqual({ followRedirects: false });
    fireEvent.change(within(settings).getByLabelText('Seguir redirecionamentos'), {
      target: { value: 'true' },
    });
    expect(last(onChange).settings).toEqual({ followRedirects: true });
    fireEvent.change(within(settings).getByLabelText('Seguir redirecionamentos'), {
      target: { value: '' },
    });
    expect(last(onChange).settings?.followRedirects).toBeUndefined();
    fireEvent.change(within(settings).getByLabelText('Máximo de redirecionamentos'), {
      target: { value: '3' },
    });
    expect(last(onChange).settings?.maxRedirects).toBe(3);
    fireEvent.click(within(settings).getByLabelText('Codificar a URL'));
    expect(last(onChange).settings?.encodeUrl).toBe(false);
    fireEvent.click(within(settings).getByLabelText('Codificar a URL'));
    expect(last(onChange).settings?.encodeUrl).toBeUndefined();
  });

  it('opens on the Body tab when the request has a body, and edits every body type', async () => {
    const onChange = vi.fn();
    const view = render(
      <Harness
        initial={request('http', { method: 'POST', body: { mode: 'json', content: '{}' } })}
        onChange={onChange}
      />,
    );
    const mode = view.getByLabelText('Tipo do body');
    fireEvent.change(view.getByLabelText('Body'), { target: { value: '{"a": 1}' } });
    expect(last(onChange).body).toEqual({ mode: 'json', content: '{"a": 1}' });

    fireEvent.change(mode, { target: { value: 'sparql' } });
    expect(view.getByLabelText('Body')).toHaveAttribute(
      'placeholder',
      'SELECT ?s WHERE { ?s ?p ?o } LIMIT 10',
    );
    fireEvent.change(mode, { target: { value: 'text' } });
    expect(view.getByLabelText('Body')).toHaveAttribute('placeholder', '');

    fireEvent.change(mode, { target: { value: 'urlencoded' } });
    fireEvent.click(view.getByRole('button', { name: /Adicionar/ }));
    fireEvent.change(view.getByLabelText('Chave'), { target: { value: 'grant_type' } });
    expect(last(onChange).body).toEqual({
      mode: 'urlencoded',
      fields: [{ key: 'grant_type', value: '' }],
    });

    fireEvent.change(mode, { target: { value: 'form' } });
    const multipart = view.getByTestId('multipart-editor');
    expect(within(multipart).getByLabelText('Chave')).toBeInTheDocument();
    fireEvent.click(view.getByRole('button', { name: 'Adicionar arquivo' }));
    const parts = view.getAllByLabelText(/^Tipo de /);
    expect(parts).toHaveLength(2);
    expect((parts[1] as HTMLSelectElement).value).toBe('file');
    fireEvent.change(view.getAllByLabelText('Chave')[1]!, { target: { value: 'avatar' } });
    const picker = view.getByTestId('multipart-file-1');
    fireEvent.change(picker, {
      target: { files: [new File(['hi'], 'a.png', { type: 'image/png' })] },
    });
    await waitFor(() =>
      expect(last(onChange).body).toEqual({
        mode: 'form',
        fields: [
          { key: 'grant_type', value: '' },
          {
            key: 'avatar',
            value: '',
            type: 'file',
            file: { fileName: 'a.png', contentType: 'image/png', data: 'aGk=' },
          },
        ],
      }),
    );
    expect(view.getByText(/a\.png · 2B/)).toBeInTheDocument();
    // A part can carry its own content type, and go back to being text.
    fireEvent.change(view.getByLabelText('Content type de avatar'), {
      target: { value: 'image/webp' },
    });
    expect(
      (last(onChange).body as { fields: { contentType?: string }[] }).fields[1]!.contentType,
    ).toBe('image/webp');
    fireEvent.change(view.getByLabelText('Content type de avatar'), { target: { value: '' } });
    fireEvent.click(view.getByRole('button', { name: 'Remover arquivo' }));
    expect(
      (last(onChange).body as { fields: { file?: unknown }[] }).fields[1]!.file,
    ).toBeUndefined();
    fireEvent.change(view.getAllByLabelText(/^Tipo de /)[1]!, { target: { value: 'text' } });
    fireEvent.change(view.getAllByLabelText('avatar')[0]!, { target: { value: 'x' } });
    expect((last(onChange).body as { fields: { value: string }[] }).fields[1]!.value).toBe('x');
    fireEvent.click(view.getAllByLabelText('Ativo')[1]!);
    expect((last(onChange).body as { fields: { enabled?: boolean }[] }).fields[1]!.enabled).toBe(
      false,
    );
    fireEvent.click(view.getAllByLabelText('Remover')[1]!);
    expect((last(onChange).body as { fields: unknown[] }).fields).toHaveLength(1);

    fireEvent.change(mode, { target: { value: 'binary' } });
    fireEvent.change(view.getByTestId('binary-file'), {
      target: { files: [new File(['pdf'], 'x.pdf', { type: 'application/pdf' })] },
    });
    await waitFor(() =>
      expect(last(onChange).body).toEqual({
        mode: 'binary',
        file: { fileName: 'x.pdf', contentType: 'application/pdf', data: 'cGRm' },
      }),
    );
    fireEvent.click(view.getByRole('button', { name: 'Remover arquivo' }));
    expect(last(onChange).body).toEqual({ mode: 'binary', file: null });

    fireEvent.change(mode, { target: { value: 'none' } });
    expect(view.getByText('Esta requisição não tem corpo.')).toBeInTheDocument();
  });

  it('refuses a file over the limit and reports a read error', async () => {
    const view = render(
      <Harness initial={request('http', { body: { mode: 'binary', file: null } })} />,
    );
    const input = view.getByTestId('binary-file');
    const big = new File(['x'], 'big.bin');
    Object.defineProperty(big, 'size', { value: 4 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [big] } });
    expect(await view.findByRole('alert')).toHaveTextContent('big.bin é maior que 3.00MB');
    // Nothing picked leaves the field alone.
    fireEvent.change(input, { target: { files: [] } });
    const original = globalThis.FileReader;
    class Failing {
      onerror: (() => void) | null = null;
      error = new Error('nope');
      readAsDataURL() {
        this.onerror?.();
      }
    }
    globalThis.FileReader = Failing as unknown as typeof FileReader;
    fireEvent.change(input, { target: { files: [new File(['x'], 'bad.bin')] } });
    expect(await view.findByText('Não foi possível ler bad.bin.')).toBeInTheDocument();
    globalThis.FileReader = original;
  });

  it('writes scripts and tests, and inserts a snippet', () => {
    const onChange = vi.fn();
    const view = render(<Harness initial={request('http')} onChange={onChange} />);
    openTab(view, /^Script/);
    const phases = view.getByRole('tablist', { name: 'Script' });
    fireEvent.change(view.getByLabelText('Antes da requisição'), {
      target: { value: "adk.setVar('a', 1);" },
    });
    expect(last(onChange).scripts).toEqual({ preRequest: "adk.setVar('a', 1);" });
    // The tab of a phase that has code is marked.
    expect(
      within(phases)
        .getByRole('tab', { name: /Antes da requisição/ })
        .querySelector('span'),
    ).toBeTruthy();
    fireEvent.click(within(phases).getByRole('tab', { name: /Depois da resposta/ }));
    fireEvent.change(view.getByLabelText('Depois da resposta'), { target: { value: 'res;' } });
    expect(last(onChange).scripts?.postResponse).toBe('res;');

    fireEvent.click(view.getByTestId('snippets'));
    fireEvent.click(view.getByRole('button', { name: 'Salvar um token do corpo' }));
    expect(last(onChange).scripts?.postResponse).toContain("adk.setVar('token'");

    openTab(view, /^Testes/);
    fireEvent.click(view.getByTestId('snippets'));
    fireEvent.click(view.getByRole('button', { name: 'Teste: status é 200' }));
    expect(last(onChange).scripts?.tests).toContain('expect(res.getStatus()).to.equal(200)');
    expect(
      within(view.getByRole('tablist', { name: 'Requisição' })).getByRole('tab', {
        name: /Testes/,
      }),
    ).toBeInTheDocument();
  });

  it('opens the Script tab on the phase that has code and hides the snippets when read-only', () => {
    const view = render(
      <Harness readOnly initial={request('http', { scripts: { postResponse: 'res;' } })} />,
    );
    openTab(view, /^Script/);
    expect((view.getByLabelText('Depois da resposta') as HTMLTextAreaElement).value).toBe('res;');
    expect(view.queryByTestId('snippets')).toBeNull();
  });
});

describe('RequestPane: GraphQL', () => {
  it('edits the document and its variables', () => {
    const onChange = vi.fn();
    const view = render(<Harness initial={request('graphql')} onChange={onChange} />);
    expect(tabNames(view)).toEqual([
      'Query',
      'Variáveis',
      'Headers',
      'Auth',
      'Vars',
      'Script',
      'Asserções',
      'Capturas',
      'Testes',
      'Descrição',
      'Configurações',
    ]);
    fireEvent.change(view.getByLabelText('Nome da operação'), { target: { value: 'Me' } });
    expect(last(onChange).graphql?.operationName).toBe('Me');
    fireEvent.change(view.getByLabelText('Nome da operação'), { target: { value: '' } });
    expect(last(onChange).graphql?.operationName).toBeUndefined();
    fireEvent.change(view.getByLabelText('Query'), { target: { value: '{ me { id } }' } });
    expect(last(onChange).graphql?.query).toBe('{ me { id } }');
    // Prettify works on the document.
    fireEvent.click(view.getByTestId('format-body'));
    expect(last(onChange).graphql?.query).toBe('{\n  me {\n    id\n  }\n}');

    openTab(view, /^Variáveis/);
    fireEvent.change(view.getByLabelText('Variáveis'), { target: { value: '{"id":1}' } });
    expect(last(onChange).graphql?.variables).toBe('{"id":1}');
    fireEvent.click(view.getByTestId('format-body'));
    expect(last(onChange).graphql?.variables).toBe('{\n  "id": 1\n}');
  });

  it('defaults an empty query and variables when the request carries no graphql spec at all', () => {
    const view = render(<Harness initial={request('graphql', { graphql: undefined })} />);
    expect((view.getByLabelText('Query') as HTMLTextAreaElement).value).toBe('');
    openTab(view, /^Variáveis/);
    expect((view.getByLabelText('Variáveis') as HTMLTextAreaElement).value).toBe('');
  });

  it('refuses to reload the schema once actions are no longer available', async () => {
    schemaCache.clear();
    const runAdHoc = vi.fn(() =>
      Promise.resolve(result({ response: { headers: {}, bodyPreview: JSON.stringify(SCHEMA) } })),
    );
    const actions: RequestActions = {
      runAdHoc,
      listGrpcServices: () => Promise.reject(new Error('no')),
    };
    const spec = request('graphql', { graphql: { query: '{ a }' } });
    const view = render(<Harness initial={spec} actions={actions} />);
    fireEvent.click(view.getByTestId('graphql-schema'));
    await view.findByTestId('graphql-docs');
    // The explorer stays open with its stale schema when the pane loses its way to re-fetch.
    view.rerender(<Harness initial={spec} />);
    runAdHoc.mockClear();
    fireEvent.click(view.getByRole('button', { name: 'Recarregar schema' }));
    expect(runAdHoc).not.toHaveBeenCalled();
  });

  it('fetches the schema, opens its docs and completes field names', async () => {
    schemaCache.clear();
    const runAdHoc = vi.fn(() =>
      Promise.resolve(result({ response: { headers: {}, bodyPreview: JSON.stringify(SCHEMA) } })),
    );
    const actions: RequestActions = {
      runAdHoc,
      listGrpcServices: () => Promise.reject(new Error('no')),
    };
    const onChange = vi.fn();
    const view = render(
      <Harness
        initial={request('graphql', { graphql: { query: 'query { ', variables: '{}' } })}
        actions={actions}
        onChange={onChange}
      />,
    );
    fireEvent.click(view.getByTestId('graphql-schema'));
    await view.findByTestId('graphql-docs');
    // The panel re-renders with the pane, so it is looked up again on each step.
    const panel = () => within(view.getByTestId('graphql-docs'));
    expect(runAdHoc).toHaveBeenCalledWith(
      expect.objectContaining({
        graphql: expect.objectContaining({ operationName: 'IntrospectionQuery' }),
      }),
    );

    // Root types, a type page, its fields, arguments and the click-through to another type.
    fireEvent.click(panel().getAllByRole('button', { name: 'Query' })[1]!);
    expect(panel().getByText('One user')).toBeInTheDocument();
    fireEvent.click(panel().getByRole('button', { name: 'ID' }));
    expect(panel().getAllByRole('heading')[0]!.textContent).toBe('ID');
    fireEvent.click(panel().getByRole('button', { name: 'Voltar' }));
    fireEvent.click(panel().getByRole('button', { name: 'User' }));
    expect(panel().getByText('obsoleto')).toBeInTheDocument();

    // Search finds types and fields, and opens the type.
    fireEvent.change(panel().getByLabelText('Buscar tipos e campos'), {
      target: { value: 'nam' },
    });
    const results = panel().getByTestId('schema-search-results');
    expect(within(results).getByText('.name')).toBeInTheDocument();
    fireEvent.click(within(results).getAllByRole('button')[0]!);
    fireEvent.change(panel().getByLabelText('Buscar tipos e campos'), {
      target: { value: 'zzz' },
    });
    expect(panel().getByText('Nada encontrado.')).toBeInTheDocument();
    fireEvent.change(panel().getByLabelText('Buscar tipos e campos'), { target: { value: '' } });

    // Input objects, enums and interfaces have their own pages, reached from the search.
    const search = (text: string) => {
      fireEvent.change(panel().getByLabelText('Buscar tipos e campos'), {
        target: { value: text },
      });
      fireEvent.click(
        within(panel().getByTestId('schema-search-results')).getAllByRole('button')[0]!,
      );
    };
    search('UserInput');
    expect(panel().getByText('name')).toBeInTheDocument();
    search('Role');
    expect(panel().getByText('all powers')).toBeInTheDocument();
    search('Node');
    fireEvent.click(panel().getByRole('button', { name: 'User' }));
    expect(panel().getAllByRole('heading')[0]!.textContent).toBe('User');

    // The query editor completes the fields of the type at the caret.
    const editor = view.getByLabelText('Query');
    editor.focus();
    fireEvent.change(editor, {
      target: { value: 'query { us', selectionStart: 10, selectionEnd: 10 },
    });
    const words = await view.findByTestId('word-suggestions');
    expect(within(words).getByText('user')).toBeInTheDocument();
    expect(within(words).getByText('User')).toBeInTheDocument();
    // The keyboard chooses among the field suggestions too, not just the mouse.
    fireEvent.keyDown(editor, { key: 'ArrowDown' });
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(last(onChange).graphql?.query).toBe('query { user');

    // Hovering and clicking a suggestion with the mouse chooses it as well.
    fireEvent.change(editor, {
      target: { value: 'query { user { na', selectionStart: 17, selectionEnd: 17 },
    });
    const mouseWords = await view.findByTestId('word-suggestions');
    const options = within(mouseWords).getAllByRole('option');
    fireEvent.mouseEnter(options[0]!);
    expect(options[0]!.getAttribute('aria-selected')).toBe('true');
    fireEvent.mouseDown(options[0]!);
    expect(last(onChange).graphql?.query).toBe('query { user { name');

    // The docs close and open again from the cache, without another request.
    fireEvent.click(panel().getByRole('button', { name: 'Fechar' }));
    expect(view.queryByTestId('graphql-docs')).toBeNull();
    fireEvent.click(view.getByTestId('graphql-schema'));
    expect(view.getByTestId('graphql-docs')).toBeInTheDocument();
    expect(runAdHoc).toHaveBeenCalledTimes(1);
    // The reload button in the docs asks again.
    fireEvent.click(view.getByRole('button', { name: 'Recarregar schema' }));
    await waitFor(() => expect(runAdHoc).toHaveBeenCalledTimes(2));
    schemaCache.clear();
  });

  it('shows why the schema failed and retries', async () => {
    schemaCache.clear();
    const runAdHoc = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce('truncated')
      .mockResolvedValue(
        result({ response: { headers: {}, bodyPreview: JSON.stringify(SCHEMA) } }),
      );
    const view = render(
      <Harness
        initial={request('graphql')}
        actions={{ runAdHoc, listGrpcServices: () => Promise.reject(new Error('no')) }}
      />,
    );
    fireEvent.click(view.getByTestId('graphql-schema'));
    expect(await view.findByRole('alert')).toHaveTextContent('offline');
    fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
    await waitFor(() =>
      expect(view.getByRole('alert')).toHaveTextContent(
        'O schema é maior que a prévia da resposta que o motor guarda.',
      ),
    );
    fireEvent.click(view.getByRole('button', { name: 'Tentar novamente' }));
    expect(await view.findByTestId('graphql-docs')).toBeInTheDocument();
    schemaCache.clear();
  });

  it('offers no schema button without the workbench actions', () => {
    const view = render(<Harness initial={request('graphql')} />);
    expect(view.queryByTestId('graphql-schema')).toBeNull();
  });
});

describe('RequestPane: gRPC', () => {
  it('lists the methods, fills the example message and picks the definition source', async () => {
    grpcServicesCache.clear();
    const listGrpcServices = vi.fn(() => Promise.resolve(services));
    const onChange = vi.fn();
    const view = render(
      <Harness
        initial={request('grpc')}
        actions={{ runAdHoc: () => Promise.reject(new Error('no')), listGrpcServices }}
        collection={collection({ protoFiles: [{ name: 'shop.proto', content: 'syntax' }] })}
        onChange={onChange}
      />,
    );
    expect(tabNames(view)).toEqual([
      'Mensagem',
      'Metadados',
      'Auth',
      'Vars',
      'Script',
      'Asserções',
      'Capturas',
      'Testes',
      'Descrição',
      'Configurações',
    ]);
    expect(view.getByTestId('kind-label').textContent).toBe('gRPC');

    const picker = view.getByTestId('grpc-method-select');
    fireEvent.focus(picker);
    await waitFor(() => expect(listGrpcServices).toHaveBeenCalled());
    fireEvent.click(await view.findByRole('option', { name: 'shop.Orders/Get' }));
    expect(last(onChange).grpc).toEqual({
      method: 'shop.Orders/Get',
      reflection: true,
      message: '{\n  "id": 1\n}',
    });

    // A streaming method is marked and its example goes in an array; a message already written stays.
    fireEvent.focus(picker);
    fireEvent.click(await view.findByRole('option', { name: /Watch · bidirecional/ }));
    expect(last(onChange).grpc?.message).toBe('{\n  "id": 1\n}');
    expect(view.getByText('WatchIn → Order')).toBeInTheDocument();
    fireEvent.change(view.getByLabelText('Mensagem'), { target: { value: '[]' } });
    fireEvent.focus(picker);
    fireEvent.click(await view.findByRole('option', { name: /Watch · bidirecional/ }));
    expect(last(onChange).grpc?.message).toBe('[\n  {\n    "id": 2\n  }\n]');
    expect(view.getByTestId('grpc-stream-hint')).toBeInTheDocument();

    fireEvent.change(view.getByTestId('grpc-source'), { target: { value: 'proto:shop.proto' } });
    expect(last(onChange).grpc?.reflection).toBe(false);
    expect(last(onChange).grpc?.protoFile).toBe('shop.proto');
    fireEvent.change(view.getByTestId('grpc-source'), { target: { value: 'reflection' } });
    expect(last(onChange).grpc?.reflection).toBe(true);
    grpcServicesCache.clear();
  });

  it('warns when there is no proto file and keeps a method it does not know', () => {
    const view = render(
      <Harness
        initial={request('grpc', {
          grpc: { method: 'other.S/M', reflection: false, protoFile: 'gone.proto', message: '{}' },
        })}
      />,
    );
    expect(view.getByRole('note')).toHaveTextContent('A coleção não tem arquivos proto');
    expect((view.getByTestId('grpc-method-select') as HTMLInputElement).value).toBe('other.S/M');
    // Without actions there is no reload button.
    expect(view.queryByTestId('grpc-reload-methods')).toBeNull();
  });

  it('reports why the methods could not be listed and reloads', async () => {
    grpcServicesCache.clear();
    const listGrpcServices = vi
      .fn()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue(services);
    const view = render(
      <Harness
        initial={request('grpc')}
        actions={{ runAdHoc: () => Promise.reject(new Error('no')), listGrpcServices }}
      />,
    );
    fireEvent.focus(view.getByTestId('grpc-method-select'));
    expect(await view.findByRole('alert')).toHaveTextContent('unavailable');
    fireEvent.click(view.getByTestId('grpc-reload-methods'));
    await waitFor(() => expect(listGrpcServices).toHaveBeenCalledTimes(2));
    fireEvent.focus(view.getByTestId('grpc-method-select'));
    expect(await view.findByRole('option', { name: 'shop.Orders/Get' })).toBeInTheDocument();
    grpcServicesCache.clear();
  });

  it('shows the proto file of a spec with no file name', () => {
    const view = render(
      <Harness
        initial={request('grpc', { grpc: { method: '', reflection: false, message: '{}' } })}
        collection={collection({ protoFiles: [] })}
      />,
    );
    expect(view.getByTestId('grpc-source').textContent).toContain('Todos os arquivos proto');
  });

  it('does not try to load methods without a way to list them', () => {
    const view = render(<Harness initial={request('grpc')} />);
    fireEvent.focus(view.getByTestId('grpc-method-select'));
    expect(view.queryByRole('alert')).toBeNull();
  });

  it('reports a non-Error rejection listing methods', async () => {
    grpcServicesCache.clear();
    const listGrpcServices = vi.fn().mockRejectedValueOnce('offline');
    const view = render(
      <Harness
        initial={request('grpc')}
        actions={{ runAdHoc: () => Promise.reject(new Error('no')), listGrpcServices }}
      />,
    );
    fireEvent.focus(view.getByTestId('grpc-method-select'));
    expect(await view.findByRole('alert')).toHaveTextContent('offline');
    grpcServicesCache.clear();
  });

  it('clears the proto file when the chosen name is empty', () => {
    const onChange = vi.fn();
    const view = render(<Harness initial={request('grpc')} onChange={onChange} />);
    fireEvent.change(view.getByTestId('grpc-source'), { target: { value: 'proto:' } });
    expect(last(onChange).grpc?.protoFile).toBeUndefined();
  });
});

describe('RequestPane: streams', () => {
  it('edits the messages of a WebSocket request and its settings', () => {
    const onChange = vi.fn();
    const view = render(<Harness initial={request('websocket')} onChange={onChange} />);
    expect(tabNames(view)).toEqual([
      'Mensagens',
      'Headers',
      'Auth',
      'Vars',
      'Configurações',
      'Script',
      'Asserções',
      'Capturas',
      'Testes',
      'Descrição',
    ]);
    expect(view.getByRole('button', { name: 'Conectar' })).toBeInTheDocument();

    fireEvent.change(view.getByLabelText('Conteúdo da mensagem 1'), {
      target: { value: '{"type":"ping"}' },
    });
    expect(last(onChange).websocket?.messages[0]!.content).toBe('{"type":"ping"}');
    fireEvent.change(view.getByLabelText('Nome da mensagem 1'), { target: { value: 'ping' } });
    expect(last(onChange).websocket?.messages[0]!.name).toBe('ping');
    fireEvent.change(view.getByLabelText('Nome da mensagem 1'), { target: { value: '' } });
    expect(last(onChange).websocket?.messages[0]!.name).toBeUndefined();
    fireEvent.change(view.getByLabelText('Tipo da mensagem 1'), { target: { value: 'json' } });
    expect(last(onChange).websocket?.messages[0]!.type).toBe('json');
    fireEvent.change(view.getByLabelText('Atraso da mensagem 1 (ms)'), {
      target: { value: '250' },
    });
    expect(last(onChange).websocket?.messages[0]!.delayMs).toBe(250);
    fireEvent.change(view.getByLabelText('Atraso da mensagem 1 (ms)'), { target: { value: '' } });
    expect(last(onChange).websocket?.messages[0]!.delayMs).toBeUndefined();

    fireEvent.click(view.getByRole('button', { name: 'Adicionar mensagem' }));
    fireEvent.change(view.getByLabelText('Conteúdo da mensagem 2'), { target: { value: 'bye' } });
    expect(last(onChange).websocket?.messages).toHaveLength(2);
    // Reordering keeps the contents.
    fireEvent.click(view.getByRole('button', { name: 'Subir mensagem 2' }));
    expect(last(onChange).websocket?.messages[0]!.content).toBe('bye');
    fireEvent.click(view.getByRole('button', { name: 'Descer mensagem 1' }));
    expect(last(onChange).websocket?.messages[1]!.content).toBe('bye');
    fireEvent.click(view.getByRole('button', { name: 'Remover mensagem 2' }));
    expect(last(onChange).websocket?.messages).toHaveLength(1);

    openTab(view, /^Configurações/);
    const settings = view.getByTestId('request-settings');
    fireEvent.change(within(settings).getByLabelText('Subprotocolos'), {
      target: { value: 'graphql-ws, json' },
    });
    expect(last(onChange).websocket?.subprotocols).toEqual(['graphql-ws', 'json']);
    fireEvent.change(within(settings).getByLabelText('Escutar por (ms)'), {
      target: { value: '4000' },
    });
    expect(last(onChange).websocket?.listenMs).toBe(4000);
    fireEvent.change(within(settings).getByLabelText('Máximo de mensagens'), {
      target: { value: '10' },
    });
    expect(last(onChange).websocket?.maxMessages).toBe(10);
  });

  it('edits an SSE request', () => {
    const onChange = vi.fn();
    const view = render(<Harness initial={request('sse')} onChange={onChange} />);
    expect(tabNames(view)).toEqual([
      'Headers',
      'Auth',
      'Body',
      'Vars',
      'Configurações',
      'Script',
      'Asserções',
      'Capturas',
      'Testes',
      'Descrição',
    ]);
    openTab(view, /^Configurações/);
    const settings = view.getByTestId('request-settings');
    fireEvent.change(within(settings).getByLabelText('Escutar por (ms)'), {
      target: { value: '8000' },
    });
    expect(last(onChange).sse?.listenMs).toBe(8000);
    fireEvent.change(within(settings).getByLabelText('Máximo de eventos'), {
      target: { value: '5' },
    });
    expect(last(onChange).sse?.maxEvents).toBe(5);
  });

  it('edits a socket request: hex and base64 messages, readUntil and the encoding', () => {
    const onChange = vi.fn();
    const view = render(
      <Harness
        initial={request('socket', { sse: undefined, socket: undefined })}
        onChange={onChange}
      />,
    );
    expect(tabNames(view)).toEqual([
      'Mensagens',
      'Vars',
      'Configurações',
      'Script',
      'Asserções',
      'Capturas',
      'Testes',
      'Descrição',
    ]);
    expect(view.getByTestId('messages-editor').textContent).toContain('Escritas em ordem');
    fireEvent.click(view.getByRole('button', { name: 'Adicionar mensagem' }));
    fireEvent.change(view.getByLabelText('Tipo da mensagem 1'), { target: { value: 'hex' } });
    expect(last(onChange).socket?.messages[0]!.type).toBe('hex');
    expect(view.getByLabelText('Conteúdo da mensagem 1')).toHaveAttribute(
      'placeholder',
      '48 65 6c 6c 6f',
    );

    openTab(view, /^Configurações/);
    const settings = view.getByTestId('request-settings');
    fireEvent.change(within(settings).getByLabelText('Ler até'), { target: { value: '\\n' } });
    expect(last(onChange).socket?.readUntil).toBe('\\n');
    fireEvent.change(within(settings).getByLabelText('Ler até'), { target: { value: '' } });
    expect(last(onChange).socket?.readUntil).toBeUndefined();
    fireEvent.change(within(settings).getByLabelText('Codificação da resposta'), {
      target: { value: 'hex' },
    });
    expect(last(onChange).socket?.responseEncoding).toBe('hex');
    fireEvent.change(within(settings).getByLabelText('Escutar por (ms)'), {
      target: { value: '1000' },
    });
    expect(last(onChange).socket?.listenMs).toBe(1000);
  });

  it('hides every control of a read-only request', () => {
    const view = render(
      <Harness
        readOnly
        initial={request('websocket', {
          websocket: { messages: [{ content: 'a' }, { content: 'b' }] },
        })}
      />,
    );
    expect(view.queryByRole('button', { name: 'Adicionar mensagem' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Subir mensagem 2' })).toBeNull();
    expect(view.queryByTestId('save-collection')).toBeNull();
    expect(view.queryByTestId('run-request')).toBeNull();
  });
});

describe('UrlBar', () => {
  it('generates code in the language the user picks', async () => {
    const view = render(
      <Harness
        initial={request('http', {
          method: 'POST',
          body: { mode: 'json', content: '{"a":1}' },
          auth: { type: 'inherit' },
        })}
        collection={collection({
          auth: { type: 'bearer', token: '{{token}}' },
          items: [request('http')],
        })}
      />,
    );
    fireEvent.click(view.getByTestId('generate-code'));
    const dialog = await view.findByTestId('code-dialog');
    expect(dialog.textContent).toContain('curl -X POST');
    // The inherited auth of the collection is in the snippet.
    expect(dialog.textContent).toContain('Bearer {{token}}');
    fireEvent.change(within(dialog).getByLabelText('Linguagem'), { target: { value: 'python' } });
    expect(dialog.textContent).toContain('import requests');

    const writeText = vi.fn((_text: string) => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    fireEvent.click(within(dialog).getByRole('button', { name: /Copiar/ }));
    await waitFor(() => expect(view.getByRole('button', { name: /Copiado/ })).toBeInTheDocument());
    expect(writeText.mock.calls[0]![0]).toContain('import requests');
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Fechar' })[0]!);
    expect(view.queryByTestId('code-dialog')).toBeNull();
  });

  it('offers only grpcurl for a gRPC request', async () => {
    const view = render(<Harness initial={request('grpc')} />);
    fireEvent.click(view.getByTestId('generate-code'));
    const dialog = await view.findByTestId('code-dialog');
    expect((within(dialog).getByLabelText('Linguagem') as HTMLSelectElement).disabled).toBe(true);
    expect(dialog.textContent).toContain('grpcurl');
  });

  it('keeps the method picker for HTTP and GraphQL only', () => {
    const http = render(<Harness initial={request('http')} />);
    expect(http.getByTestId('method-select')).toBeInTheDocument();
    http.unmount();
    const graphql = render(<Harness initial={request('graphql')} />);
    const method = graphql.getByTestId('method-select');
    fireEvent.click(method);
    expect(graphql.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'POST',
      'GET',
    ]);
    graphql.unmount();
    const socket = render(<Harness initial={request('socket')} />);
    expect(socket.queryByTestId('method-select')).toBeNull();
    expect(socket.getByTestId('kind-label').textContent).toBe('TCP');
  });
});

describe('RequestPane: checks and corners', () => {
  it('edits the assertions and the captures', () => {
    const onChange = vi.fn();
    const view = render(<Harness initial={request('http')} onChange={onChange} />);
    openTab(view, /Asserções/);
    // The status assertion of a new request: no path, a value.
    expect((view.getByLabelText('Caminho') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(view.getByLabelText('Verificar'), { target: { value: 'json' } });
    fireEvent.change(view.getByLabelText('Caminho'), { target: { value: 'data.id' } });
    fireEvent.change(view.getByLabelText('Operador'), { target: { value: 'exists' } });
    expect(last(onChange).assertions[0]).toEqual({
      id: expect.any(String),
      source: 'json',
      path: 'data.id',
      operator: 'exists',
      expected: '200',
    });
    expect((view.getByLabelText('Esperado') as HTMLInputElement).disabled).toBe(true);
    fireEvent.change(view.getByLabelText('Verificar'), { target: { value: 'header' } });
    expect(view.getByLabelText('Caminho')).toHaveAttribute('placeholder', 'content-type');
    fireEvent.click(view.getByRole('button', { name: /Adicionar asserção/ }));
    expect(last(onChange).assertions).toHaveLength(2);
    fireEvent.click(view.getAllByRole('button', { name: 'Remover' })[0]!);
    expect(last(onChange).assertions).toHaveLength(1);

    openTab(view, /Capturas/);
    fireEvent.click(view.getByRole('button', { name: /Adicionar captura/ }));
    fireEvent.change(view.getByLabelText('Variável'), { target: { value: 'token' } });
    fireEvent.change(view.getByLabelText('Caminho'), { target: { value: 'data.token' } });
    expect(last(onChange).captures[0]).toEqual({
      variable: 'token',
      source: 'json',
      path: 'data.token',
    });
    fireEvent.change(view.getByLabelText('Verificar'), { target: { value: 'status' } });
    expect((view.getByLabelText('Caminho') as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(view.getByRole('button', { name: 'Remover' }));
    expect(last(onChange).captures).toEqual([]);
  });

  it('shows the assertions and captures of a read-only request without the buttons', () => {
    const view = render(
      <Harness
        readOnly
        initial={request('http', { captures: [{ variable: 'token', source: 'json', path: 't' }] })}
      />,
    );
    openTab(view, /Asserções/);
    expect(view.queryByRole('button', { name: /Adicionar asserção/ })).toBeNull();
    openTab(view, /Capturas/);
    expect(view.queryByRole('button', { name: /Adicionar captura/ })).toBeNull();
    expect(view.queryByRole('button', { name: 'Remover' })).toBeNull();
  });

  it('opens a request of another kind on the first tab of that kind', () => {
    const view = render(<Harness initial={request('http')} />);
    openTab(view, /Headers/);
    view.unmount();
    const graphql = render(<Harness initial={request('graphql')} />);
    expect(graphql.getByLabelText('Query')).toBeInTheDocument();
  });

  it('marks the Auth tab when the request sets its own auth', () => {
    const view = render(
      <Harness initial={request('http', { auth: { type: 'bearer', token: '{{t}}' } })} />,
    );
    expect(
      within(view.getByRole('tablist', { name: 'Requisição' })).getByRole('tab', { name: /Auth/ })
        .textContent,
    ).toContain('•');
    openTab(view, /Auth/);
    expect(view.getByLabelText('Autenticação')).toBeInTheDocument();
  });

  it('works without a collection, mocks or the workbench actions', () => {
    const view = render(
      <RequestPane request={request('grpc')} readOnly={false} onChange={() => undefined} />,
    );
    expect(view.getByLabelText('Mensagem')).toBeInTheDocument();
    expect(view.getByTestId('grpc-source')).toBeInTheDocument();
    fireEvent.click(
      within(view.getByRole('tablist', { name: 'Requisição' })).getByRole('tab', { name: /Auth/ }),
    );
    expect(view.getByLabelText('Autenticação')).toBeInTheDocument();
  });

  it('warns when the GraphQL document cannot be formatted', () => {
    const view = render(
      <Harness initial={request('graphql', { graphql: { query: '{ a', variables: '{}' } })} />,
    );
    fireEvent.click(view.getByTestId('format-body'));
    expect(view.getByRole('status').textContent).toContain('chaves ou parênteses não fecham');
  });

  it('keeps the URL as typed until the field loses the focus', () => {
    const view = render(<Harness initial={request('http')} />);
    const url = view.getByLabelText('URL') as HTMLInputElement;
    fireEvent.change(url, { target: { value: '{{baseUrl}}/x?a' } });
    expect(url.value).toBe('{{baseUrl}}/x?a');
    fireEvent.blur(url);
    // The field shows the query as the editor keeps it once it is no longer being typed.
    fireEvent.change(url, { target: { value: '{{baseUrl}}/y' } });
    fireEvent.blur(url);
    expect(url.value).toBe('{{baseUrl}}/y');
  });

  it('picks a file with no type of its own', async () => {
    const onChange = vi.fn();
    const view = render(
      <Harness
        initial={request('http', { body: { mode: 'form', fields: [] } })}
        onChange={onChange}
      />,
    );
    fireEvent.click(view.getByRole('button', { name: 'Adicionar arquivo' }));
    fireEvent.change(view.getByTestId('multipart-file-0'), {
      target: { files: [new File(['x'], 'plain')] },
    });
    await waitFor(() =>
      expect(
        (last(onChange).body as { fields: { file?: { contentType?: string } }[] }).fields[0]!.file,
      ).toEqual({ fileName: 'plain', data: 'eA==' }),
    );
    expect(view.getByRole('button', { name: 'Trocar arquivo' })).toBeInTheDocument();
  });

  it('lists the arguments of a field in the docs', async () => {
    schemaCache.clear();
    const body = JSON.stringify({
      data: {
        __schema: {
          queryType: { name: 'Query' },
          types: [
            {
              kind: 'OBJECT',
              name: 'Query',
              fields: [
                {
                  name: 'search',
                  args: [
                    { name: 'text', type: { kind: 'SCALAR', name: 'String', ofType: null } },
                    { name: 'first', type: { kind: 'SCALAR', name: 'Int', ofType: null } },
                  ],
                  type: { kind: 'SCALAR', name: 'String', ofType: null },
                },
              ],
            },
          ],
        },
      },
    });
    const view = render(
      <Harness
        initial={request('graphql')}
        actions={{
          runAdHoc: () => Promise.resolve(result({ response: { headers: {}, bodyPreview: body } })),
          listGrpcServices: () => Promise.reject(new Error('no')),
        }}
      />,
    );
    fireEvent.click(view.getByTestId('graphql-schema'));
    const docs = await view.findByTestId('graphql-docs');
    fireEvent.click(within(docs).getAllByRole('button', { name: 'Query' })[1]!);
    expect(within(view.getByTestId('graphql-docs')).getByText('first')).toBeInTheDocument();
    schemaCache.clear();
  });

  it('falls back to the new kind’s first tab when the chosen tab no longer exists', () => {
    function KindSwitcher() {
      const [req, setReq] = useState<ApiRequestSpec>(request('http'));
      return (
        <>
          <button onClick={() => setReq(request('grpc'))}>switch</button>
          <RequestPane request={req} readOnly={false} mocks={MOCKS} onChange={setReq} />
        </>
      );
    }
    const view = render(<KindSwitcher />);
    // The default HTTP tab is "query", which grpc has no equivalent of.
    expect(tabNames(view)[0]).toMatch(/Query/i);
    fireEvent.click(view.getByRole('button', { name: 'switch' }));
    expect(view.getByRole('tab', { selected: true }).textContent).toMatch(/Mensagem/i);
  });
});
