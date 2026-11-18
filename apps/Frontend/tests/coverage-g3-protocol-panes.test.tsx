import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  newRequest,
  type ApiCollection,
  type ApiRequestSpec,
  type RequestKind,
  type RequestResult,
} from '../src/features/apitests/api-test-types.js';
import { schemaCache } from '../src/features/apitests/integration/graphql-schema.js';
import type { ResponseEntry } from '../src/features/apitests/integration/integration-model.js';
import { grpcServicesCache } from '../src/features/apitests/integration/protocol-model.js';
import { RequestPane, UrlBar } from '../src/features/apitests/integration/RequestPane.js';
import type { RequestActions } from '../src/features/apitests/integration/request-actions.js';
import { ResponsePane } from '../src/features/apitests/integration/ResponsePane.js';
import { HistoryList } from '../src/features/apitests/integration/Timeline.js';

const request = (kind: RequestKind, patch: Partial<ApiRequestSpec> = {}): ApiRequestSpec => ({
  ...newRequest('r', kind, '{{baseUrl}}'),
  id: 'r1',
  ...patch,
});

const result = (patch: Partial<RequestResult> = {}): RequestResult => ({
  requestId: 'r1',
  name: 'r',
  path: [],
  method: 'POST',
  url: 'https://api.test/x',
  status: 200,
  durationMs: 1,
  sizeBytes: 1,
  passed: true,
  assertions: [],
  ...patch,
});

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
          fields: [
            { name: 'ping', args: [], type: { kind: 'SCALAR', name: 'String', ofType: null } },
          ],
        },
        { kind: 'SCALAR', name: 'String' },
      ],
    },
  },
};

describe('GraphQL query tab', () => {
  it('opens a root type from the docs, and ignores a refresh once the actions are gone', async () => {
    schemaCache.clear();
    const runAdHoc = vi.fn(() =>
      Promise.resolve(result({ response: { headers: {}, bodyPreview: JSON.stringify(SCHEMA) } })),
    );
    const actions: RequestActions = {
      runAdHoc,
      listGrpcServices: () => Promise.reject(new Error('no')),
    };
    const props = { request: request('graphql'), readOnly: false, onChange: vi.fn() };
    const view = render(<RequestPane {...props} actions={actions} />);
    fireEvent.click(screen.getByTestId('graphql-schema'));
    const docs = await screen.findByTestId('graphql-docs');
    fireEvent.click(within(docs).getAllByRole('button', { name: 'Query' })[0]!);
    expect(within(screen.getByTestId('graphql-docs')).getByText('ping')).toBeTruthy();

    view.rerender(<RequestPane {...props} />);
    runAdHoc.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Recarregar schema' }));
    expect(runAdHoc).not.toHaveBeenCalled();
    schemaCache.clear();
  });

  it('shows the editors of a GraphQL request that has no query spec yet', () => {
    render(
      <RequestPane
        request={{ ...request('graphql'), graphql: undefined }}
        readOnly={false}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByLabelText<HTMLTextAreaElement>('Query').value).toBe('');
    fireEvent.click(screen.getByRole('tab', { name: /Variáveis/ }));
    expect(screen.getByLabelText<HTMLTextAreaElement>('Variáveis').value).toBe('');
  });
});

/** The URL bar of a gRPC request, which holds the method picker. */
function bar(
  patch: Partial<ApiRequestSpec>,
  props: { actions?: RequestActions; apiCollection?: ApiCollection; onChange?: () => void } = {},
) {
  return render(
    <UrlBar
      request={request('grpc', patch)}
      collection={props.apiCollection ?? collection()}
      readOnly={false}
      dirty={false}
      sending={false}
      actions={props.actions}
      onChange={props.onChange ?? vi.fn()}
      onSend={vi.fn()}
      onCancel={vi.fn()}
      onSave={vi.fn()}
    />,
  );
}

describe('gRPC method picker', () => {
  it('does nothing on focus without the workbench actions', () => {
    bar({});
    fireEvent.focus(screen.getByTestId('grpc-method-select'));
    expect(screen.queryByText('Carregando métodos…')).toBeNull();
  });

  it('words a failure that is not an Error', async () => {
    grpcServicesCache.clear();
    bar(
      {},
      {
        actions: {
          runAdHoc: () => Promise.reject(new Error('no')),
          listGrpcServices: () => Promise.reject('connection refused'),
        },
      },
    );
    fireEvent.focus(screen.getByTestId('grpc-method-select'));
    expect(await screen.findByText(/connection refused/)).toBeTruthy();
    grpcServicesCache.clear();
  });
});

describe('gRPC definition source', () => {
  it('keeps the proto file empty when the unnamed definition is picked', () => {
    const onChange = vi.fn();
    render(
      <RequestPane
        request={request('grpc', { grpc: { method: '', reflection: false, message: '{}' } })}
        collection={collection({ protoFiles: [] })}
        readOnly={false}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId('grpc-source'), { target: { value: 'proto:' } });
    expect(onChange.mock.calls.at(-1)![0].grpc).toEqual({
      method: '',
      reflection: false,
      protoFile: undefined,
      message: '{}',
    });
  });
});

describe('response panes', () => {
  it('shows a body whose response carries no headers', () => {
    const entry: ResponseEntry = {
      runId: 'run-1',
      at: Date.now(),
      result: result({ response: { bodyPreview: '{"ok":true}' } as never }),
      error: null,
    };
    render(<ResponsePane entries={[entry]} target="remote" />);
    expect(screen.getByTestId('response-body')).toBeTruthy();
  });

  it('lists a send that got no status with a dash', () => {
    const entries: ResponseEntry[] = [
      { runId: 'a', at: Date.now(), result: result({ status: null }), error: null },
    ];
    render(<HistoryList entries={entries} />);
    expect(screen.getByTestId('response-history').textContent).toContain('—');
  });
});

describe('response layout and url bar corners', () => {
  it('offers the vertical layout from a horizontal one', () => {
    const entry: ResponseEntry = { runId: 'a', at: Date.now(), result: result(), error: null };
    const { container } = render(
      <ResponsePane
        entries={[entry]}
        target="remote"
        layout="horizontal"
        onToggleLayout={vi.fn()}
      />,
    );
    fireEvent.click(screen.getAllByRole('button').find((b) => b.getAttribute('aria-haspopup'))!);
    expect(container.ownerDocument.querySelector('.ti-layout-rows')).toBeTruthy();
  });

  it('shows Cancel while sending and calls it', () => {
    const onCancel = vi.fn();
    render(
      <UrlBar
        request={request('http')}
        collection={collection()}
        readOnly={false}
        dirty={false}
        sending
        onChange={vi.fn()}
        onSend={vi.fn()}
        onCancel={onCancel}
        onSave={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('cancel-request'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('edits the value of a path param of the URL', () => {
    const onChange = vi.fn();
    render(
      <RequestPane
        request={request('http', { url: '{{baseUrl}}/users/:id' })}
        readOnly={false}
        onChange={onChange}
      />,
    );
    const params = within(screen.getByTestId('path-params'));
    fireEvent.change(params.getAllByRole('textbox')[1]!, { target: { value: '7' } });
    expect(onChange.mock.calls.at(-1)![0].pathParams).toEqual([{ key: 'id', value: '7' }]);
  });
});
